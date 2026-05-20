import {
  getCurrentState,
  getLeaderboardState,
  getCompetitionMetadata,
  getCompetitionSpecificMetadata,
} from './state.js';
import { leaderboardToCsv } from './normalizer.js';
import { apiGetWithRetry } from '../sportfengur.js';
import {
  getEventIdFilter,
  setEventIdFilter,
  SPORTFENGUR_LOCALE,
} from '../config.js';
import { requireControlSession } from '../control-auth.js';
import { refreshCompetitionNow } from './refresh.js';
import { log } from '../logger.js';
import JSZip from 'jszip';

const COMPETITION_TYPE_TO_ID = {
  forkeppni: 1,
  'a-urslit': 2,
  'b-urslit': 3,
};

const COLOR_HEX_BY_RAS_COLOR = {
  '1 - Rauður': '#FF0000',
  '2 - Gulur': '#FFFF00',
  '3 - Grænn': '#008000',
  '4 - Blár': '#0000FF',
  '5 - Hvítur': '#FFFFFF',
  '6 - Svartur': '#000000',
};

function getColorHex(color) {
  return COLOR_HEX_BY_RAS_COLOR[String(color || '').trim()] || '';
}

function withUtf8Bom(text) {
  return `\uFEFF${text}`;
}

function extractGangtegundResults(currentState, sort = 'start') {
  const rowsByGait = new Map();
  const excludeKeys = new Set([
    'Nr',
    'Saeti',
    'Holl',
    'Hond',
    'Knapi',
    'LiturRas',
    'FelagKnapa',
    'Hestur',
    'Litur',
    'Aldur',
    'FelagEiganda',
    'Lid',
    'NafnBIG',
    'E1',
    'E2',
    'E3',
    'E4',
    'E5',
    'E6',
    'adal',
    'timestamp',
  ]);

  currentState.forEach((rider) => {
    for (const [key, value] of Object.entries(rider)) {
      if (excludeKeys.has(key) || typeof value !== 'object') continue;
      const scores = {};
      for (const [scoreKey, scoreValue] of Object.entries(value)) {
        if (scoreKey !== '_title') {
          scores[scoreKey] = scoreValue;
        }
      }
      const row = {
        gangtegundKey: key,
        title: value._title || key,
        name: rider.Knapi,
        horse: rider.Hestur,
        color: rider.LiturRas || '',
        colorHex: getColorHex(rider.LiturRas),
        Nr: rider.Nr,
        Saeti: rider.Saeti,
        pos: '',
        ...scores,
      };
      if (!rowsByGait.has(key)) {
        rowsByGait.set(key, []);
      }
      rowsByGait.get(key).push(row);
    }
  });

  const gaitKeys = [...rowsByGait.keys()].sort((a, b) => a.localeCompare(b));
  const output = [];

  for (const gaitKey of gaitKeys) {
    const rows = rowsByGait.get(gaitKey) || [];
    rows.sort((a, b) => {
      const valueA =
        sort === 'rank'
          ? Number(String(a.E6 || '').replace(',', '.'))
          : Number(String(a.Nr || '').replace(',', '.'));
      const valueB =
        sort === 'rank'
          ? Number(String(b.E6 || '').replace(',', '.'))
          : Number(String(b.Nr || '').replace(',', '.'));
      const hasA = Number.isFinite(valueA);
      const hasB = Number.isFinite(valueB);

      if (hasA && hasB && valueA !== valueB) {
        return sort === 'rank' ? valueB - valueA : valueA - valueB;
      }
      if (hasA !== hasB) return hasA ? -1 : 1;

      const nameA = String(a.name || '');
      const nameB = String(b.name || '');
      return nameA.localeCompare(nameB);
    });

    rows.forEach((row, index) => {
      row.pos = String(index + 1);
      delete row.Nr;
      delete row.Saeti;
      output.push(row);
    });
  }

  return output;
}

function sortLeaderboard(entries, sort) {
  const mode = sort === 'rank' ? 'rank' : sort === 'teams' ? 'teams' : 'start';
  return [...entries].sort((a, b) => {
    if (mode === 'teams') {
      const teamA = String(a?.Lid || '')
        .trim()
        .toLowerCase();
      const teamB = String(b?.Lid || '')
        .trim()
        .toLowerCase();
      if (teamA !== teamB) {
        if (!teamA) return 1;
        if (!teamB) return -1;
        return teamA.localeCompare(teamB);
      }

      const startA = Number(a?.Nr) || 999;
      const startB = Number(b?.Nr) || 999;
      if (startA !== startB) {
        return startA - startB;
      }

      const riderA = String(a?.Knapi || '');
      const riderB = String(b?.Knapi || '');
      return riderA.localeCompare(riderB);
    }

    const valueA = Number(mode === 'rank' ? a.Saeti : a.Nr) || 999;
    const valueB = Number(mode === 'rank' ? b.Saeti : b.Nr) || 999;
    return valueA - valueB;
  });
}

function filterLeaderboardBySearch(entries, search) {
  const term = String(search || '')
    .trim()
    .toLowerCase();
  if (!term) return [...entries];

  return entries.filter((entry) => {
    const haystack = [
      entry?.Lid,
      entry?.Knapi,
      entry?.Hestur,
      entry?.Nr,
      entry?.Saeti,
      entry?.NafnBIG,
      entry?.FelagKnapa,
      entry?.FelagEiganda,
    ]
      .map((value) => String(value || '').toLowerCase())
      .join(' ');

    return haystack.includes(term);
  });
}

function chunkEntries(entries, size) {
  const chunkSize = Number.isInteger(size) && size > 0 ? size : 7;
  const groups = [];
  for (let i = 0; i < entries.length; i += chunkSize) {
    groups.push(entries.slice(i, i + chunkSize));
  }
  return groups;
}

