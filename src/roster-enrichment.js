import { ROSTER_CACHE_TTL_MS } from './config.js';
import { isDbConfigured, queryDb } from './db/client.js';
import { formatDecimals, getClassTypePolicy } from './vmix/class-type.js';
import { getBreedingRecord } from './worldfengur.js';

/**
 * Ordered list of candidate Sportfengur entry keys that may carry the horse's
 * registered club (adildarfelag). The exact horse-club field name is not yet
 * confirmed against live Sportfengur data, so the resolver tries each key in
 * order and falls back to the owner's club (`adildarfelag_eiganda`) before
 * emitting an empty string (design: "Horse-club field uncertainty").
 */
const HORSE_CLUB_CANDIDATE_KEYS = [
  'adildarfelag_hross',
  'hross_adildarfelag',
  'adildarfelag_eiganda',
];

/**
 * Resolve the horse's registered club from an entry using the ordered candidate
 * keys. Returns the first non-empty value (coerced to a trimmed string), or an
 * empty string when none is present. Never throws.
 *
 * @param {Record<string, unknown>} entry
 * @returns {string}
 */
function resolveHorseClub(entry) {
  for (const key of HORSE_CLUB_CANDIDATE_KEYS) {
    const value = entry?.[key];
    if (value !== undefined && value !== null) {
      const text = String(value).trim();
      if (text !== '') {
        return text;
      }
    }
  }
  return '';
}

let lastLoadedAt = 0;
let loadingPromise = null;
const leagueByEventId = new Map();
const teamsByLeagueAndName = new Map();
const rosterByLeague = new Map();
const warnedAmbiguousNames = new Set();

function normalizeName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/þ/g, 'th')
    .replace(/ð/g, 'd')
    .replace(/æ/g, 'ae')
    .replace(/\s+/g, ' ');
}

