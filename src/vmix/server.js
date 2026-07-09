import {
  getCurrentState,
  getLeaderboardState,
  getCompetitionMetadata,
  getCompetitionSpecificMetadata,
  getLeaderboardForEvent,
  getEventState,
  getAllEventsMetadata,
  setEventClassId,
  setEventClassType,
  getEventClassType,
} from './state.js';
import { leaderboardToCsv } from './normalizer.js';
import {
  classifyClassType,
  getClassTypePolicy,
  finalsSeatCount,
} from './class-type.js';
import { apiGetWithRetry } from '../sportfengur.js';
import {
  getEventIdFilter,
  setEventIdFilter,
  SPORTFENGUR_LOCALE,
} from '../config.js';
import {
  requireControlSession,
  requireAdmin,
  canAccessSlot,
  getRequestRole,
} from '../control-auth.js';
import { refreshCompetitionNow, isRefreshInProgress } from './refresh.js';
import {
  registerEvent,
  removeEvent,
  getActiveEvents,
  isEventActive,
  getDefaultEventId,
  resolveEventId,
  getActiveEventsWithSlots,
  updateEventLabel,
  replaceEvent,
  setEventClassIdGate,
  getEventClassIdGate,
  setEventName,
  persistEventSlot,
  getSlotForEventId,
  getSourceEventId,
  addSlotForEvent,
} from './event-registry.js';
import { log } from '../logger.js';
import JSZip from 'jszip';

/**
 * Authorization helper: can the current request manage the slot that the
 * given eventId currently occupies? Admins can manage any slot; slot users
 * only their own.
 */
function canAccessEventSlot(req, eventId) {
  const slot = getSlotForEventId(eventId);
  if (slot === null) return true; // not active yet — let route 404 naturally
  return canAccessSlot(req, slot);
}

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
  // Positions 7–8 are used by the 8-color quality classes (gæðingaflokkar).
  // Both accented and accent-less spellings are keyed defensively.
  '7 - Bleikur': '#FF69B4',
  '8 - Appelsínugulur': '#FFA500',
  '8 - Appelsinugulur': '#FFA500',
};

function getColorHex(color) {
  return COLOR_HEX_BY_RAS_COLOR[String(color || '').trim()] || '';
}

function withUtf8Bom(text) {
  return `\uFEFF${text}`;
}

/**
 * Build the vMix group row shape shared by the group endpoints (multi-event and
 * legacy `/groups`, `/group`, `/groups/flat`). Exposes the rider's club
 * (`felagKnapa` ← FelagKnapa) and the horse's club (`felagHests` ←
 * FelagEiganda) alongside the existing fields; `Lid` is preserved as-is.
 *
 * @param {object} entry a normalized leaderboard entry
 * @returns {{ name:string, horse:string, Lid:string, felagKnapa:string, felagHests:string, Nr:string, saeti:string, einkunn:string }}
 */
function toVmixGroupRow(entry) {
  return {
    name: entry.Knapi || '',
    horse: entry.Hestur || '',
    Lid: entry.Lid || '',
    felagKnapa: entry.FelagKnapa || '',
    felagHests: entry.FelagEiganda || '',
    Nr: entry.Nr || '',
    saeti: entry.Saeti || '',
    einkunn: entry.E6 || '',
  };
}

