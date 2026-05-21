function renderControlHtml() {
  return `<!doctype html>
<html lang="is">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Eidfaxi Stjórnborð</title>
  <style>
    :root { --bg:#f3f4f6; --panel:#ffffff; --line:#d1d5db; --fg:#111827; --muted:#6b7280; --ok:#047857; --warn:#b45309; --primary:#2563eb; --primaryHover:#1d4ed8; --secondary:#4b5563; --secondaryHover:#374151; --danger:#b91c1c; --dangerHover:#991b1b; }
    * { box-sizing:border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; }
    html, body { width:100%; min-height:100%; }
    body { margin:0; background:var(--bg); color:var(--fg); display:flex; justify-content:center; align-items:flex-start; }
    .wrap { width:min(1200px, 100% - 24px); margin:24px 0; }
    .header { margin-bottom:12px; display:flex; flex-direction:column; gap:8px; }
    .header h1 { margin:0; font-size:28px; text-align:center; }
    .sub { color:var(--muted); font-size:14px; text-align:center; }
    .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:16px; margin-bottom:12px; }
    h2 { margin:0 0 10px; font-size:20px; }
    label { display:block; margin:8px 0 6px; color:var(--muted); font-size:13px; font-weight:600; }
    input,select { width:100%; padding:10px 12px; border-radius:8px; border:1px solid #cbd5e1; background:#fff; color:#111827; font-size:15px; }
    input:focus,select:focus { outline:none; border-color:#93c5fd; box-shadow:0 0 0 3px rgba(147,197,253,.35); }
    .row { display:grid; grid-template-columns:1fr 1fr; gap:10px; align-items:end; }
    .btns { display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; }
    button { border:1px solid transparent; border-radius:8px; padding:11px 12px; cursor:pointer; font-weight:600; font-size:15px; transition: background-color .15s ease; }
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
    .three { display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px; margin-top:10px; }
    .loading { opacity:.72; pointer-events:none; }
    /* Tab styles */
    .tab-bar { display:flex; gap:0; border-bottom:2px solid var(--line); margin-bottom:0; overflow-x:auto; }
    .tab-btn { padding:10px 16px; border:1px solid transparent; border-bottom:none; border-radius:8px 8px 0 0; background:transparent; color:var(--muted); font-size:14px; font-weight:600; cursor:pointer; white-space:nowrap; position:relative; top:2px; }
    .tab-btn:hover { background:#eef2ff; color:var(--primary); }
    .tab-btn.active { background:var(--panel); border-color:var(--line); color:var(--primary); border-bottom:2px solid var(--panel); }
    .tab-btn .tab-close { margin-left:8px; color:var(--muted); font-size:12px; border-radius:50%; padding:2px 5px; }
    .tab-btn .tab-close:hover { background:#fee2e2; color:var(--danger); }
    .tab-content { display:none; }
    .tab-content.active { display:block; }
    .tab-panel { background:var(--panel); border:1px solid var(--line); border-top:none; border-radius:0 0 10px 10px; padding:16px; }
    .empty-tabs { text-align:center; padding:32px 16px; color:var(--muted); font-size:15px; }
    .event-list { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
    .event-tag { background:#eef2ff; border:1px solid #c7d2fe; border-radius:6px; padding:4px 10px; font-size:13px; color:#1e3a8a; font-weight:500; }
    .grid { display:grid; grid-template-columns:1fr; gap:12px; align-items:start; }
    @media (min-width: 980px) {
      .grid { grid-template-columns: 1.3fr 0.85fr; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <h1>Eidfaxi Stjórnborð</h1>
      <div class="sub">Stjórnborð fyrir fjölda móta — bættu við mótum og stjórnaðu hverju móti í sínum flipa.</div>
    </div>

    <!-- GLOBAL SECTION -->
    <div class="card" id="globalSection">
      <h2>Bæta við móti</h2>
      <div class="row">
        <div>
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
        </div>
        <div>
          <label>Veldu mót</label>
          <select id="eventSearchSelect">
            <option value="">Hleð mótum...</option>
          </select>
        </div>
      </div>
      <div class="btns">
        <button class="primary" id="addEventBtn">Bæta við móti</button>
      </div>
      <div style="margin-top:12px">
        <label>Virk mót (<span id="eventCount">0</span>/10)</label>
        <div id="activeEventList" class="event-list">
          <span class="muted">Engin virk mót.</span>
        </div>
      </div>
    </div>

    <!-- TAB BAR -->
    <div id="tabBar" class="tab-bar"></div>

    <!-- TAB CONTENT PANELS -->
    <div id="tabPanels"></div>

    <!-- EMPTY STATE -->
    <div id="emptyState" class="card empty-tabs">
      <p>Engin virk mót. Veldu mót úr listanum hér að ofan og smelltu á „Bæta við móti".</p>
    </div>

    <!-- WEBHOOK LOG (global) -->
    <div class="card" style="margin-top:12px">
      <h2>Nýleg webhook skilaboð</h2>
      <pre id="webhookLog">Hleð webhook log...</pre>
    </div>
  </div>

  <script>
    const MAX_TABS = 10;
    const COMPETITION_TYPE_TO_ID = { 'forkeppni': 1, 'a-urslit': 2, 'b-urslit': 3 };
    let activeEvents = [];
    let activeTabId = null;
    let busy = false;

    function headers() {
      return { 'Content-Type': 'application/json' };
    }

    function getApiBase() {
      return window.location.origin;
    }

    // --- Event Management ---

    async function loadEventSearchOptions() {
      const countrySelect = document.getElementById('countrySelect');
      const eventSearchSelect = document.getElementById('eventSearchSelect');
      const year = new Date().getFullYear();
      const country = countrySelect.value;
      const params = 'ar=' + year + (country ? '&land=' + country : '');
      try {
        const r = await fetch('/events/search?' + params);
        const data = await r.json();
        const events = Array.isArray(data?.tournaments)
          ? data.tournaments
          : Array.isArray(data?.res)
            ? data.res
            : [];
        const normalized = events.map((item) => {
          const eventId = item.numer ?? item.mot_numer ?? item.eventId ?? item.id;
          const name = item.motsheiti ?? item.mot_heiti ?? item.name ?? 'Mót';
          const startsAt = item.byrjunardagsetning ?? item.dagsetning_byrjar ?? item.mot_byrjar ?? '';
          return {
            eventId: Number.parseInt(String(eventId), 10),
            name: String(name || 'Mót'),
            startsAt: String(startsAt || ''),
          };
        }).filter((item) => Number.isInteger(item.eventId) && item.eventId > 0);
        normalized.sort((a, b) => String(b.startsAt).localeCompare(String(a.startsAt)));

        eventSearchSelect.innerHTML = '';
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Veldu mót...';
        eventSearchSelect.appendChild(placeholder);

        normalized.forEach((item) => {
          const option = document.createElement('option');
          option.value = String(item.eventId);
          option.textContent = item.startsAt
            ? item.eventId + ' - ' + item.name + ' (' + item.startsAt + ')'
            : item.eventId + ' - ' + item.name;
          option.dataset.eventName = item.name;
          eventSearchSelect.appendChild(option);
        });
      } catch (e) {
        console.error('Failed to load events:', e);
      }
    }

    async function loadActiveEvents() {
      try {
        const r = await fetch('/events');
        const data = await r.json();
        activeEvents = Array.isArray(data?.events) ? data.events : [];
        renderActiveEventList();
        renderTabs();
      } catch (e) {
        console.error('Failed to load active events:', e);
      }
    }

    function renderActiveEventList() {
      const container = document.getElementById('activeEventList');
      const countEl = document.getElementById('eventCount');
      countEl.textContent = String(activeEvents.length);
      if (activeEvents.length === 0) {
        container.innerHTML = '<span class="muted">Engin virk mót.</span>';
        return;
      }
      container.innerHTML = activeEvents.map((ev) => {
        const label = ev.name ? ev.name + ' (' + ev.eventId + ')' : String(ev.eventId);
        return '<span class="event-tag">' + label + '</span>';
      }).join('');
    }

    async function addEvent() {
      const eventSearchSelect = document.getElementById('eventSearchSelect');
      const eventId = Number.parseInt(String(eventSearchSelect.value || ''), 10);
      if (!Number.isInteger(eventId) || eventId <= 0) {
        alert('Veldu mót úr listanum fyrst.');
        return;
      }
      if (activeEvents.length >= MAX_TABS) {
        alert('Hámark 10 virk mót náð. Fjarlægðu mót til að bæta við nýju.');
        return;
      }
      try {
        const r = await fetch('/events/register', {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ eventId }),
        });
        const data = await r.json();
        if (!r.ok) {
          alert(data?.error || 'Villa við skráningu móts');
          return;
        }
        // Get event name from dropdown
        const selectedOption = eventSearchSelect.options[eventSearchSelect.selectedIndex];
        const eventName = selectedOption?.dataset?.eventName || '';
        const newEvent = { eventId, name: eventName, addedAt: data?.event?.addedAt || new Date().toISOString() };
        if (!activeEvents.some((e) => e.eventId === eventId)) {
          activeEvents.push(newEvent);
        }
        renderActiveEventList();
        renderTabs();
        selectTab(eventId);
      } catch (e) {
        alert('Villa: ' + e.message);
      }
    }

    async function removeEvent(eventId) {
      if (!confirm('Ertu viss um að fjarlægja mót ' + eventId + '?')) return;
      try {
        const r = await fetch('/events/' + eventId, { method: 'DELETE', headers: headers() });
        const data = await r.json();
        if (!r.ok) {
          alert(data?.error || 'Villa við að fjarlægja mót');
          return;
        }
        const idx = activeEvents.findIndex((e) => e.eventId === eventId);
        activeEvents = activeEvents.filter((e) => e.eventId !== eventId);
        renderActiveEventList();

        // Switch to nearest tab (next to the right, or last remaining)
        if (activeTabId === eventId) {
          if (activeEvents.length === 0) {
            activeTabId = null;
          } else {
            const nextIdx = Math.min(idx, activeEvents.length - 1);
            activeTabId = activeEvents[nextIdx].eventId;
          }
        }
        renderTabs();
      } catch (e) {
        alert('Villa: ' + e.message);
      }
    }

    // --- Tab Management ---

    function renderTabs() {
      const tabBar = document.getElementById('tabBar');
      const tabPanels = document.getElementById('tabPanels');
      const emptyState = document.getElementById('emptyState');

      if (activeEvents.length === 0) {
        tabBar.innerHTML = '';
        tabPanels.innerHTML = '';
        emptyState.style.display = 'block';
        return;
      }
      emptyState.style.display = 'none';

      // Render tab buttons
      tabBar.innerHTML = activeEvents.map((ev) => {
        const label = ev.name ? ev.name + ' (' + ev.eventId + ')' : String(ev.eventId);
        const isActive = ev.eventId === activeTabId;
        return '<button class="tab-btn' + (isActive ? ' active' : '') + '" data-event-id="' + ev.eventId + '" onclick="selectTab(' + ev.eventId + ')">'
          + label
          + '<span class="tab-close" onclick="event.stopPropagation(); removeEvent(' + ev.eventId + ')" title="Fjarlægja mót">&times;</span>'
          + '</button>';
      }).join('');

      // Render tab panels (only create if not existing)
      activeEvents.forEach((ev) => {
        let panel = document.getElementById('tab-panel-' + ev.eventId);
        if (!panel) {
          panel = document.createElement('div');
          panel.id = 'tab-panel-' + ev.eventId;
          panel.className = 'tab-content';
          panel.innerHTML = createTabPanelHtml(ev);
          tabPanels.appendChild(panel);
        }
        panel.classList.toggle('active', ev.eventId === activeTabId);
      });

      // Remove panels for events no longer active
      const panelEls = tabPanels.querySelectorAll('.tab-content');
      panelEls.forEach((el) => {
        const id = Number(el.id.replace('tab-panel-', ''));
        if (!activeEvents.some((e) => e.eventId === id)) {
          el.remove();
        }
      });
    }

    function selectTab(eventId) {
      activeTabId = eventId;
      // Update tab button active states
      document.querySelectorAll('.tab-btn').forEach((btn) => {
        btn.classList.toggle('active', Number(btn.dataset.eventId) === eventId);
      });
      // Update panel visibility
      document.querySelectorAll('.tab-content').forEach((panel) => {
        const panelId = Number(panel.id.replace('tab-panel-', ''));
        panel.classList.toggle('active', panelId === eventId);
      });
      // Load state for this event
      loadEventTabState(eventId);
    }

    function createTabPanelHtml(ev) {
      const eventId = ev.eventId;
      const label = ev.name ? ev.name + ' (' + eventId + ')' : String(eventId);
      return '<div class="tab-panel">'
        + '<div class="grid">'
        + '<div>'
        + '<h2>' + label + '</h2>'
        + '<div id="classIdState-' + eventId + '" class="statebox">classId state: hleð...</div>'
        + '<label>ClassId (valfrjálst handvirkt)</label>'
        + '<input id="classIdInput-' + eventId + '" type="number" placeholder="T.d. 203060" />'
        + '<div class="three">'
        + '<button class="primary" onclick="refreshEventCompetition(' + eventId + ', \'forkeppni\')">Uppfæra forkeppni</button>'
        + '<button class="primary" onclick="refreshEventCompetition(' + eventId + ', \'a-urslit\')">Uppfæra a-úrslit</button>'
        + '<button class="primary" onclick="refreshEventCompetition(' + eventId + ', \'b-urslit\')">Uppfæra b-úrslit</button>'
        + '</div>'
        + '<h2 style="margin-top:14px">Niðurstaða</h2>'
        + '<pre id="result-' + eventId + '"></pre>'
        + '</div>'
        + '<div>'
        + '<div class="card" style="margin:0">'
        + '<h2>Flýtileiðir — Mót ' + eventId + '</h2>'
        + '<p class="muted" style="margin-top:0">Sort: bættu við <code>?sort=start</code> eða <code>?sort=rank</code>.</p>'
        + '<div id="endpointButtons-' + eventId + '" class="endpoint-grid"></div>'
        + '</div>'
        + '</div>'
        + '</div>'
        + '</div>';
    }

    // --- Per-Event State Loading ---

    async function loadEventTabState(eventId) {
      try {
        const r = await fetch('/event/' + eventId + '/state');
        if (!r.ok) return;
        const data = await r.json();
        renderEventClassIdState(eventId, data);
        renderEventEndpoints(eventId);
      } catch (e) {
        console.error('Failed to load state for event', eventId, e);
      }
    }

    function renderEventClassIdState(eventId, stateData) {
      const el = document.getElementById('classIdState-' + eventId);
      if (!el) return;
      const competitions = stateData?.competitions || {};
      const types = [
        { id: '1', label: 'forkeppni' },
        { id: '2', label: 'a-úrslit' },
        { id: '3', label: 'b-úrslit' },
      ];
      const rows = types.map((t) => {
        const comp = competitions[t.id];
        const classId = comp?.classId;
        const count = comp?.leaderboardCount ?? 0;
        return { label: t.label, classId, count };
      });
      el.innerHTML = '<div class="title">classId og gögn fyrir mót ' + eventId + '</div>'
        + '<div class="stategrid">'
        + rows.map((row) => {
          const valHtml = row.classId
            ? '<span class="stateval">' + row.classId + ' (' + row.count + ' færslur)</span>'
            : '<span class="stateval missing">ekki sett</span>';
          return '<div class="statekey">' + row.label + '</div><div>' + valHtml + '</div>';
        }).join('')
        + '</div>';
    }

    function renderEventEndpoints(eventId) {
      const container = document.getElementById('endpointButtons-' + eventId);
      if (!container) return;
      const buttons = [];
      ['forkeppni', 'a-urslit', 'b-urslit'].forEach((type) => {
        buttons.push({ label: 'event/' + eventId + '/' + type, path: '/event/' + eventId + '/' + type });
        buttons.push({ label: 'event/' + eventId + '/' + type + '/results', path: '/event/' + eventId + '/' + type + '/results' });
        buttons.push({ label: 'event/' + eventId + '/' + type + '/groups?groupSize=7', path: '/event/' + eventId + '/' + type + '/groups?groupSize=7' });
        buttons.push({ label: 'event/' + eventId + '/' + type + '/csv', path: '/event/' + eventId + '/' + type + '/csv' });
      });
      buttons.push({ label: 'event/' + eventId + '/leaderboards.zip', path: '/event/' + eventId + '/leaderboards.zip' });
      buttons.push({ label: 'event/' + eventId + '/csv.zip', path: '/event/' + eventId + '/csv.zip' });
      buttons.push({ label: 'event/' + eventId + '/state', path: '/event/' + eventId + '/state' });
      buttons.push({ label: 'event/' + eventId + '/tests', path: '/event/' + eventId + '/tests' });

      container.innerHTML = '';
      for (let i = 0; i < buttons.length; i += 2) {
        const row = document.createElement('div');
        row.className = 'endpoint-row';
        for (let j = 0; j < 2; j++) {
          const item = buttons[i + j];
          if (!item) continue;
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'endpoint-btn';
          btn.textContent = item.label;
          btn.addEventListener('click', () => {
            window.open(getApiBase() + item.path, '_blank', 'noopener');
          });
          row.appendChild(btn);
        }
        container.appendChild(row);
      }
    }

    // --- Refresh ---

    async function refreshEventCompetition(eventId, competitionType) {
      const resultEl = document.getElementById('result-' + eventId);
      const classIdInput = document.getElementById('classIdInput-' + eventId);
      const body = {};
      const manualClassId = Number.parseInt(String(classIdInput?.value || ''), 10);
      if (Number.isInteger(manualClassId) && manualClassId > 0) {
        body.classId = manualClassId;
      }
      try {
        if (resultEl) {
          resultEl.className = '';
          resultEl.textContent = 'Uppfæri ' + competitionType + '...';
        }
        const r = await fetch('/event/' + eventId + '/' + competitionType + '/refresh', {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify(body),
        });
        const data = await r.json();
        if (resultEl) {
          resultEl.className = r.ok ? 'ok' : 'warn';
          resultEl.textContent = JSON.stringify(data, null, 2);
        }
        // Reload state after refresh
        loadEventTabState(eventId);
      } catch (e) {
        if (resultEl) {
          resultEl.className = 'warn';
          resultEl.textContent = 'Villa: ' + e.message;
        }
      }
    }

    // --- Webhook Log ---

    async function getWebhookLog() {
      const webhookOut = document.getElementById('webhookLog');
      try {
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
      } catch (e) {
        console.error('Failed to load webhook log:', e);
      }
    }

    // --- Init ---

    async function init() {
      await loadEventSearchOptions();
      await loadActiveEvents();
      await getWebhookLog();
      // Auto-select first tab if any
      if (activeEvents.length > 0 && !activeTabId) {
        selectTab(activeEvents[0].eventId);
      }
    }

    document.getElementById('countrySelect').addEventListener('change', () => {
      loadEventSearchOptions();
    });

    document.getElementById('addEventBtn').addEventListener('click', () => {
      addEvent();
    });

    init().catch((e) => console.error('Init failed:', e));
    setInterval(() => { getWebhookLog().catch(() => {}); }, 5000);
  </script>
</body>
</html>`;
}