function tokenizeName(value) {
  return normalizeName(value)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function extractRiderName(entry) {
  return String(
    entry?.knapi_fullt_nafn ||
      entry?.knapi_fulltnafn ||
      entry?.knapi_nafn ||
      entry?.Knapi ||
      '',
  ).trim();
}

function riderKey(leagueKey, riderName) {
  return `${leagueKey}:${normalizeName(riderName)}`;
}

async function loadRosterCache(force = false) {
  if (!isDbConfigured()) {
    return;
  }

  const now = Date.now();
  if (!force && now - lastLoadedAt < ROSTER_CACHE_TTL_MS) {
    return;
  }

  if (loadingPromise) {
    await loadingPromise;
    return;
  }

  loadingPromise = (async () => {
    const [leagues, memberships] = await Promise.all([
      queryDb(
        `
        SELECT event_id, league_key
        FROM league_events
        `,
      ),
      queryDb(
        `
        SELECT m.league_key, c.display_name, t.name AS team_name
        FROM contestant_league_memberships m
        JOIN contestants c ON c.id = m.contestant_id
        JOIN league_teams t ON t.id = m.league_team_id
        WHERE c.display_name IS NOT NULL AND c.display_name <> ''
        `,
      ),
    ]);

    leagueByEventId.clear();
    for (const row of leagues.rows) {
      const eventId = Number.parseInt(String(row.event_id), 10);
      if (Number.isInteger(eventId) && eventId > 0 && row.league_key) {
        leagueByEventId.set(eventId, String(row.league_key));
      }
    }

    const nextMap = new Map();
    const nextRosterByLeague = new Map();
    for (const row of memberships.rows) {
      if (!row.league_key || !row.display_name) continue;
      const key = riderKey(row.league_key, row.display_name);
      if (!nextMap.has(key)) {
        nextMap.set(key, new Set());
      }
      if (row.team_name) {
        nextMap.get(key).add(String(row.team_name));
      }

      if (!nextRosterByLeague.has(row.league_key)) {
        nextRosterByLeague.set(row.league_key, []);
      }
      nextRosterByLeague.get(row.league_key).push({
        displayName: String(row.display_name),
        tokens: tokenizeName(row.display_name),
        teamName: String(row.team_name || ''),
      });
    }

    teamsByLeagueAndName.clear();
    for (const [key, teamSet] of nextMap.entries()) {
      teamsByLeagueAndName.set(key, teamSet);
    }

    rosterByLeague.clear();
    for (const [leagueKey, entries] of nextRosterByLeague.entries()) {
      rosterByLeague.set(leagueKey, entries);
    }

    lastLoadedAt = Date.now();
  })();

  try {
    await loadingPromise;
  } finally {
    loadingPromise = null;
  }
}

function resolveLeagueKeyForEvent(eventId) {
  const parsedEventId = Number.parseInt(String(eventId), 10);
  if (!Number.isInteger(parsedEventId) || parsedEventId <= 0) {
    return null;
  }

  return leagueByEventId.get(parsedEventId) || `event-${parsedEventId}`;
}

function resolveTeamNameForRider(leagueKey, riderName) {
  const teamSet = teamsByLeagueAndName.get(riderKey(leagueKey, riderName));
  if (teamSet && teamSet.size > 0) {
    const teams = [...teamSet]
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    if (teams.length === 0) return '';

    if (teams.length > 1) {
      const key = `${leagueKey}:${riderName}`;
      if (!warnedAmbiguousNames.has(key)) {
        warnedAmbiguousNames.add(key);
        console.warn(
          `Ambiguous team match for rider "${riderName}" in league ${leagueKey}. Using "${teams[0]}" from [${teams.join(', ')}].`,
        );
      }
    }

    return teams[0] || '';
  }

  // Fallback for minor name variants (middle names/initials/spelling accents).
  const riderTokens = tokenizeName(riderName);
  if (riderTokens.length < 2) return '';
  const firstInitial = riderTokens[0][0] || '';
  const lastName = riderTokens[riderTokens.length - 1];
  const roster = rosterByLeague.get(leagueKey) || [];

  const matchedTeams = new Set();
  for (const entry of roster) {
    if (!entry.teamName || entry.tokens.length < 2) continue;
    const entryFirstInitial = entry.tokens[0][0] || '';
    const entryLastName = entry.tokens[entry.tokens.length - 1];
    if (entryLastName !== lastName || entryFirstInitial !== firstInitial) {
      continue;
    }

    const riderSet = new Set(riderTokens);
    const overlap = entry.tokens.reduce(
      (count, token) => (riderSet.has(token) ? count + 1 : count),
      0,
    );
    if (
      overlap >= 2 ||
      (overlap >= 1 && riderTokens.length === 2 && entry.tokens.length === 2)
    ) {
      matchedTeams.add(entry.teamName);
    }
  }

  const teams = [...matchedTeams].sort((a, b) => a.localeCompare(b));
  if (teams.length === 1) {
    return teams[0];
  }
  return '';
}

export async function enrichEntriesWithTeam(entries, eventId, context = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return entries;
  }

  // Determine the club source from the class-type policy. With no context (or a
  // rider-primary field mode) the policy resolves to the default Sport_Tolt
  // behavior, so the rider-club resolution path below is preserved unchanged.
  const policy = getClassTypePolicy(context?.classType);
  const useHorseClub =
    policy.fieldMode === 'competitor-horse' || policy.clubSource === 'horse';

  // Competitor-horse mode (adult quality classes): feed `Lid` from the horse's
  // registered club taken directly from the Sportfengur entry, not the rider's
  // roster team. Missing horse club → empty string; never throws.
  if (useHorseClub) {
    return entries.map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return entry;
      }

      const horseClub = resolveHorseClub(entry);
      return {
        ...entry,
        lid: horseClub,
        Lid: horseClub,
        team_name: horseClub,
      };
    });
  }

  if (!isDbConfigured()) {
    return entries;
  }

  try {
    await loadRosterCache(false);
  } catch (error) {
    console.warn(`Failed to load roster cache: ${error.message}`);
    return entries;
  }

  const leagueKey = resolveLeagueKeyForEvent(eventId);
  if (!leagueKey) {
    return entries;
  }

  return entries.map((entry) => {
    if (!entry || typeof entry !== 'object') {
      return entry;
    }

    const riderName = extractRiderName(entry);
    if (!riderName) {
      return entry;
    }

    const teamName = resolveTeamNameForRider(leagueKey, riderName);
    if (!teamName) {
      return entry;
    }

    return {
      ...entry,
      lid: teamName,
      Lid: teamName,
      team_name: teamName,
    };
  });
}

/**
 * Ordered list of candidate Sportfengur entry keys that may carry the horse's
 * IS registration number (FEIF/origin number) used to look the horse up in
 * Worldfengur. The exact field is not confirmed against live data, so the
 * resolver tries each key in order. `faedingarnumer` is the horse's
 * birth/origin number already read elsewhere in the normalizer, so it is the
 * primary candidate. Falls back through explicit IS-number keys and defaults to
 * an empty string when none is present.
 */
const IS_NUMBER_CANDIDATE_KEYS = [
  'faedingarnumer',
  'hross_faedingarnumer',
  'hross_numer',
  'is_numer',
  'isnumer',
  'isNumber',
  'ISNumber',
];

/**
 * The Worldfengur-sourced breeding-show fields, each defaulting to an empty
 * string. Spread onto an entry when no Worldfengur record is available so the
 * fields degrade to empty while any Sportfengur-sourced entry data is
 * preserved (Requirements 12.1, 12.6).
 */