function resolveCompetitionScope(req, res) {
  const competitionType = String(req.params.competitionType || '')
    .trim()
    .toLowerCase();
  const competitionId = COMPETITION_TYPE_TO_ID[competitionType];

  if (!competitionId) {
    res.status(404).json({
      error: 'Unknown competition type',
      competitionType,
      supported: Object.keys(COMPETITION_TYPE_TO_ID),
    });
    return null;
  }

  return { competitionType, competitionId };
}

function resolveCompetitionRequest(req, res, defaultSort = 'start') {
  const scope = resolveCompetitionScope(req, res);
  if (!scope) return null;
  const { competitionType, competitionId } = scope;

  const sort = req.query.sort == null ? defaultSort : String(req.query.sort);
  if (sort !== 'start' && sort !== 'rank' && sort !== 'teams') {
    res.status(400).json({
      error: 'Invalid sort value',
      supported: ['start', 'rank', 'teams'],
    });
    return null;
  }

  const leaderboard = getLeaderboardState(competitionId);
  const sorted = sortLeaderboard(leaderboard, sort);
  const search = req.query.search == null ? '' : String(req.query.search);
  const filtered = filterLeaderboardBySearch(sorted, search);
  return { competitionType, sort, sorted: filtered, competitionId, search };
}

function parsePositiveInt(value) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

async function classBelongsToEventCompetition(eventId, classId, competitionId) {
  const data = await apiGetWithRetry(
    `/${SPORTFENGUR_LOCALE}/event/tests/${eventId}`,
  );
  const tests = Array.isArray(data?.res) ? data.res : [];
  return tests.some(
    (item) =>
      Number(item.flokkar_numer) === Number(classId) &&
      Number(item.keppni_numer) === Number(competitionId),
  );
}