export function extractGangtegundResults(currentState, sort = 'start') {
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

  // Fallback for competitions with no gait breakdown (gæðingaskeið / skeið):
  // emit one row per rider from the overall marks, using the exact same row
  // shape as the gait rows above, so /results stays empty-of-changes for the
  // vMix graphics and simply works for these competitions too.
  if (rowsByGait.size === 0) {
    currentState.forEach((rider) => {
      const adal = rider.adal || {};
      const row = {
        gangtegundKey: 'heild',
        title: 'Heild',
        name: rider.Knapi,
        horse: rider.Hestur,
        color: rider.LiturRas || '',
        colorHex: getColorHex(rider.LiturRas),
        Nr: rider.Nr,
        Saeti: rider.Saeti,
        pos: '',
        E1: adal.E1 || '',
        E2: adal.E2 || '',
        E3: adal.E3 || '',
        E4: adal.E4 || '',
        E5: adal.E5 || '',
        E6: adal.E6 || '',
      };
      if (!rowsByGait.has('heild')) {
        rowsByGait.set('heild', []);
      }
      rowsByGait.get('heild').push(row);
    });
  }

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

/**
 * Build a fixed-order start-list / results row for a normalized entry, honoring
 * the per-Class_Type field order (Requirement 8, design Component 7 "Row
 * ordering", Correctness Property 10).
 *
 * The normalizer has already mapped the competitor / secondary / club into the
 * canonical `Knapi` / `Hestur` / `Lid` fields for the entry's Class_Type:
 *   - competitor-horse mode (Adult_Quality_Class): horse → `Knapi`,
 *     rider → `Hestur`, horse club → `Lid`.
 *   - rider-primary mode (Younger_Quality_Class, Sport_Tolt_Class,
 *     Gaedingaskeid_Class): rider → `Knapi`, horse → `Hestur`,
 *     rider club → `Lid`.
 * buildOrderedRow therefore maps those canonical fields into their fixed
 * positional order and appends the trailing score field. The same ordering is
 * applied to BOTH the start-list and results outputs.
 *
 * Fixed field order (position 1 → 4):
 *   Adult_Quality_Class:                horse name, rider name, horse club, Final_Score
 *   Younger_Quality_Class / Sport_Tolt: rider name, horse name, rider club, Final_Score
 *   Gaedingaskeid_Class:                rider name, horse name, rider club, Speed_Time
 *
 * Because the values are already canonicalized, positions 1–3 (`name`, `horse`,
 * `Lid`) are read uniformly from `Knapi` / `Hestur` / `Lid`; only the trailing
 * score differs — the gæðingaskeið Speed_Time (`TIME`) for the gæðingaskeið
 * layout, and the Final_Score (canonical `E6`) for every other layout.
 *
 * Any unavailable value is emitted as an empty string in its fixed position;
 * fields are never dropped or shifted (Requirement 8.5).
 *
 * @param {object} entry a normalized leaderboard entry (canonical Knapi/Hestur/Lid)
 * @param {string} classType one of ClassType.* (unknown/missing → default policy)
 * @returns {{ name: string, horse: string, Lid: string, einkunn: string }}
 *
 * Requirements: 8.1, 8.2, 8.3, 8.5
 */
export function buildOrderedRow(entry, classType) {
  const source = entry && typeof entry === 'object' ? entry : {};
  const policy = getClassTypePolicy(classType);

  // Position 4 is the gæðingaskeið Speed_Time for the gæðingaskeið layout and
  // the Final_Score (canonical E6) for every other layout.
  const score = policy.layout === 'gaedingaskeid' ? source.TIME : source.E6;

  // Insert keys in the fixed positional order so the row's field order is
  // identical for the start-list and results outputs.
  return {
    name: source.Knapi || '',
    horse: source.Hestur || '',
    Lid: source.Lid || '',
    einkunn: score || '',
  };
}

/**
 * RaslistiForkeppni start-list variant (Requirement 8.4, design Component 7
 * "RaslistiForkeppni", Correctness Property 11).
 *
 * Given a default start-list schema row (the shape produced by
 * `buildOrderedRow`: `{ name, horse, Lid, einkunn }`), swap ONLY the rider and
 * horse name field *values* (`name` ⇄ `horse`). The club (`Lid`) and every
 * other field are left byte-for-byte unchanged in value and position; the key
 * order of the row is preserved because `name`/`horse` already exist on the
 * default schema and are only reassigned, not re-inserted.
 *
 * This is a thin, purely positional transform layered on top of the canonical
 * start-list row — it does NOT re-read the class-type policy or re-map fields.
 * A non-object input yields an empty default row so callers never throw.
 *
 * @param {{ name?: string, horse?: string, Lid?: string, einkunn?: string }} row
 * @returns {{ name: string, horse: string, Lid: string, einkunn: string }}
 *
 * Requirements: 8.4
 */
export function swapNameFields(row) {
  const source = row && typeof row === 'object' ? row : {};
  // Spread first so all other fields (Lid, einkunn, any extras) keep their
  // value AND position, then overwrite only the two name values with each
  // other. Because `name` and `horse` already exist on the default schema,
  // reassigning them does not change their position in the row.
  return {
    ...source,
    name: source.horse || '',
    horse: source.name || '',
  };
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

/**
 * Build a fully-empty finals seat row matching the shape produced by
 * `buildOrderedRow` (`{ name, horse, Lid, einkunn }`), every field blank.
 * Used to pad a finals output up to its Class_Type seat count.
 *
 * @returns {{ name: string, horse: string, Lid: string, einkunn: string }}
 */
function emptySeatRow() {
  return { name: '', horse: '', Lid: '', einkunn: '' };
}

/**
 * Normalize a finals row list to exactly `seatCount` seats (design Component 7
 * "Finals seats", Correctness Property 12, Requirements 9.1–9.4).
 *
 * `rows` are expected to already be ordered by finishing position (top finisher
 * first) as produced by `buildOrderedRow` over a rank-sorted leaderboard:
 *   - MORE rows than seats → keep only the top `seatCount` finishers, drop the
 *     rest.
 *   - FEWER rows than seats → pad with fully-empty seat objects so the output
 *     always has exactly `seatCount` seats.
 *
 * The seat count comes from `finalsSeatCount(classType)` (8 for quality, 5 for
 * tölt). When `seatCount` is not a positive integer (e.g. a Class_Type without
 * a defined finals seat count) the rows are returned unchanged so the function
 * is total and never fabricates seats for non-finals classes.
 *
 * @param {Array<object>} rows        ordered finals rows (finishing position order)
 * @param {number} seatCount          target seat count (8 | 5)
 * @returns {Array<object>} exactly `seatCount` seat rows (or `rows` unchanged
 *   when `seatCount` is not a positive integer)
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4
 */
function padToSeats(rows, seatCount) {
  const source = Array.isArray(rows) ? rows : [];
  if (!Number.isInteger(seatCount) || seatCount <= 0) return source;

  if (source.length >= seatCount) {
    // More (or equal) finishers than seats: keep the top `seatCount`.
    return source.slice(0, seatCount);
  }

  // Fewer finishers than seats: pad the remainder with empty seats.
  const padded = source.slice();
  while (padded.length < seatCount) {
    padded.push(emptySeatRow());
  }
  return padded;
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

  const eventId = req.resolvedEventId;
  const leaderboard = eventId
    ? getLeaderboardForEvent(eventId, competitionId)
    : getLeaderboardState(competitionId);
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

/**
 * Legacy route resolution middleware.
 * Resolves which event to serve for legacy endpoints (without eventId in URL).
 *
 * Resolution order:
 * 1. If 0 active events → HTTP 404
 * 2. If 1 active event → resolve to that event
 * 3. If multiple + default configured → resolve to default
 * 4. If multiple + no default → HTTP 409 with list of active eventIds
 */
export function resolveLegacyEvent(req, res, next) {
  const activeEvents = getActiveEvents();

  if (activeEvents.length === 0) {
    return res.status(404).json({ error: 'No active events' });
  }
  if (activeEvents.length === 1) {
    req.resolvedEventId = activeEvents[0].eventId;
    return next();
  }
  const defaultId = getDefaultEventId();
  if (defaultId) {
    req.resolvedEventId = defaultId;
    return next();
  }
  return res.status(409).json({
    error: 'Multiple active events — specify eventId in URL',
    activeEvents: activeEvents.map((e) => e.eventId),
  });
}

/**
 * Validate eventId param: must be a positive integer and resolvable (either real eventId or slot 1-10).
 * Returns the resolved real eventId or null (after sending an error response).
 */
function validateEventId(req, res) {
  const raw = req.params.eventId;
  const parsed = Number.parseInt(String(raw), 10);
  if (
    !Number.isInteger(parsed) ||
    parsed <= 0 ||
    String(parsed) !== String(raw)
  ) {
    res
      .status(400)
      .json({ error: 'Invalid eventId: must be a positive integer' });
    return null;
  }
  const resolved = resolveEventId(parsed);
  if (!resolved) {
    res.status(404).json({
      error: `Event ${parsed} is not active (checked as eventId and slot number)`,
    });
    return null;
  }
  return resolved;
}

/**
 * Validate competitionType param: must be one of the supported types.
 * Returns the competitionId or null (after sending an error response).
 */
function validateCompetitionType(req, res) {
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

/**
 * Resolve a multi-event competition request: validates eventId and competitionType,
 * retrieves the leaderboard, applies sort and search filters.
 */
function resolveMultiEventRequest(req, res, defaultSort = 'start') {
  const eventId = validateEventId(req, res);
  if (eventId === null) return null;

  const scope = validateCompetitionType(req, res);
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

  const leaderboard = getLeaderboardForEvent(eventId, competitionId);
  const sorted = sortLeaderboard(leaderboard, sort);
  const search = req.query.search == null ? '' : String(req.query.search);
  const filtered = filterLeaderboardBySearch(sorted, search);
  return {
    eventId,
    competitionType,
    competitionId,
    sort,
    sorted: filtered,
    search,
  };
}

/**
 * Map a pressed vMix slot (1=forkeppni, 2=a-urslit, 3=b-urslit) to the real
 * Sportfengur competition number to fetch for a given class.
 *
 * Standard events: the class has a test row whose keppni_numer equals the
 * pressed slot (1/2/3) — use it directly.
 *
 * Multi-heat events (gæðingaskeið): the class has no 1/2/3 rows, only sprettir
 * (e.g. keppni_numer 4,5,6...). The Sportfengur API does not return these in a
 * reliable order and unopened heats have an empty starting list, so we pick the
 * first OPENED heat (lowest keppni_rod among keppni_opnud===1), falling back to
 * the lowest-rod heat if none are flagged open.
 *
 * @param {Array<{flokkar_numer:number, keppni_numer:number, keppni_rod:number, keppni_opnud:number}>} tests
 * @param {number} classId
 * @param {number} requestedCompetitionId - the pressed slot (1/2/3)
 * @returns {number} the Sportfengur competition number to fetch from
 */
export function resolveFetchCompetitionId(
  tests,
  classId,
  requestedCompetitionId,
) {
  const classTests = (Array.isArray(tests) ? tests : []).filter(
    (t) => Number(t.flokkar_numer) === Number(classId),
  );
  if (classTests.length === 0) return requestedCompetitionId;

  // Standard event: pressed slot maps directly to a real competition number.
  const directMatch = classTests.find(
    (t) => Number(t.keppni_numer) === Number(requestedCompetitionId),
  );
  if (directMatch && directMatch.keppni_numer != null) {
    return Number(directMatch.keppni_numer);
  }

  // Multi-heat event (gæðingaskeið): pick the first opened spretti.
  const byRod = (a, b) => Number(a.keppni_rod) - Number(b.keppni_rod);
  const opened = classTests
    .filter((t) => Number(t.keppni_opnud) === 1)
    .sort(byRod);
  const chosen = opened[0] ?? [...classTests].sort(byRod)[0];
  return chosen?.keppni_numer != null
    ? Number(chosen.keppni_numer)
    : requestedCompetitionId;
}

/**
 * Find a named stage (e.g. milli-riðill) among the Sportfengur test rows for a
 * class, by matching the `keppni` display name against a regex. Used by the
 * manual "milli-ridill → forkeppni" refresh, where the stage has its own
 * keppni_numer that is not one of the fixed vMix slots (1/2/3).
 *
 * When several rows match (e.g. "1. milliriðill", "2. milliriðill"), the first
 * OPENED one by keppni_rod wins, falling back to the lowest-rod match when none
 * are flagged open. Returns null when the class has no matching stage.
 *
 * @param {Array<{flokkar_numer:number, keppni_numer:number, keppni?:string, keppni_rod:number, keppni_opnud:number}>} tests
 * @param {number} classId
 * @param {RegExp} nameRegex matched against the keppni display name
 * @returns {number|null} the Sportfengur competition number, or null
 */
export function resolveStageByName(tests, classId, nameRegex) {
  const matches = (Array.isArray(tests) ? tests : []).filter(
    (t) =>
      Number(t.flokkar_numer) === Number(classId) &&
      nameRegex.test(String(t.keppni || '')) &&
      t.keppni_numer != null,
  );
  if (matches.length === 0) return null;

  const byRod = (a, b) => Number(a.keppni_rod) - Number(b.keppni_rod);
  const opened = matches.filter((t) => Number(t.keppni_opnud) === 1).sort(byRod);
  const chosen = opened[0] ?? [...matches].sort(byRod)[0];
  return Number(chosen.keppni_numer);
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

    <!-- GLOBAL SHORTCUTS (bottom) -->
    <div class="card" style="margin-top:12px">
      <h2 id="globalShortcutsHeading">Flýtileiðir</h2>
      <p class="muted" style="margin-top:0">Flýtileiðir fyrir valið mót. Sort: bættu við <code>?sort=start</code> eða <code>?sort=rank</code>.</p>
      <div id="globalShortcuts" class="endpoint-grid"></div>
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
        // Re-populate swap dropdowns now that search options are loaded
        populateSwapSelects();
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
        // Get event name from dropdown
        const selectedOption = eventSearchSelect.options[eventSearchSelect.selectedIndex];
        const eventName = selectedOption?.dataset?.eventName || '';
        const r = await fetch('/events/register', {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ eventId, name: eventName }),
        });
        const data = await r.json();
        if (!r.ok) {
          alert(data?.error || 'Villa við skráningu móts');
          return;
        }
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
        renderGlobalShortcuts(null);
        return;
      }
      emptyState.style.display = 'none';

      // Render tab buttons
      tabBar.innerHTML = activeEvents.map((ev, idx) => {
        const slot = idx + 1;
        const displayLabel = ev.label || ev.name || ('Slot ' + slot);
        const isActive = ev.eventId === activeTabId;
        return '<button class="tab-btn' + (isActive ? ' active' : '') + '" data-event-id="' + ev.eventId + '" onclick="selectTab(' + ev.eventId + ')">'
          + displayLabel
          + '<span class="tab-close" onclick="event.stopPropagation(); removeEvent(' + ev.eventId + ')" title="Fjarlægja mót">&times;</span>'
          + '</button>';
      }).join('');

      // Render tab panels (only create if not existing)
      activeEvents.forEach((ev, idx) => {
        let panel = document.getElementById('tab-panel-' + ev.eventId);
        if (!panel) {
          panel = document.createElement('div');
          panel.id = 'tab-panel-' + ev.eventId;
          panel.className = 'tab-content';
          panel.innerHTML = createTabPanelHtml(ev, idx + 1);
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

    function createTabPanelHtml(ev, slotNum) {
      const eventId = ev.eventId;
      const displayName = ev.label || ev.name || ('Slot ' + slotNum);
      const currentLabel = ev.label || '';
      return '<div class="tab-panel">'
        + '<h2>' + displayName + '</h2>'
        + '<div style="display:flex;gap:8px;align-items:end;margin-bottom:10px">'
        + '<div style="flex:1"><label>Nafn á slot (t.d. bílnúmer)</label>'
        + '<input id="labelInput-' + eventId + '" type="text" placeholder="T.d. Bíll 1" value="' + currentLabel + '" /></div>'
        + '<button class="secondary" style="width:auto;padding:10px 16px" onclick="updateSlotLabel(' + eventId + ')">Vista nafn</button>'
        + '</div>'
        + '<div style="display:flex;gap:8px;align-items:end;margin-bottom:10px">'
        + '<div style="flex:1"><label>Skipta um mót á þessu sloti</label>'
        + '<select id="swapSelect-' + eventId + '" class="swap-select"></select></div>'
        + '<button class="secondary" style="width:auto;padding:10px 16px" onclick="swapEvent(' + eventId + ')">Skipta</button>'
        + '</div>'
        + '<div id="classIdState-' + eventId + '" class="statebox">classId state: hleð...</div>'
        + '<div style="display:flex;gap:8px;align-items:end;margin-bottom:10px;margin-top:10px">'
        + '<div style="flex:1"><label>ClassId gating (aðeins þetta classId uppfærir gögn)</label>'
        + '<select id="gateSelect-' + eventId + '"><option value="">Allt leyft (ekkert gate)</option></select></div>'
        + '<button class="secondary" style="width:auto;padding:10px 16px" onclick="setGate(' + eventId + ')">Setja gate</button>'
        + '</div>'
        + '<label>ClassId (valfrjálst handvirkt)</label>'
        + '<input id="classIdInput-' + eventId + '" type="number" placeholder="T.d. 203060" />'
        + '<div class="three">'
        + '<button class="primary" onclick="refreshEventCompetition(' + eventId + ', &quot;forkeppni&quot;)">Uppfæra forkeppni</button>'
        + '<button class="primary" onclick="refreshEventCompetition(' + eventId + ', &quot;a-urslit&quot;)">Uppfæra a-úrslit</button>'
        + '<button class="primary" onclick="refreshEventCompetition(' + eventId + ', &quot;b-urslit&quot;)">Uppfæra b-úrslit</button>'
        + '</div>'
        + '<h2 style="margin-top:14px">Niðurstaða</h2>'
        + '<pre id="result-' + eventId + '"></pre>'
        + '</div>';
    }

    // --- Per-Event State Loading ---

    async function loadEventTabState(eventId) {
      try {
        const r = await fetch('/event/' + eventId + '/state');
        if (!r.ok) return;
        const data = await r.json();
        renderEventClassIdState(eventId, data);
        populateSwapSelects();
        loadGateOptions(eventId);
        renderGlobalShortcuts(eventId);
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

    function renderGlobalShortcuts(eventId) {
      const container = document.getElementById('globalShortcuts');
      const heading = document.getElementById('globalShortcutsHeading');
      if (!container) return;
      if (!eventId) {
        container.innerHTML = '';
        if (heading) heading.textContent = 'Flýtileiðir';
        return;
      }
      const ev = activeEvents.find((e) => e.eventId === eventId);
      const displayName = ev ? (ev.label || ev.name || ('Mót ' + eventId)) : ('Mót ' + eventId);
      if (heading) heading.textContent = 'Flýtileiðir — ' + displayName;

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

    async function updateSlotLabel(eventId) {
      const input = document.getElementById('labelInput-' + eventId);
      const label = String(input?.value || '').trim();
      try {
        const r = await fetch('/events/' + eventId + '/label', {
          method: 'PATCH',
          headers: headers(),
          body: JSON.stringify({ label }),
        });
        if (!r.ok) {
          const data = await r.json();
          alert(data?.error || 'Villa');
          return;
        }
        // Update local state and re-render tabs
        const ev = activeEvents.find((e) => e.eventId === eventId);
        if (ev) ev.label = label;
        renderTabs();
        selectTab(eventId);
      } catch (e) {
        alert('Villa: ' + e.message);
      }
    }

    async function swapEvent(oldEventId) {
      const select = document.getElementById('swapSelect-' + oldEventId);
      const newEventId = Number.parseInt(String(select?.value || ''), 10);
      if (!Number.isInteger(newEventId) || newEventId <= 0) {
        alert('Veldu mót til að skipta yfir á.');
        return;
      }
      const selectedOption = select.options[select.selectedIndex];
      const newName = selectedOption?.dataset?.eventName || '';
      try {
        const r = await fetch('/events/' + oldEventId + '/replace', {
          method: 'PATCH',
          headers: headers(),
          body: JSON.stringify({ eventId: newEventId, name: newName }),
        });
        const data = await r.json();
        if (!r.ok) {
          alert(data?.error || 'Villa við að skipta um mót');
          return;
        }
        // Reload everything
        await loadActiveEvents();
        selectTab(newEventId);
      } catch (e) {
        alert('Villa: ' + e.message);
      }
    }

    function populateSwapSelects() {
      const selects = document.querySelectorAll('.swap-select');
      const eventSearchSelect = document.getElementById('eventSearchSelect');
      if (!eventSearchSelect) return;
      selects.forEach((select) => {
        // The select id is "swapSelect-<eventId>" — that eventId is the
        // currently active event on this slot.
        const currentEventId = Number.parseInt(
          String(select.id).replace('swapSelect-', ''),
          10,
        );
        const ev = activeEvents.find((e) => e.eventId === currentEventId);

        // Copy all options from the event search dropdown
        select.innerHTML = eventSearchSelect.innerHTML;

        // Ensure the current event is present as an option (it may not be in
        // the search list if it's from a different year/country)
        let hasCurrent = Array.from(select.options).some(
          (o) => Number.parseInt(o.value, 10) === currentEventId,
        );
        if (!hasCurrent && currentEventId) {
          const opt = document.createElement('option');
          opt.value = String(currentEventId);
          const labelName = ev && ev.name ? ev.name : 'Mót';
          opt.textContent = currentEventId + ' - ' + labelName;
          opt.dataset.eventName = ev && ev.name ? ev.name : '';
          select.appendChild(opt);
        }

        // Select the current event
        select.value = String(currentEventId);
      });
    }

    async function setGate(eventId) {
      const select = document.getElementById('gateSelect-' + eventId);
      const value = select?.value || '';
      const classId = value === '' ? null : Number(value);
      try {
        const r = await fetch('/events/' + eventId + '/gate', {
          method: 'PATCH',
          headers: headers(),
          body: JSON.stringify({ classId }),
        });
        const data = await r.json();
        if (!r.ok) {
          alert(data?.error || 'Villa');
          return;
        }
        const resultEl = document.getElementById('result-' + eventId);
        if (resultEl) {
          resultEl.className = 'ok';
          resultEl.textContent = classId ? 'Gate sett: aðeins classId ' + classId + ' uppfærir gögn' : 'Gate aftengt: öll classId leyfd';
        }
        // Sync classId input with the newly saved gate
        const classIdInput = document.getElementById('classIdInput-' + eventId);
        if (classIdInput) classIdInput.value = classId ? String(classId) : '';
      } catch (e) {
        alert('Villa: ' + e.message);
      }
    }

    async function loadGateOptions(eventId) {
      const select = document.getElementById('gateSelect-' + eventId);
      if (!select) return;
      try {
        // Fetch available classes for this event
        const r = await fetch('/event/' + eventId + '/tests');
        const data = await r.json();
        const tests = Array.isArray(data?.res) ? data.res : [];

        // Fetch current gate
        const gateR = await fetch('/events/' + eventId + '/gate');
        const gateData = await gateR.json();
        const currentGate = gateData?.allowedClassId;

        select.innerHTML = '<option value="">Allt leyft (ekkert gate)</option>';
        const seen = new Set();
        tests.forEach((test) => {
          const classId = Number(test?.flokkar_numer);
          if (!classId || seen.has(classId)) return;
          seen.add(classId);
          const name = test?.flokkur_nafn || '';
          const comp = test?.keppnisgrein || '';
          const option = document.createElement('option');
          option.value = String(classId);
          option.textContent = classId + (name ? ' — ' + name : '') + (comp ? ' (' + comp + ')' : '');
          if (currentGate === classId) option.selected = true;
          select.appendChild(option);
        });

        // Populate classId input from gate if the field is currently empty
        const classIdInput = document.getElementById('classIdInput-' + eventId);
        if (classIdInput && !classIdInput.value && currentGate) {
          classIdInput.value = String(currentGate);
        }
      } catch (e) {
        console.error('Failed to load gate options for event', eventId, e);
      }
    }

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
        // If a manual classId was used and the refresh succeeded, persist it as the gate
        if (r.ok && Number.isInteger(manualClassId) && manualClassId > 0) {
          fetch('/events/' + eventId + '/gate', {
            method: 'PATCH',
            headers: headers(),
            body: JSON.stringify({ classId: manualClassId }),
          }).then(() => loadGateOptions(eventId)).catch(() => {});
        }
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
      // Re-fetch events shortly after — names/classIds are resolved async
      // from Sportfengur and may not be present on the first load.
      setTimeout(() => {
        loadActiveEvents().catch(() => {});
      }, 2500);
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

/**
 * Fetch classIds from Sportfengur for an event and store them in the state.
 * This is called automatically when an event is registered.
 *
 * @param {number} slotKey - The registry/state key to store classIds under.
 * @param {number} [sourceEventId] - The real Sportfengur event to fetch from.
 *   Defaults to slotKey (normal case). For secondary slots this is the shared
 *   source event.
 */
async function resolveClassIdsForEvent(slotKey, sourceEventId = null) {
  const fetchEventId = sourceEventId == null ? slotKey : sourceEventId;
  const data = await apiGetWithRetry(
    `/${SPORTFENGUR_LOCALE}/event/tests/${fetchEventId}`,
  );
  const tests = Array.isArray(data?.res) ? data.res : [];

  // Backfill the event name from Sportfengur if available
  const firstWithName = tests.find(
    (t) => t?.mot_heiti || t?.motsheiti || t?.mot_nafn,
  );
  if (firstWithName) {
    const name =
      firstWithName.mot_heiti ||
      firstWithName.motsheiti ||
      firstWithName.mot_nafn;
    setEventName(slotKey, name);
  }

  for (const test of tests) {
    const competitionId = Number.parseInt(String(test?.keppni_numer), 10);
    const classId = Number.parseInt(String(test?.flokkar_numer), 10);
    if (
      Number.isInteger(competitionId) &&
      competitionId >= 1 &&
      competitionId <= 3 &&
      Number.isInteger(classId) &&
      classId > 0
    ) {
      setEventClassId(slotKey, competitionId, classId);

      // Resolve and store the Class_Type for this competition slot so the
      // normalizer/server can apply the correct Landsmót rules. Classification
      // is a pure function of the class name and discipline text taken from the
      // Sportfengur test row (Requirements 1.1, 1.6).
      const classType = classifyClassType({
        className: test?.flokkur_nafn,
        disciplineText: test?.keppnisgrein,
      });
      setEventClassType(slotKey, competitionId, classType);
    }
  }
  // Persist the resolved classIds so they survive a restart
  persistEventSlot(slotKey);
}

/**
 * Re-resolve classIds from Sportfengur for all currently active events.
 * Called after hydrateFromStore() on startup so competition classIds
 * are restored without needing a webhook or manual refresh.
 */
export async function resolveClassIdsForAllActiveEvents() {
  const events = getActiveEvents();
  for (const ev of events) {
    try {
      await resolveClassIdsForEvent(ev.eventId, ev.sourceEventId ?? ev.eventId);
    } catch (err) {
      console.error(
        `[Event Registry] Failed to re-resolve classIds for event ${ev.eventId}:`,
        err.message,
      );
    }
  }
}

export function registerVmixRoutes(app) {
  // Legacy control panel route — now superseded by the React app at /app.
  // Redirect any old bookmarks to the new UI.
  app.get('/control', (req, res) => {
    res.redirect('/app');
  });

  app.get('/event/current', resolveLegacyEvent, (req, res) => {
    const currentState = getCurrentState();
    const search = req.query.search == null ? '' : String(req.query.search);
    const filtered = filterLeaderboardBySearch(currentState, search);
    log.server.endpoint('/event/current', filtered.length);
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

  // --- Event Management API Routes ---

  app.post('/events/register', async (req, res) => {
    if (!requireAdmin(req, res, true)) return;
    const eventId = req.body?.eventId;
    const name = req.body?.name || '';
    try {
      const entry = registerEvent(eventId, name);

      // Auto-resolve classIds from Sportfengur in the background
      resolveClassIdsForEvent(entry.eventId).catch((err) => {
        console.error(
          `[Event Registry] Failed to resolve classIds for event ${entry.eventId}:`,
          err.message,
        );
      });

      res.setHeader('Content-Type', 'application/json');
      res.json({ ok: true, event: entry });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  // Add an additional slot (second/third car) for an event that is already
  // registered. The new slot has independent leaderboard data and its own
  // classId gate, but fetches from the same source Sportfengur event.
  app.post('/events/add-slot', async (req, res) => {
    if (!requireAdmin(req, res, true)) return;
    const sourceEventId = req.body?.eventId;
    const name = req.body?.name || '';
    try {
      const entry = addSlotForEvent(sourceEventId, name);

      // Resolve classIds from the SOURCE event for the new slot's state key
      resolveClassIdsForEvent(entry.eventId, entry.sourceEventId).catch(
        (err) => {
          console.error(
            `[Event Registry] Failed to resolve classIds for slot ${entry.eventId} (source ${entry.sourceEventId}):`,
            err.message,
          );
        },
      );

      res.setHeader('Content-Type', 'application/json');
      res.json({ ok: true, event: entry });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.delete('/events/:eventId', (req, res) => {
    if (!requireAdmin(req, res, true)) return;
    const eventId = Number(req.params.eventId);
    if (!Number.isInteger(eventId) || eventId <= 0) {
      return res
        .status(400)
        .json({ error: 'Invalid eventId: must be a positive integer' });
    }
    const removed = removeEvent(eventId);
    if (!removed) {
      return res
        .status(404)
        .json({ error: `Event ${eventId} is not registered` });
    }
    res.setHeader('Content-Type', 'application/json');
    res.json({ ok: true, eventId });
  });

  app.patch('/events/:eventId/label', (req, res) => {
    if (!requireControlSession(req, res, true)) return;
    const eventId = Number(req.params.eventId);
    if (!Number.isInteger(eventId) || eventId <= 0) {
      return res.status(400).json({ error: 'Invalid eventId' });
    }
    if (!canAccessEventSlot(req, eventId)) {
      return res.status(403).json({ error: 'Forbidden: not your slot' });
    }
    const label = String(req.body?.label ?? '');
    const updated = updateEventLabel(eventId, label);
    if (!updated) {
      return res
        .status(404)
        .json({ error: `Event ${eventId} is not registered` });
    }
    res.json({ ok: true, eventId, label });
  });

  app.patch('/events/:eventId/replace', async (req, res) => {
    if (!requireAdmin(req, res, true)) return;
    const oldEventId = Number(req.params.eventId);
    const newEventId = req.body?.eventId;
    const newName = req.body?.name || '';
    try {
      const entry = replaceEvent(oldEventId, newEventId, newName);

      // Auto-resolve classIds for the new event
      resolveClassIdsForEvent(entry.eventId).catch((err) => {
        console.error(
          `[Event Registry] Failed to resolve classIds for event ${entry.eventId}:`,
          err.message,
        );
      });

      res.json({ ok: true, event: entry });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.patch('/events/:eventId/gate', (req, res) => {
    if (!requireControlSession(req, res, true)) return;
    const eventId = Number(req.params.eventId);
    if (!Number.isInteger(eventId) || eventId <= 0) {
      return res.status(400).json({ error: 'Invalid eventId' });
    }
    if (!canAccessEventSlot(req, eventId)) {
      return res.status(403).json({ error: 'Forbidden: not your slot' });
    }
    const classId =
      req.body?.classId === null || req.body?.classId === ''
        ? null
        : Number(req.body?.classId);
    if (classId !== null && (!Number.isInteger(classId) || classId <= 0)) {
      return res.status(400).json({ error: 'Invalid classId' });
    }
    const updated = setEventClassIdGate(eventId, classId);
    if (!updated) {
      return res
        .status(404)
        .json({ error: `Event ${eventId} is not registered` });
    }
    res.json({ ok: true, eventId, allowedClassId: classId });
  });

  app.get('/events/:eventId/gate', (req, res) => {
    if (!requireControlSession(req, res, true)) return;
    const eventId = Number(req.params.eventId);
    if (!Number.isInteger(eventId) || eventId <= 0) {
      return res.status(400).json({ error: 'Invalid eventId' });
    }
    const gate = getEventClassIdGate(eventId);
    res.json({ eventId, allowedClassId: gate });
  });

  app.get('/events', (req, res) => {
    if (!requireControlSession(req, res, true)) return;
    let events = getActiveEventsWithSlots();
    // Slot users only see their own slot; admins see all.
    const role = getRequestRole(req);
    const isAdmin = role && role.role === 'admin';
    if (role && role.role === 'slot') {
      events = events.filter((e) => Number(e.slot) === Number(role.slot));
    }
    // Only admins receive the login password; strip it for everyone else.
    events = events.map((e) => {
      const out = { ...e };
      if (!isAdmin) {
        delete out.loginPassword;
        delete out.loginUsername;
      }
      return out;
    });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    res.json({ events });
  });

  app.get('/events/state', (req, res) => {
    if (!requireControlSession(req, res, true)) return;
    const metadata = getAllEventsMetadata();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    res.json(metadata);
  });

  app.get('/event/:eventId/state', (req, res) => {
    if (!requireControlSession(req, res, true)) return;
    const eventId = Number(req.params.eventId);
    if (!Number.isInteger(eventId) || eventId <= 0) {
      return res
        .status(400)
        .json({ error: 'Invalid eventId: must be a positive integer' });
    }
    if (!isEventActive(eventId)) {
      return res.status(404).json({ error: `Event ${eventId} is not active` });
    }
    const state = getEventState(eventId);
    const competitions = {};
    if (state && state.competitions) {
      for (const [compId, compState] of Object.entries(state.competitions)) {
        competitions[compId] = {
          classId: compState.classId,
          leaderboardCount: compState.leaderboard.length,
        };
      }
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    res.json({ eventId, competitions });
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

  app.get('/event/leaderboards.zip', resolveLegacyEvent, sendLeaderboardsZip);
  app.get('/event/csv.zip', resolveLegacyEvent, sendLeaderboardsZip);

  // --- Multi-event routes: /event/:eventId/:competitionType ---

  app.get('/event/:eventId/:competitionType/groups', (req, res) => {
    const resolved = resolveMultiEventRequest(req, res);
    if (!resolved) return;
    const { eventId, competitionType, sort, sorted } = resolved;
    const groupSize =
      req.query.groupSize == null
        ? 7
        : Number.parseInt(req.query.groupSize, 10);
    if (!Number.isInteger(groupSize) || groupSize <= 0 || groupSize > 50) {
      return res
        .status(400)
        .json({ error: 'Invalid groupSize value', supported: '1-50' });
    }
    const vmixRows = sorted.map(toVmixGroupRow);
    const groups = chunkEntries(vmixRows, groupSize);
    log.server.endpoint(
      `/event/${eventId}/${competitionType}/groups?sort=${sort}&groupSize=${groupSize}`,
      sorted.length,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    res.json(groups);
  });

  app.get('/event/:eventId/:competitionType/group', (req, res) => {
    const resolved = resolveMultiEventRequest(req, res);
    if (!resolved) return;
    const { eventId, competitionType, sort, sorted } = resolved;
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
    const vmixRows = sorted.map(toVmixGroupRow);
    const selectedGroup = chunkEntries(vmixRows, groupSize)[group - 1] || [];
    log.server.endpoint(
      `/event/${eventId}/${competitionType}/group?sort=${sort}&groupSize=${groupSize}&group=${group}`,
      selectedGroup.length,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    res.json(selectedGroup);
  });

  app.get('/event/:eventId/:competitionType/groups/flat', (req, res) => {
    const resolved = resolveMultiEventRequest(req, res);
    if (!resolved) return;
    const { eventId, competitionType, sort, sorted } = resolved;
    const groupSize =
      req.query.groupSize == null
        ? 7
        : Number.parseInt(req.query.groupSize, 10);
    if (!Number.isInteger(groupSize) || groupSize <= 0 || groupSize > 50) {
      return res
        .status(400)
        .json({ error: 'Invalid groupSize value', supported: '1-50' });
    }
    const vmixRows = sorted.map(toVmixGroupRow);
    const grouped = chunkEntries(vmixRows, groupSize);
    const flattened = grouped.map((groupRows, groupIndex) => {
      const row = { group: groupIndex + 1 };
      for (let i = 0; i < groupSize; i += 1) {
        const contestant = groupRows[i];
        const n = i + 1;
        row[`name${n}`] = contestant?.name || '';
        row[`horse${n}`] = contestant?.horse || '';
        row[`Lid${n}`] = contestant?.Lid || '';
        row[`felagKnapa${n}`] = contestant?.felagKnapa || '';
        row[`felagHests${n}`] = contestant?.felagHests || '';
        row[`Nr${n}`] = contestant?.Nr || '';
        row[`saeti${n}`] = contestant?.saeti || '';
        row[`einkunn${n}`] = contestant?.einkunn || '';
      }
      return row;
    });
    log.server.endpoint(
      `/event/${eventId}/${competitionType}/groups/flat?sort=${sort}&groupSize=${groupSize}`,
      flattened.length,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    res.json(flattened);
  });

  app.get('/event/:eventId/:competitionType/csv', (req, res) => {
    const resolved = resolveMultiEventRequest(req, res);
    if (!resolved) return;
    const { eventId, competitionType, sort, sorted } = resolved;
    const csv = withUtf8Bom(leaderboardToCsv(sorted));
    log.server.endpoint(
      `/event/${eventId}/${competitionType}/csv?sort=${sort}`,
      sorted.length,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${competitionType}-${eventId}-${sort}.csv"`,
    );
    res.send(csv);
  });

  app.get('/event/:eventId/:competitionType/raslisti-forkeppni', (req, res) => {
    const resolved = resolveMultiEventRequest(req, res);
    if (!resolved) return;
    const { eventId, competitionType, competitionId, sort, sorted } = resolved;
    const classType = getEventClassType(eventId, competitionId);
    // Build the canonical, class-type-ordered start-list rows, then apply the
    // RaslistiForkeppni name swap (rider ⇄ horse values only). Club and score
    // stay in their default positions.
    const rows = sorted.map((entry) =>
      swapNameFields(buildOrderedRow(entry, classType)),
    );
    log.server.endpoint(
      `/event/${eventId}/${competitionType}/raslisti-forkeppni?sort=${sort}`,
      rows.length,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    res.json(rows);
  });

  app.get('/event/:eventId/:competitionType/finals', (req, res) => {
    // Finals output (a-úrslit / b-úrslit): class-type-ordered rows padded or
    // truncated to the Class_Type finals seat count (8 quality / 5 tölt)
    // instead of the fixed groups chunk of 7. Default sort is 'rank' so
    // truncation keeps the top finishers by finishing position.
    const resolved = resolveMultiEventRequest(req, res, 'rank');
    if (!resolved) return;
    const { eventId, competitionType, competitionId, sort, sorted } = resolved;
    const classType = getEventClassType(eventId, competitionId);
    const seatCount = finalsSeatCount(classType);
    const rows = padToSeats(
      sorted.map((entry) => buildOrderedRow(entry, classType)),
      seatCount,
    );
    log.server.endpoint(
      `/event/${eventId}/${competitionType}/finals?sort=${sort}`,
      rows.length,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    res.json(rows);
  });

  app.get('/event/:eventId/:competitionType/results', (req, res) => {
    const resolved = resolveMultiEventRequest(req, res, 'start');
    if (!resolved) return;
    const { eventId, competitionType, sort, sorted } = resolved;
    const results = extractGangtegundResults(sorted, sort);
    log.server.endpoint(
      `/event/${eventId}/${competitionType}/results?sort=${sort}`,
      results.length,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    res.json(results);
  });

  app.post('/event/:eventId/:competitionType/refresh', async (req, res) => {
    if (!requireControlSession(req, res, true)) return;

    const eventId = validateEventId(req, res);
    if (eventId === null) return;

    // Slot users may only refresh their own slot
    if (!canAccessEventSlot(req, eventId)) {
      return res.status(403).json({ error: 'Forbidden: not your slot' });
    }

    // Special manual type: milli-ridill — fetch the class's milli-riðill stage
    // (own keppni_numer on Sportfengur, discovered by name) and store it OVER
    // the forkeppni slot (competitionId 1) so the fixed vMix graphics pick it
    // up without any template changes.
    const rawType = String(req.params.competitionType || '')
      .trim()
      .toLowerCase();
    const isMilliRidill =
      rawType === 'milli-ridill' ||
      rawType === 'milliridill' ||
      rawType === 'milli-riðill';

    let scope;
    if (isMilliRidill) {
      scope = { competitionType: 'milli-ridill', competitionId: 1 };
    } else {
      scope = validateCompetitionType(req, res);
      if (!scope) return;
    }
    const { competitionType, competitionId } = scope;

    // Check if refresh already in progress
    if (isRefreshInProgress(eventId, competitionId)) {
      return res.status(409).json({
        error: 'Refresh already in progress',
        eventId,
        competitionType,
      });
    }

    const bodyClassId =
      req.body?.classId == null ? null : parsePositiveInt(req.body.classId);

    // classId resolution priority for manual refresh:
    // 1. Explicit classId in request body (manual override)
    // 2. The gated classId for this event (same class used for webhook filtering)
    // 3. The classId stored in state for this competition
    const gateClassId = getEventClassIdGate(eventId);
    const eventStateData = getEventState(eventId);
    const stateClassId =
      eventStateData?.competitions?.[competitionId]?.classId || null;
    const classId = bodyClassId ?? gateClassId ?? stateClassId;

    if (!classId) {
      return res
        .status(400)
        .json({ error: 'Missing classId (and no classId found in state)' });
    }

    try {
      // Resolve the correct Sportfengur competition number for this classId.
      // The operator may have a gate set to a class that belongs to a different
      // Sportfengur competition number than the button they pressed.
      const sourceEv = getSourceEventId(eventId);

      const testsData = await apiGetWithRetry(
        `/${SPORTFENGUR_LOCALE}/event/tests/${sourceEv}`,
      );
      const tests = Array.isArray(testsData?.res) ? testsData.res : [];

      let fetchCompetitionId;
      if (isMilliRidill) {
        fetchCompetitionId = resolveStageByName(tests, classId, /milli/i);
        if (fetchCompetitionId == null) {
          return res.status(404).json({
            error:
              'No milli-riðill stage found for this class on Sportfengur (yet)',
            classId,
            stages: tests
              .filter((t) => Number(t.flokkar_numer) === Number(classId))
              .map((t) => ({
                keppni: t.keppni,
                keppni_numer: t.keppni_numer,
                opnud: t.keppni_opnud,
              })),
          });
        }
      } else {
        fetchCompetitionId = resolveFetchCompetitionId(
          tests,
          classId,
          competitionId,
        );
      }

      // Fetch from Sportfengur using the resolved competition number, but
      // store under the display competition slot (1=forkeppni, 2=a-urslit, 3=b-urslit)
      // so the data appears at the expected vMix endpoint. For gæðingaskeið the
      // Sportfengur competition number (e.g. 5) differs from the storage slot (1);
      // for milli-ridill the milli-riðill stage is written over the forkeppni slot.
      await refreshCompetitionNow(
        eventId,
        classId,
        competitionId,
        true,
        sourceEv,
        fetchCompetitionId,
      );
      const total = getLeaderboardForEvent(eventId, competitionId).length;
      res.json({
        ok: true,
        eventId,
        classId,
        competitionType,
        competitionId,
        fetchCompetitionId,
        total,
      });
    } catch (error) {
      res.status(error.status || 500).json({
        error: 'Manual refresh failed',
        message: error.message,
      });
    }
  });

  // --- Multi-event ZIP routes ---

  const sendEventLeaderboardsZip = async (req, res) => {
    const raw = req.params.eventId;
    const eventId = Number.parseInt(String(raw), 10);
    if (
      !Number.isInteger(eventId) ||
      eventId <= 0 ||
      String(eventId) !== String(raw)
    ) {
      return res
        .status(400)
        .json({ error: 'Invalid eventId: must be a positive integer' });
    }
    if (!isEventActive(eventId)) {
      return res.status(404).json({ error: `Event ${eventId} is not active` });
    }

    const zip = new JSZip();

    for (const [competitionType, competitionId] of Object.entries(
      COMPETITION_TYPE_TO_ID,
    )) {
      const leaderboard = getLeaderboardForEvent(eventId, competitionId);
      const startRows = sortLeaderboard(leaderboard, 'start');
      const rankRows = sortLeaderboard(leaderboard, 'rank');
      zip.file(
        `${competitionType}-${eventId}-start.csv`,
        withUtf8Bom(leaderboardToCsv(startRows)),
      );
      zip.file(
        `${competitionType}-${eventId}-rank.csv`,
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
      `attachment; filename="leaderboards-${eventId}.zip"`,
    );
    res.send(archive);
  };

  app.get('/event/:eventId/leaderboards.zip', sendEventLeaderboardsZip);
  app.get('/event/:eventId/csv.zip', sendEventLeaderboardsZip);

  // --- Sportfengur proxy routes (must be before generic :competitionType catch-all) ---

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

  // --- Legacy routes (single-event, backward compatible) ---

  app.get('/event/:competitionType', resolveLegacyEvent, (req, res) => {
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

  app.get('/event/:competitionType/groups', resolveLegacyEvent, (req, res) => {
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
    const vmixRows = sorted.map(toVmixGroupRow);
    const groups = chunkEntries(vmixRows, groupSize);
    log.server.endpoint(
      `/event/${competitionType}/groups?sort=${sort}&groupSize=${groupSize}`,
      sorted.length,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    res.json(groups);
  });

  app.get('/event/:competitionType/group', resolveLegacyEvent, (req, res) => {
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
    const vmixRows = sorted.map(toVmixGroupRow);
    const selectedGroup = chunkEntries(vmixRows, groupSize)[group - 1] || [];
    log.server.endpoint(
      `/event/${competitionType}/group?sort=${sort}&groupSize=${groupSize}&group=${group}`,
      selectedGroup.length,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    res.json(selectedGroup);
  });

  app.get(
    '/event/:competitionType/groups/flat',
    resolveLegacyEvent,
    (req, res) => {
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
      const vmixRows = sorted.map(toVmixGroupRow);
      const grouped = chunkEntries(vmixRows, groupSize);
      const flattened = grouped.map((groupRows, groupIndex) => {
        const row = { group: groupIndex + 1 };
        for (let i = 0; i < groupSize; i += 1) {
          const contestant = groupRows[i];
          const n = i + 1;
          row[`name${n}`] = contestant?.name || '';
          row[`horse${n}`] = contestant?.horse || '';
          row[`Lid${n}`] = contestant?.Lid || '';
          row[`felagKnapa${n}`] = contestant?.felagKnapa || '';
          row[`felagHests${n}`] = contestant?.felagHests || '';
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
    },
  );

  app.get('/event/:competitionType/csv', resolveLegacyEvent, (req, res) => {
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

  app.get('/event/:competitionType/results', resolveLegacyEvent, (req, res) => {
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

  app.get('/event/:competitionType/finals', resolveLegacyEvent, (req, res) => {
    // Legacy single-event finals output: same seat-padding behavior as the
    // multi-event finals route, resolving the event via legacy resolution.
    const resolved = resolveCompetitionRequest(req, res, 'rank');
    if (!resolved) return;
    const { competitionType, competitionId, sort, sorted } = resolved;
    const eventId = req.resolvedEventId;
    const classType = getEventClassType(eventId, competitionId);
    const seatCount = finalsSeatCount(classType);
    const rows = padToSeats(
      sorted.map((entry) => buildOrderedRow(entry, classType)),
      seatCount,
    );
    log.server.endpoint(
      `/event/${competitionType}/finals?sort=${sort}`,
      rows.length,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    res.json(rows);
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
      // Resolve the real Sportfengur competition number for this classId.
      const testsData = await apiGetWithRetry(
        `/${SPORTFENGUR_LOCALE}/event/tests/${eventId}`,
      );
      const testsArr = Array.isArray(testsData?.res) ? testsData.res : [];
      const fetchCompetitionId = resolveFetchCompetitionId(
        testsArr,
        classId,
        competitionId,
      );

      // Store under the display slot (competitionId) but fetch from the real
      // Sportfengur competition number (fetchCompetitionId) — these differ for
      // gæðingaskeið (Sportfengur comp 5 stored under forkeppni slot 1).
      await refreshCompetitionNow(
        eventId,
        classId,
        competitionId,
        true,
        null,
        fetchCompetitionId,
      );
      const total = getLeaderboardState(competitionId).length;
      res.json({
        ok: true,
        eventId,
        classId,
        competitionType,
        competitionId,
        fetchCompetitionId,
        total,
      });
    } catch (error) {
      res.status(error.status || 500).json({
        error: 'Manual refresh failed',
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

  // --- Sportfengur proxy routes (must be before generic :eventId/:competitionType catch-all) ---

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

  // --- Multi-event JSON leaderboard (catch-all, must be last /event/:x/:y route) ---

  app.get('/event/:eventId/:competitionType', (req, res) => {
    const resolved = resolveMultiEventRequest(req, res);
    if (!resolved) return;
    const { eventId, competitionType, sort, sorted } = resolved;
    log.server.endpoint(
      `/event/${eventId}/${competitionType}?sort=${sort}`,
      sorted.length,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    res.json(sorted);
  });
}