const EMPTY_BREEDING_FIELDS = Object.freeze({
  ISNumber: '',
  horseName: '',
  origin: '',
  riderName: '',
  dam: '',
  sire: '',
  conformationScore: '',
  supplementaryText: '',
  owner: '',
  breeder: '',
});

/**
 * Coerce a possibly-null/undefined value to a trimmed-free string, emitting an
 * empty string when the source value is unavailable.
 *
 * @param {*} value
 * @returns {string}
 */
function toText(value) {
  return value == null ? '' : String(value);
}

/**
 * Resolve the horse's IS registration number from an entry using the ordered
 * candidate keys. Returns the first non-empty value (coerced to a trimmed
 * string), or an empty string when none is present. Never throws.
 *
 * @param {Record<string, unknown>} entry
 * @returns {string}
 */
function resolveISNumber(entry) {
  for (const key of IS_NUMBER_CANDIDATE_KEYS) {
    const value = entry?.[key];
    if (value !== undefined && value !== null) {
      const text = String(value).trim();
      if (text !== '') {
        return text;
      }
    }
  }
  return '';
}

/**
 * Remove all ownership percentage tokens (e.g. "50%", "50 %", "33.3 %") from an
 * owner value, retaining the owner names only (Requirement 12.4). Leftover
 * separators and whitespace introduced by the removal are tidied so the result
 * reads as a clean list of names. Never throws.
 *
 * @param {*} value
 * @returns {string}
 */
function stripOwnerPercentages(value) {
  if (value == null) {
    return '';
  }
  return (
    String(value)
      // Drop any number (optional decimal separator) followed by optional
      // whitespace and a percent sign.
      .replace(/\d+(?:[.,]\d+)?\s*%/g, ' ')
      // Normalize spacing around common name separators.
      .replace(/\s*([,;/])\s*/g, '$1 ')
      // Collapse whitespace runs.
      .replace(/\s+/g, ' ')
      // Trim dangling separators left behind by removed tokens.
      .replace(/\s*[,;/]\s*$/g, '')
      .replace(/^\s*[,;/]\s*/g, '')
      .trim()
  );
}

/**
 * Build the breeding-show fields for an entry from a Worldfengur BreedingRecord.
 * Each field is emitted as text, defaulting to an empty string when its source
 * value is unavailable. The conformation score is formatted with the literal
 * `"Sköpulag: "` prefix followed by the score at two decimals (Requirement
 * 12.2), and emitted empty when the score is non-numeric/unavailable. The owner
 * value has all percentage tokens stripped (Requirement 12.4).
 *
 * @param {import('./worldfengur.js').BreedingRecord} record
 * @returns {typeof EMPTY_BREEDING_FIELDS}
 */
function buildBreedingFields(record) {
  const formattedScore = formatDecimals(record.conformationScore, 2);
  return {
    ISNumber: toText(record.ISNumber),
    horseName: toText(record.horseName),
    origin: toText(record.origin),
    riderName: toText(record.riderName),
    dam: toText(record.dam),
    sire: toText(record.sire),
    conformationScore:
      formattedScore === '' ? '' : `Sköpulag: ${formattedScore}`,
    supplementaryText: toText(record.supplementaryText),
    owner: stripOwnerPercentages(record.owner),
    breeder: toText(record.breeder),
  };
}

/**
 * Enrich breeding-show entries with pedigree and conformation data from the
 * Worldfengur provider.
 *
 * For each entry the horse's IS registration number is resolved from the entry
 * and looked up via `getBreedingRecord`. When a record is returned, the
 * breeding fields are attached to the entry (Requirements 12.1, 12.2, 12.3,
 * 12.4, 12.5). When the provider is unconfigured or returns `null` (or a source
 * field is unavailable), the Worldfengur-sourced fields degrade to empty
 * strings while any Sportfengur-sourced entry data already present is preserved
 * unchanged (Requirement 12.6).
 *
 * Never throws: the provider swallows its own errors and returns `null`, and
 * non-object entries pass through unchanged.
 *
 * @param {Array<Record<string, unknown>>} entries
 * @param {{ classType?: string }} [context]
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function enrichBreedingShow(entries, context = {}) {
  void context;
  if (!Array.isArray(entries) || entries.length === 0) {
    return entries;
  }

  const enriched = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      enriched.push(entry);
      continue;
    }

    const isNumber = resolveISNumber(entry);
    let record = null;
    try {
      record = await getBreedingRecord(isNumber);
    } catch {
      // Defensive: the provider is contracted never to throw, but guard so a
      // single lookup can never fail the whole roster.
      record = null;
    }

    const breedingFields = record
      ? buildBreedingFields(record)
      : EMPTY_BREEDING_FIELDS;

    enriched.push({ ...entry, ...breedingFields });
  }

  return enriched;
}
