import { ROSTER_CACHE_TTL_MS } from './config.js';
import { isDbConfigured, queryDb } from './db/client.js';

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

export async function enrichEntriesWithTeam(entries, eventId) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return entries;
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