function renderControlHtml() {
  return `<!doctype html>
  <html lang="is">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Eidfaxi Stjorn</title>
  <style>
    :root { --bg:#f3f4f6; --panel:#ffffff; --line:#d1d5db; --fg:#111827; --muted:#6b7280; --ok:#047857; --warn:#b45309; --primary:#2563eb; --primaryHover:#1d4ed8; --secondary:#4b5563; --secondaryHover:#374151; --danger:#b91c1c; --dangerHover:#991b1b; }
    * { box-sizing:border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; }
    html, body { width:100%; min-height:100%; }
    body { margin:0; background:var(--bg); color:var(--fg); display:flex; justify-content:center; align-items:flex-start; }
    .wrap { width:min(1200px, 100% - 24px); margin:24px 0; }
    .header { margin-bottom:12px; display:flex; flex-direction:column; gap:8px; }
    .header h1 { margin:0; font-size:28px; text-align:center; }
    .sub { color:var(--muted); font-size:14px; text-align:center; }
    .status { background:#eef2ff; color:#1e3a8a; border:1px solid #c7d2fe; border-radius:8px; padding:8px 10px; font-size:14px; align-self:center; }
    .grid { display:grid; grid-template-columns:1fr; gap:12px; align-items:start; }
    @media (min-width: 980px) {
      .grid { grid-template-columns: 1.3fr 0.85fr; }
    }
    .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:16px; }
    h2 { margin:0 0 10px; font-size:20px; }
    label { display:block; margin:8px 0 6px; color:var(--muted); font-size:13px; font-weight:600; }
    input,select { width:100%; padding:10px 12px; border-radius:8px; border:1px solid #cbd5e1; background:#fff; color:#111827; font-size:15px; }
    input:focus,select:focus { outline:none; border-color:#93c5fd; box-shadow:0 0 0 3px rgba(147,197,253,.35); }
    .row { display:grid; grid-template-columns:1fr; gap:10px; }
    .btns { display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; }
    button { border:1px solid transparent; border-radius:8px; padding:11px 12px; cursor:pointer; font-weight:600; font-size:15px; width:100%; transition: background-color .15s ease; }
    button:disabled { opacity:.5; cursor:not-allowed; }
    .primary { background:var(--primary); color:#fff; border-color:#1e40af; }
    .secondary { background:var(--secondary); color:#fff; border-color:#374151; }
    .danger { background:var(--danger); color:#fff; border-color:#991b1b; }
    .primary:hover:not(:disabled) { background:var(--primaryHover); }
    .secondary:hover:not(:disabled) { background:var(--secondaryHover); }
    .danger:hover:not(:disabled) { background:var(--dangerHover); }
    .primary:focus-visible,.secondary:focus-visible,.danger:focus-visible,input:focus-visible,select:focus-visible { outline:2px solid #93c5fd; outline-offset:1px; }
    .muted { color:var(--muted); font-size:14px; margin:10px 0 0; }
    .statebox { margin-top:10px; padding:10px 12px; border:1px solid #d1d5db; border-radius:8px; background:#f9fafb; color:#111827; font-size:13px; line-height:1.45; }
    .statebox .title { font-weight:700; margin-bottom:8px; }
    .stategrid { display:grid; grid-template-columns:1fr auto; gap:6px 12px; align-items:center; }
    .statekey { font-weight:600; }
    .stateval { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace; }
    .stateval.missing { color:#6b7280; }
    .endpoint-grid { margin-top:2px; display:grid; grid-template-columns:1fr; gap:8px; }
    .endpoint-row { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    .endpoint-btn { border:1px solid #cbd5e1; background:#f8fafc; color:#0f172a; border-radius:8px; padding:8px 10px; font-size:12px; font-weight:600; text-align:left; cursor:pointer; width:100%; }
    .endpoint-btn:hover { background:#eef2ff; border-color:#93c5fd; }
    .endpoint-btn:disabled { opacity:.5; cursor:not-allowed; }
    pre { margin:0; white-space:pre-wrap; background:#111827; color:#e5e7eb; border:1px solid #374151; border-radius:8px; padding:12px; min-height:120px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace; font-size:13px; }
    #webhookLog { min-height:120px; max-height:220px; overflow:auto; }
    .ok { color:var(--ok); }
    .warn { color:var(--warn); }
    .three { display:grid; grid-template-columns:1fr; gap:10px; margin-top:10px; }
    .btns button { width:auto; flex:1 1 180px; }
    .loading { opacity:.72; pointer-events:none; }
  </style>
</head>
  <body>
  <div class="wrap">
    <div class="header">
      <div>
        <h1>Eidfaxi Stjornborð</h1>
        <div class="sub">Veldu virkt mot og keyrðu handvirka uppfærslu úr Sportfengur fyrir vMix grafík.</div>
      </div>
    </div>
    <div class="grid">
    <div class="card">
      <h2>Handvirk uppfærsla</h2>
      <div id="filterStatus" class="status">Motasía: hleð...</div>
      <label>Land</label>
      <select id="countrySelect">
        <option value="IS" selected>Ísland</option>
        <option value="SE">Svíþjóð</option>
        <option value="DK">Danmörk</option>
        <option value="NO">Noregur</option>
        <option value="FI">Finnland</option>
        <option value="DE">Þýskaland</option>
        <option value="NL">Holland</option>
        <option value="GB">Bretland</option>
        <option value="US">Bandaríkin</option>
        <option value="">Öll lönd</option>
      </select>
      <label>Veldu mot</label>
      <select id="eventSelect">
        <option value="">Hleð motum...</option>
      </select>
      <label>ClassId úr Sportfengur (valfrjálst)</label>
      <select id="classIdSelect">
        <option value="">Sjálfvirkt val per keppni</option>
      </select>
      <label>Flokksnúmer (classId) - valfrjálst</label>
      <input id="classIdInput" type="number" placeholder="T.d. 203060" />
      <div class="btns">
        <button class="secondary" onclick="setEventFilter()">Vista mot</button>
        <button class="danger" onclick="clearEventFilter()">Hreinsa mot</button>
      </div>
      <div class="three">
        <button id="btn-forkeppni" data-refresh-btn data-competition-type="forkeppni" class="primary" onclick="refreshCompetition('forkeppni')">Uppfæra forkeppni</button>
        <button id="btn-a-urslit" data-refresh-btn data-competition-type="a-urslit" class="primary" onclick="refreshCompetition('a-urslit')">Uppfæra a-urslit</button>
        <button id="btn-b-urslit" data-refresh-btn data-competition-type="b-urslit" class="primary" onclick="refreshCompetition('b-urslit')">Uppfæra b-urslit</button>
      </div>
      <div id="classIdState" class="statebox">classId state: hleð...</div>
      <p class="muted">Veldu mot. Ef classId vantar í state geturðu sett það handvirkt hér.</p>
      <h2 style="margin-top:14px">Niðurstaða</h2>
      <pre id="result"></pre>
      <h2 style="margin-top:14px">Nýleg webhook skilaboð</h2>
      <pre id="webhookLog">Hleð webhook log...</pre>
    </div>
    <div class="card shortcuts-card">
      <h2>Flýtileiðir í API</h2>
      <p class="muted" style="margin-top:0">Sort: bættu við <code>?sort=start</code> eða <code>?sort=rank</code> eftir þörfum.</p>
      <div id="endpointButtons" class="endpoint-grid"></div>
    </div>
    </div>
  </div>
  <script>
    const out = document.getElementById('result');
    const webhookOut = document.getElementById('webhookLog');
    const filterStatus = document.getElementById('filterStatus');
    const classIdState = document.getElementById('classIdState');
    const endpointButtons = document.getElementById('endpointButtons');
    const eventSelect = document.getElementById('eventSelect');
    const countrySelect = document.getElementById('countrySelect');
    const classIdSelect = document.getElementById('classIdSelect');
    const classIdInput = document.getElementById('classIdInput');
    const card = document.querySelector('.card');
    const refreshButtons = Array.from(document.querySelectorAll('[data-refresh-btn]'));
    const actionButtons = Array.from(document.querySelectorAll('button'));
    const COMPETITION_TYPE_TO_ID = { 'forkeppni': 1, 'a-urslit': 2, 'b-urslit': 3 };
    let eventState = null;
    let classIdFromTests = {};
    let currentFilterValue = null;
    let busy = false;
    function headers() {
      return { 'Content-Type': 'application/json' };
    }
    function show(obj, ok = true) {
      out.className = ok ? 'ok' : 'warn';
      out.textContent = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
    }
    function setBusy(value) {
      busy = value;
      card.classList.toggle('loading', value);
      actionButtons.forEach((b) => {
        b.disabled = value;
      });
      if (!value) {
        syncRefreshButtons();
      }
      renderEndpointButtons();
    }
    function setFilterStatus(val) {
      currentFilterValue = val ? Number(val) : null;
      filterStatus.textContent = val ? 'Motasía: ' + val : 'Motasía: engin';
    }
    function getApiBase() {
      return window.location.origin;
    }
    function renderEndpointButtons() {
      const eventId = getSelectedEventId() || currentFilterValue;
      const buttons = [];

      ['forkeppni', 'b-urslit', 'a-urslit'].forEach((type) => {
        buttons.push({ label: 'event/' + type, path: '/event/' + type, needsEvent: false });
        buttons.push({ label: 'event/' + type + '/results', path: '/event/' + type + '/results', needsEvent: false });
        buttons.push({ label: 'event/' + type + '/groups?groupSize=7', path: '/event/' + type + '/groups?groupSize=7', needsEvent: false });
        buttons.push({ label: 'event/' + type + '/group?groupSize=7&group=1', path: '/event/' + type + '/group?groupSize=7&group=1', needsEvent: false });
        buttons.push({ label: 'event/' + type + '/groups/flat?groupSize=7', path: '/event/' + type + '/groups/flat?groupSize=7', needsEvent: false });
        buttons.push({ label: 'event/' + type + '/csv', path: '/event/' + type + '/csv', needsEvent: false });
      });

      if (eventId) {
        buttons.push({ label: 'event/' + eventId + '/tests', path: '/event/' + eventId + '/tests', needsEvent: true });
        buttons.push({ label: 'event/' + eventId + '/participants', path: '/event/' + eventId + '/participants', needsEvent: true });
      } else {
        buttons.push({ label: 'event/{eventId}/tests', path: '', needsEvent: true });
        buttons.push({ label: 'event/{eventId}/participants', path: '', needsEvent: true });
      }

      buttons.push({ label: 'event/current', path: '/event/current', needsEvent: false });
      buttons.push({ label: 'event/leaderboards.zip', path: '/event/leaderboards.zip', needsEvent: false });
      buttons.push({ label: 'event/csv.zip', path: '/event/csv.zip', needsEvent: false });
      buttons.push({ label: 'events/search (ár)', path: '/events/search?ar=' + new Date().getFullYear() + '&land=' + (countrySelect.value || ''), needsEvent: false });

      endpointButtons.innerHTML = '';
      for (let i = 0; i < buttons.length; i += 2) {
        const row = document.createElement('div');
        row.className = 'endpoint-row';
        for (let j = 0; j < 2; j += 1) {
          const item = buttons[i + j];
          if (!item) continue;
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'endpoint-btn';
          btn.textContent = item.label;
          const disabled = busy || (item.needsEvent && !eventId);
          btn.disabled = disabled;
          btn.addEventListener('click', () => {
            if (!item.path) return;
            const url = getApiBase() + item.path;
            window.open(url, '_blank', 'noopener');
          });
          row.appendChild(btn);
        }
        endpointButtons.appendChild(row);
      }
    }
    function getSelectedEventId() {
      const raw = String(eventSelect.value || '').trim();
      if (!raw) return null;
      const parsed = Number.parseInt(raw, 10);
      return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    }
    function upsertSelectedEventOption(eventId) {
      if (!eventId) return;
      const value = String(eventId);
      const existing = Array.from(eventSelect.options).find((o) => o.value === value);
      if (existing) {
        eventSelect.value = value;
        return;
      }
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value + ' - Valið mot';
      eventSelect.prepend(option);
      eventSelect.value = value;
    }
    async function loadEventOptions() {
      const year = new Date().getFullYear();
      const country = countrySelect.value;
      const params = 'ar=' + year + (country ? '&land=' + country : '');
      const r = await fetch('/events/search?' + params);
      const data = await r.json();
      const events = Array.isArray(data?.tournaments)
        ? data.tournaments
        : Array.isArray(data?.res)
          ? data.res
          : [];
      if (!r.ok) {
        throw new Error(data?.message || data?.error || 'Failed to load events');
      }
      const normalized = events.map((item) => {
        const eventId = item.numer ?? item.mot_numer ?? item.eventId ?? item.id;
        const name = item.motsheiti ?? item.mot_heiti ?? item.name ?? 'Mot';
        const startsAt =
          item.byrjunardagsetning ??
          item.dagsetning_byrjar ??
          item.mot_byrjar ??
          '';
        return {
          eventId: Number.parseInt(String(eventId), 10),
          name: String(name || 'Mot'),
          startsAt: String(startsAt || ''),
        };
      }).filter((item) => Number.isInteger(item.eventId) && item.eventId > 0);
      normalized.sort((a, b) => String(b.startsAt).localeCompare(String(a.startsAt)));

      eventSelect.innerHTML = '';
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Veldu mot...';
      eventSelect.appendChild(placeholder);

      normalized.forEach((item) => {
        const option = document.createElement('option');
        option.value = String(item.eventId);
        option.textContent = item.startsAt
          ? item.eventId + ' - ' + item.name + ' (' + item.startsAt + ')'
          : item.eventId + ' - ' + item.name;
        eventSelect.appendChild(option);
      });

      const selected = currentFilterValue || getSelectedEventId();
      if (selected) {
        upsertSelectedEventOption(selected);
      }
      renderEndpointButtons();
    }
    function hasStateContext() {
      if (!eventState) return false;
      const selectedEventId = getSelectedEventId() || currentFilterValue;
      if (!selectedEventId) return false;
      if (
        Number(eventState?.current?.eventId) === Number(selectedEventId) &&
        eventState?.current?.classId
      ) {
        return true;
      }
      const comps = eventState?.competitions || {};
      return Object.values(comps).some(
        (c) =>
          c &&
          Number(c.eventId) === Number(selectedEventId) &&
          c.classId,
      );
    }
    function getStateClassIdForCompetition(competitionType) {
      const selectedEventId = getSelectedEventId() || currentFilterValue;
      if (!selectedEventId || !eventState) return null;
      const competitionId = COMPETITION_TYPE_TO_ID[competitionType];
      const entry = eventState?.competitions?.[competitionId];
      if (entry && Number(entry.eventId) === Number(selectedEventId) && entry.classId) {
        return Number(entry.classId);
      }
      return null;
    }
    function getResolvedClassIdForCompetition(competitionType) {
      const manual = Number.parseInt(String(classIdInput.value || '').trim(), 10);
      if (Number.isInteger(manual) && manual > 0) return manual;
      const selectedClassId = String(classIdSelect.value || '').trim();
      if (selectedClassId) {
        const [selectedType, selectedValue] = selectedClassId.split(':');
        const parsedSelected = Number.parseInt(String(selectedValue || ''), 10);
        if (
          selectedType === competitionType &&
          Number.isInteger(parsedSelected) &&
          parsedSelected > 0
        ) {
          return parsedSelected;
        }
      }
      const fromState = getStateClassIdForCompetition(competitionType);
      if (fromState) return fromState;
      const fromTests = classIdFromTests[competitionType]?.[0]?.classId;
      return Number.isInteger(fromTests) && fromTests > 0 ? fromTests : null;
    }
    function renderClassIdSelect() {
      const previous = String(classIdSelect.value || '');
      classIdSelect.innerHTML = '';
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Sjálfvirkt val per keppni';
      classIdSelect.appendChild(placeholder);

      const orderedTypes = ['forkeppni', 'a-urslit', 'b-urslit'];
      orderedTypes.forEach((competitionType) => {
        const list = Array.isArray(classIdFromTests[competitionType])
          ? classIdFromTests[competitionType]
          : [];
        list.forEach((item) => {
          const option = document.createElement('option');
          option.value = competitionType + ':' + item.classId;
          const suffix = item.flokkurNafn
            ? ' | ' + item.flokkurNafn + (item.keppnisgrein ? ' - ' + item.keppnisgrein : '')
            : '';
          option.textContent = competitionType + ' | ' + item.classId + suffix;
          classIdSelect.appendChild(option);
        });
      });
      if (previous && Array.from(classIdSelect.options).some((o) => o.value === previous)) {
        classIdSelect.value = previous;
      }
    }
    function renderClassIdState() {
      if (!eventState) {
        classIdState.textContent = 'classId state: engin gögn.';
        return;
      }
      const selectedEventId = getSelectedEventId() || currentFilterValue;
      if (!selectedEventId) {
        classIdState.textContent = 'classId state: veldu mot til að sjá classId.';
        return;
      }
      const competitions = [
        { id: 1, label: 'forkeppni' },
        { id: 2, label: 'a-urslit' },
        { id: 3, label: 'b-urslit' },
      ];
      const rows = competitions.map((item) => {
        const fromState = getStateClassIdForCompetition(item.label);
        const fromTests = classIdFromTests[item.label]?.[0]?.classId;
        if (fromState) {
          return { label: item.label, value: String(fromState), source: 'state' };
        }
        if (Number.isInteger(fromTests) && fromTests > 0) {
          return {
            label: item.label,
            value: String(fromTests),
            source: 'sportfengur',
          };
        }
        return { label: item.label, value: null, source: null };
      });
      classIdState.innerHTML =
        '<div class="title">classId í state fyrir mót ' + selectedEventId + '</div>' +
        '<div class="stategrid">' +
        rows.map((row) => {
          const valueHtml = row.value
            ? '<span class="stateval">' + row.value + (row.source ? ' (' + row.source + ')' : '') + '</span>'
            : '<span class="stateval missing">ekki til</span>';
          return '<div class="statekey">' + row.label + '</div><div>' + valueHtml + '</div>';
        }).join('') +
        '</div>';
    }
    function hasManualContext() {
      const selectedEventId = getSelectedEventId() || currentFilterValue;
      if (!selectedEventId) return false;
      const classId = Number.parseInt(String(classIdInput.value || '').trim(), 10);
      return Number.isInteger(classId) && classId > 0;
    }
    function syncRefreshButtons() {
      refreshButtons.forEach((btn) => {
        const competitionType = btn.dataset.competitionType || '';
        const hasCompetitionClassId =
          getResolvedClassIdForCompetition(competitionType) != null;
        btn.disabled = !hasCompetitionClassId || busy;
      });
    }
    async function loadClassIdsFromTests() {
      const selectedEventId = getSelectedEventId() || currentFilterValue;
      classIdFromTests = {
        forkeppni: [],
        'a-urslit': [],
        'b-urslit': [],
      };
      if (!selectedEventId) {
        renderClassIdSelect();
        renderClassIdState();
        syncRefreshButtons();
        return;
      }
      const r = await fetch('/event/' + selectedEventId + '/tests');
      const data = await r.json();
      if (!r.ok) {
        renderClassIdState();
        syncRefreshButtons();
        return;
      }
      const tests = Array.isArray(data?.res) ? data.res : [];
      for (const test of tests) {
        const compId = Number.parseInt(String(test?.keppni_numer), 10);
        const classId = Number.parseInt(String(test?.flokkar_numer), 10);
        if (!Number.isInteger(compId) || !Number.isInteger(classId) || classId <= 0) {
          continue;
        }
        const type = Object.keys(COMPETITION_TYPE_TO_ID).find(
          (key) => COMPETITION_TYPE_TO_ID[key] === compId,
        );
        if (!type) continue;
        const exists = classIdFromTests[type].some((item) => item.classId === classId);
        if (!exists) {
          classIdFromTests[type].push({
            classId,
            flokkurNafn: String(test?.flokkur_nafn || '').trim(),
            keppnisgrein: String(test?.keppnisgrein || '').trim(),
          });
        }
      }
      renderClassIdSelect();
      renderClassIdState();
      syncRefreshButtons();
    }
    async function getEventState() {
      const r = await fetch('/event/state');
      eventState = await r.json();
      renderClassIdState();
      syncRefreshButtons();
    }
    async function getWebhookLog() {
      const r = await fetch('/control/webhooks');
      const data = await r.json();
      if (!r.ok) {
        webhookOut.textContent = JSON.stringify(data, null, 2);
        return;
      }
      const items = Array.isArray(data?.items) ? data.items.slice(0, 20) : [];
      if (items.length === 0) {
        webhookOut.textContent = 'Engin webhook skilaboð ennþá.';
        return;
      }
      webhookOut.textContent = items.map((item) => {
        const at = item.at || '';
        const status = item.status || '';
        const eventName = item.eventName || '';
        const eventId = item.eventId ?? '';
        const classId = item.classId ?? '';
        const competitionId = item.competitionId ?? '';
        return at + ' | ' + status + ' | ' + eventName + ' | eventId=' + eventId + ' classId=' + classId + ' competitionId=' + competitionId;
      }).join('\\n');
    }
    async function getEventFilter() {
      setBusy(true);
      try {
        const r = await fetch('/config/event-filter');
        const data = await r.json();
        setFilterStatus(data?.eventIdFilter);
        upsertSelectedEventOption(data?.eventIdFilter);
        show(data, r.ok);
        await loadEventOptions();
        await getEventState();
        await loadClassIdsFromTests();
        await getWebhookLog();
      } finally {
        setBusy(false);
      }
    }
    async function setEventFilter() {
      setBusy(true);
      try {
        const eventId = getSelectedEventId();
        if (!eventId) {
          show('Veldu mot fyrst.', false);
          return;
        }
        const r = await fetch('/config/event-filter', { method:'POST', headers: headers(), body: JSON.stringify({ eventIdFilter: eventId }) });
        const data = await r.json();
        setFilterStatus(data?.eventIdFilter);
        upsertSelectedEventOption(data?.eventIdFilter);
        show(data, r.ok);
        await getEventState();
        await loadClassIdsFromTests();
        await getWebhookLog();
      } finally {
        setBusy(false);
      }
    }
    async function clearEventFilter() {
      setBusy(true);
      try {
        const r = await fetch('/config/event-filter', { method:'POST', headers: headers(), body: JSON.stringify({ eventIdFilter: null }) });
        const data = await r.json();
        setFilterStatus(data?.eventIdFilter);
        eventSelect.value = '';
        classIdFromTests = {
          forkeppni: [],
          'a-urslit': [],
          'b-urslit': [],
        };
        renderClassIdSelect();
        show(data, r.ok);
        await getEventState();
        renderClassIdState();
        await getWebhookLog();
      } finally {
        setBusy(false);
      }
    }
    async function refreshCompetition(competitionType) {
      setBusy(true);
      try {
        const eventId = getSelectedEventId();
        const body = {};
        if (eventId) body.eventId = eventId;
        const classId = getResolvedClassIdForCompetition(competitionType);
        if (classId) {
          body.classId = classId;
        }
        const r = await fetch('/event/' + competitionType + '/refresh', {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify(body),
        });
        const data = await r.json();
        if (!r.ok && data?.error === 'Missing classId (and no classId found in state)') {
          show('Vantar classId i state fyrir valið mot/keppni. Biddu eftir webhook eða keyrdu raslista webhook fyrst.', false);
          return;
        }
        show(data, r.ok);
        await getEventState();
        await getWebhookLog();
      } finally {
        setBusy(false);
      }
    }
    eventSelect.addEventListener('change', syncRefreshButtons);
    eventSelect.addEventListener('change', renderClassIdState);
    eventSelect.addEventListener('change', renderEndpointButtons);
    eventSelect.addEventListener('change', () => {
      loadClassIdsFromTests().catch(() => {
        classIdFromTests = {
          forkeppni: [],
          'a-urslit': [],
          'b-urslit': [],
        };
        renderClassIdSelect();
        renderClassIdState();
        syncRefreshButtons();
      });
    });
    countrySelect.addEventListener('change', () => {
      loadEventOptions().catch((e) => show(String(e), false));
    });
    classIdInput.addEventListener('input', syncRefreshButtons);
    classIdSelect.addEventListener('change', syncRefreshButtons);
    renderEndpointButtons();
    syncRefreshButtons();
    getEventFilter().catch((e) => show(String(e), false));
    setInterval(() => {
      getWebhookLog().catch(() => {});
    }, 5000);
  </script>
</body>
</html>`;
}

export function registerVmixRoutes(app) {
  app.get('/control', (req, res) => {
    if (!requireControlSession(req, res, false)) return;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderControlHtml());
  });

  app.get('/event/current', (req, res) => {
    const currentState = getCurrentState();
    const search = req.query.search == null ? '' : String(req.query.search);
    const filtered = filterLeaderboardBySearch(currentState, search);
    log.server.endpoint('/event/current', currentState.length);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    res.json(filtered);
  });

  app.get('/event/state', (req, res) => {
    if (!requireControlSession(req, res, true)) return;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    res.json({
      current: getCompetitionMetadata(),
      competitions: {
        1: getCompetitionSpecificMetadata(1),
        2: getCompetitionSpecificMetadata(2),
        3: getCompetitionSpecificMetadata(3),
      },
    });
  });

  const sendLeaderboardsZip = async (req, res) => {
    const metadata = getCompetitionMetadata();
    const effectiveEventId =
      metadata.eventId ?? getEventIdFilter() ?? 'unknown';
    const zip = new JSZip();
    const currentState = getCurrentState();
    zip.file(
      `current-${effectiveEventId}.csv`,
      withUtf8Bom(leaderboardToCsv(currentState)),
    );

    for (const [competitionType, competitionId] of Object.entries(
      COMPETITION_TYPE_TO_ID,
    )) {
      const competitionState = getLeaderboardState(competitionId);
      const startRows = sortLeaderboard(competitionState, 'start');
      const rankRows = sortLeaderboard(competitionState, 'rank');
      zip.file(
        `${competitionType}-${effectiveEventId}-start.csv`,
        withUtf8Bom(leaderboardToCsv(startRows)),
      );
      zip.file(
        `${competitionType}-${effectiveEventId}-rank.csv`,
        withUtf8Bom(leaderboardToCsv(rankRows)),
      );
    }

    const archive = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="leaderboards-${effectiveEventId}.zip"`,
    );
    res.send(archive);
  };

  app.get('/event/leaderboards.zip', sendLeaderboardsZip);
  app.get('/event/csv.zip', sendLeaderboardsZip);

  app.get('/event/:competitionType', (req, res) => {
    const resolved = resolveCompetitionRequest(req, res);
    if (!resolved) return;
    const { competitionType, sort, sorted } = resolved;
    log.server.endpoint(
      `/event/${competitionType}?sort=${sort}`,
      sorted.length,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    res.json(sorted);
  });

  app.get('/event/:competitionType/groups', (req, res) => {
    const resolved = resolveCompetitionRequest(req, res);
    if (!resolved) return;
    const { competitionType, sort, sorted } = resolved;
    const groupSize =
      req.query.groupSize == null
        ? 7
        : Number.parseInt(req.query.groupSize, 10);
    if (!Number.isInteger(groupSize) || groupSize <= 0 || groupSize > 50) {
      return res
        .status(400)
        .json({ error: 'Invalid groupSize value', supported: '1-50' });
    }
    const vmixRows = sorted.map((entry) => ({
      name: entry.Knapi || '',
      horse: entry.Hestur || '',
      Lid: entry.Lid || '',
      Nr: entry.Nr || '',
      saeti: entry.Saeti || '',
      einkunn: entry.E6 || '',
    }));
    const groups = chunkEntries(vmixRows, groupSize);
    log.server.endpoint(
      `/event/${competitionType}/groups?sort=${sort}&groupSize=${groupSize}`,
      sorted.length,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    res.json(groups);
  });

  app.get('/event/:competitionType/group', (req, res) => {
    const resolved = resolveCompetitionRequest(req, res);
    if (!resolved) return;
    const { competitionType, sort, sorted } = resolved;
    const groupSize =
      req.query.groupSize == null
        ? 7
        : Number.parseInt(req.query.groupSize, 10);
    if (!Number.isInteger(groupSize) || groupSize <= 0 || groupSize > 50) {
      return res
        .status(400)
        .json({ error: 'Invalid groupSize value', supported: '1-50' });
    }
    const group =
      req.query.group == null ? 1 : Number.parseInt(req.query.group, 10);
    if (!Number.isInteger(group) || group <= 0) {
      return res
        .status(400)
        .json({ error: 'Invalid group value', supported: '>= 1' });
    }
    const vmixRows = sorted.map((entry) => ({
      name: entry.Knapi || '',
      horse: entry.Hestur || '',
      Lid: entry.Lid || '',
      Nr: entry.Nr || '',
      saeti: entry.Saeti || '',
      einkunn: entry.E6 || '',
    }));
    const selectedGroup = chunkEntries(vmixRows, groupSize)[group - 1] || [];
    log.server.endpoint(
      `/event/${competitionType}/group?sort=${sort}&groupSize=${groupSize}&group=${group}`,
      selectedGroup.length,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    res.json(selectedGroup);
  });

  app.get('/event/:competitionType/groups/flat', (req, res) => {
    const resolved = resolveCompetitionRequest(req, res);
    if (!resolved) return;
    const { competitionType, sort, sorted } = resolved;
    const groupSize =
      req.query.groupSize == null
        ? 7
        : Number.parseInt(req.query.groupSize, 10);
    if (!Number.isInteger(groupSize) || groupSize <= 0 || groupSize > 50) {
      return res
        .status(400)
        .json({ error: 'Invalid groupSize value', supported: '1-50' });
    }
    const vmixRows = sorted.map((entry) => ({
      name: entry.Knapi || '',
      horse: entry.Hestur || '',
      Lid: entry.Lid || '',
      Nr: entry.Nr || '',
      saeti: entry.Saeti || '',
      einkunn: entry.E6 || '',
    }));
    const grouped = chunkEntries(vmixRows, groupSize);
    const flattened = grouped.map((groupRows, groupIndex) => {
      const row = { group: groupIndex + 1 };
      for (let i = 0; i < groupSize; i += 1) {
        const contestant = groupRows[i];
        const n = i + 1;
        row[`name${n}`] = contestant?.name || '';
        row[`horse${n}`] = contestant?.horse || '';
        row[`Lid${n}`] = contestant?.Lid || '';
        row[`Nr${n}`] = contestant?.Nr || '';
        row[`saeti${n}`] = contestant?.saeti || '';
        row[`einkunn${n}`] = contestant?.einkunn || '';
      }
      return row;
    });
    log.server.endpoint(
      `/event/${competitionType}/groups/flat?sort=${sort}&groupSize=${groupSize}`,
      flattened.length,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    res.json(flattened);
  });

  app.get('/event/:competitionType/csv', (req, res) => {
    const resolved = resolveCompetitionRequest(req, res);
    if (!resolved) return;
    const { competitionType, sort, sorted, competitionId } = resolved;
    const metadata = getCompetitionSpecificMetadata(competitionId);
    const effectiveEventId =
      metadata.eventId ?? getEventIdFilter() ?? 'unknown';
    const csv = withUtf8Bom(leaderboardToCsv(sorted));
    log.server.endpoint(
      `/event/${competitionType}/csv?sort=${sort}`,
      sorted.length,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${competitionType}-${effectiveEventId}-${sort}.csv"`,
    );
    res.send(csv);
  });

  app.get('/event/:competitionType/results', (req, res) => {
    const resolved = resolveCompetitionRequest(req, res, 'start');
    if (!resolved) return;
    const { competitionType, sort, sorted } = resolved;
    const results = extractGangtegundResults(sorted, sort);
    log.server.endpoint(
      `/event/${competitionType}/results?sort=${sort}`,
      results.length,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    res.json(results);
  });

  app.post('/event/:competitionType/refresh', async (req, res) => {
    if (!requireControlSession(req, res, true)) return;
    const competitionType = String(req.params.competitionType || '')
      .trim()
      .toLowerCase();
    const competitionId = COMPETITION_TYPE_TO_ID[competitionType];
    if (!competitionId) {
      return res.status(404).json({
        error: 'Unknown competition type',
        competitionType,
        supported: Object.keys(COMPETITION_TYPE_TO_ID),
      });
    }
    const metadata = getCompetitionSpecificMetadata(competitionId);
    const bodyEventId =
      req.body?.eventId == null ? null : parsePositiveInt(req.body.eventId);
    const eventId = bodyEventId ?? getEventIdFilter() ?? metadata.eventId;
    if (!eventId) {
      return res.status(400).json({
        error: 'Missing eventId (set filter first or pass eventId in body)',
      });
    }

    const bodyClassId =
      req.body?.classId == null ? null : parsePositiveInt(req.body.classId);
    const classId =
      bodyClassId ??
      (Number(metadata.eventId) === Number(eventId) ? metadata.classId : null);
    if (!classId) {
      return res
        .status(400)
        .json({ error: 'Missing classId (and no classId found in state)' });
    }

    try {
      const valid = await classBelongsToEventCompetition(
        eventId,
        classId,
        competitionId,
      );
      if (!valid) {
        return res.status(400).json({
          error: 'Class does not belong to selected event/competition',
          eventId,
          classId,
          competitionType,
        });
      }

      await refreshCompetitionNow(eventId, classId, competitionId, true);
      const total = getLeaderboardState(competitionId).length;
      res.json({
        ok: true,
        eventId,
        classId,
        competitionType,
        competitionId,
        total,
      });
    } catch (error) {
      res.status(error.status || 500).json({
        error: 'Manual refresh failed',
        message: error.message,
      });
    }
  });

  app.get('/event/:eventId/participants', async (req, res) => {
    try {
      const eventId = req.params.eventId;

      if (!eventId || isNaN(eventId)) {
        return res.status(400).json({ error: 'Invalid event ID' });
      }

      const data = await apiGetWithRetry(
        `/${SPORTFENGUR_LOCALE}/participants/${eventId}`,
      );

      res.setHeader('Cache-Control', 'public, max-age=300');
      res.setHeader('Content-Type', 'application/json');
      res.json(data);
    } catch (error) {
      console.error(`[vMix Server] Error fetching participants:`, error);
      res.status(error.status || 500).json({
        error: 'Failed to fetch participants',
        message: error.message,
      });
    }
  });

  app.get('/event/:eventId/tests', async (req, res) => {
    try {
      const eventId = req.params.eventId;

      if (!eventId || isNaN(eventId)) {
        return res.status(400).json({ error: 'Invalid event ID' });
      }

      const data = await apiGetWithRetry(
        `/${SPORTFENGUR_LOCALE}/event/tests/${eventId}`,
      );

      res.setHeader('Cache-Control', 'public, max-age=300');
      res.setHeader('Content-Type', 'application/json');
      res.json(data);
    } catch (error) {
      console.error(`[vMix Server] Error fetching event tests:`, error);
      res.status(error.status || 500).json({
        error: 'Failed to fetch event tests',
        message: error.message,
      });
    }
  });

  app.get('/events/search', async (req, res) => {
    try {
      const queryParams = new URLSearchParams();

      const allowedParams = [
        'numer',
        'motsheiti',
        'motsnumer',
        'stadsetning',
        'felag_audkenni',
        'adildarfelag_numer',
        'land_kodi',
        'ar',
        'dagsetning_byrjar',
        'innanhusmot',
        'motstegund_numer',
        'stormot',
        'world_ranking',
        'skraning_stada',
      ];

      for (const param of allowedParams) {
        const value = req.query[param];
        if (value == null) continue;
        const text = String(value).trim();
        if (!text) continue;
        queryParams.append(param, text);
      }
      if (req.query.land_kodi == null && req.query.land != null) {
        const land = String(req.query.land).trim();
        if (land) {
          queryParams.append('land_kodi', land);
        }
      }

      const queryString = queryParams.toString();
      const path = `/${SPORTFENGUR_LOCALE}/events/search${queryString ? '?' + queryString : ''}`;

      const data = await apiGetWithRetry(path);

      res.setHeader('Cache-Control', 'public, max-age=300');
      res.setHeader('Content-Type', 'application/json');
      res.json(data);
    } catch (error) {
      console.error(`[vMix Server] Error searching events:`, error);
      res.status(error.status || 500).json({
        error: 'Failed to search events',
        message: error.message,
      });
    }
  });

  app.get('/person/find/:kennitala', async (req, res) => {
    try {
      const kennitala = String(req.params.kennitala || '').trim();
      if (!kennitala) {
        return res.status(400).json({ error: 'Invalid kennitala' });
      }

      const data = await apiGetWithRetry(`/person/find/${kennitala}`);

      res.setHeader('Cache-Control', 'public, max-age=300');
      res.setHeader('Content-Type', 'application/json');
      res.json(data);
    } catch (error) {
      console.error(`[vMix Server] Error finding person by kennitala:`, error);
      res.status(error.status || 500).json({
        error: 'Failed to find person',
        message: error.message,
      });
    }
  });

  app.get('/person/:personId/events', async (req, res) => {
    try {
      const personId = Number.parseInt(String(req.params.personId), 10);
      if (!Number.isInteger(personId) || personId <= 0) {
        return res.status(400).json({ error: 'Invalid person ID' });
      }

      const requestedLocale = String(
        req.query.locale || SPORTFENGUR_LOCALE,
      ).toLowerCase();
      const allowedLocales = new Set(['is', 'en', 'fo', 'nb', 'sv']);
      if (!allowedLocales.has(requestedLocale)) {
        return res.status(400).json({
          error: 'Invalid locale',
          supported: ['is', 'en', 'fo', 'nb', 'sv'],
        });
      }

      const data = await apiGetWithRetry(
        `/${requestedLocale}/person/events/${personId}`,
      );

      res.setHeader('Cache-Control', 'public, max-age=300');
      res.setHeader('Content-Type', 'application/json');
      res.json(data);
    } catch (error) {
      console.error(
        `[vMix Server] Error fetching person event history:`,
        error,
      );
      res.status(error.status || 500).json({
        error: 'Failed to fetch person events',
        message: error.message,
      });
    }
  });
}
