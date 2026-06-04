import { getDefaultEventId } from './event-registry.js';

/**
 * Per-event state store using Map<eventId, EventState>
 *
 * EventState = {
 *   competitions: {
 *     1: { leaderboard: [], classId: null },
 *     2: { leaderboard: [], classId: null },
 *     3: { leaderboard: [], classId: null },
 *   }
 * }
 */
const eventStates = new Map();

// Legacy tracking variables for backward compatibility
let currentCompetitionId = null;
let currentEventId = null;
let currentClassId = null;

/**
 * Create a fresh EventState with empty competition slots.
 */
function createEmptyEventState() {
  return {
    competitions: {
      1: { leaderboard: [], classId: null },
      2: { leaderboard: [], classId: null },
      3: { leaderboard: [], classId: null },
    },
  };
}

// --- Multi-event API ---

/**
 * Initialize an empty EventState for the given eventId.
 * If the event already has state, this is a no-op.
 *
 * @param {number} eventId - Positive integer event identifier
 */
export function initializeEventState(eventId) {
  const id = Number(eventId);
  if (!eventStates.has(id)) {
    eventStates.set(id, createEmptyEventState());
  }
}

/**
 * Remove the EventState for the given eventId.
 *
 * @param {number} eventId
 * @returns {boolean} true if state was removed, false if it didn't exist
 */
export function removeEventState(eventId) {
  return eventStates.delete(Number(eventId));
}

/**
 * Get the EventState for a given eventId.
 *
 * @param {number} eventId
 * @returns {object|null} The EventState or null if not found
 */
export function getEventState(eventId) {
  return eventStates.get(Number(eventId)) || null;
}

/**
 * Get the leaderboard array for a specific event and competition.
 *
 * @param {number} eventId
 * @param {number} competitionId - 1, 2, or 3
 * @returns {Array} The leaderboard array (empty if not found)
 */
export function getLeaderboardForEvent(eventId, competitionId) {
  const state = eventStates.get(Number(eventId));
  if (!state || !state.competitions[competitionId]) {
    return [];
  }
  return state.competitions[competitionId].leaderboard;
}

/**
 * Update the leaderboard for a specific event and competition.
 * Auto-creates EventState if not present (Req 1.5).
 *
 * @param {number} eventId
 * @param {number} competitionId - 1, 2, or 3
 * @param {Array} leaderboard - The leaderboard data
 * @param {number|null} classId - The class identifier
 */
export function updateEventState(eventId, competitionId, leaderboard, classId) {
  const id = Number(eventId);

  // Auto-create EventState if not present
  if (!eventStates.has(id)) {
    eventStates.set(id, createEmptyEventState());
  }

  const state = eventStates.get(id);
  if (state.competitions[competitionId]) {
    state.competitions[competitionId] = { leaderboard, classId };
  }
}

/**
 * Set the classId for a specific competition slot without overwriting leaderboard data.
 *
 * @param {number} eventId
 * @param {number} competitionId
 * @param {number} classId
 */
export function setEventClassId(eventId, competitionId, classId) {
  const id = Number(eventId);
  if (!eventStates.has(id)) {
    eventStates.set(id, createEmptyEventState());
  }
  const state = eventStates.get(id);
  if (state.competitions[competitionId]) {
    state.competitions[competitionId].classId = classId;
  }
}

/**
 * Get the competition classIds for a given event as a plain object.
 * Returns { "1": classId|null, "2": classId|null, "3": classId|null }
 *
 * @param {number} eventId
 * @returns {Object}
 */
export function getEventCompetitionClassIds(eventId) {
  const state = eventStates.get(Number(eventId));
  if (!state) return { 1: null, 2: null, 3: null };
  return {
    1: state.competitions[1]?.classId ?? null,
    2: state.competitions[2]?.classId ?? null,
    3: state.competitions[3]?.classId ?? null,
  };
}

/**
 * Get metadata for all events in the state store.
 *
 * @returns {Array<{ eventId: number, competitions: object }>}
 */
export function getAllEventsMetadata() {
  const result = [];
  for (const [eventId, state] of eventStates) {
    const competitions = {};
    for (const [compId, compState] of Object.entries(state.competitions)) {
      competitions[compId] = {
        classId: compState.classId,
        leaderboardCount: compState.leaderboard.length,
      };
    }
    result.push({ eventId, competitions });
  }
  return result;
}

// --- Legacy compatibility functions ---
// These delegate to the default event via getDefaultEventId()

/**
 * Initialize state — clears all event states and resets legacy tracking.
 * Kept for backward compatibility.
 */
export function initializeState() {
  eventStates.clear();
  currentCompetitionId = null;
  currentEventId = null;
  currentClassId = null;
}

/**
 * Get the current leaderboard (legacy).
 * Returns the leaderboard for the current competition of the default event.
 *
 * @returns {Array} The current leaderboard or empty array
 */
export function getCurrentState() {
  const defaultId = getDefaultEventId();
  if (defaultId === null) {
    // Fallback: use legacy tracking
    if (currentEventId && currentCompetitionId) {
      return getLeaderboardForEvent(currentEventId, currentCompetitionId);
    }
    return [];
  }
  if (currentCompetitionId) {
    return getLeaderboardForEvent(defaultId, currentCompetitionId);
  }
  return [];
}

/**
 * Get leaderboard state for a competition (legacy).
 * Delegates to the default event.
 *
 * @param {number|null} competitionId - Competition to get, or current if null
 * @returns {Array} The leaderboard array
 */
export function getLeaderboardState(competitionId = null) {
  const compId = competitionId || currentCompetitionId;
  const defaultId = getDefaultEventId();
  const eventId = defaultId !== null ? defaultId : currentEventId;

  if (eventId && compId) {
    return getLeaderboardForEvent(eventId, compId);
  }
  return [];
}

/**
 * Get competition metadata (legacy).
 *
 * @returns {{ eventId: number|null, classId: number|null, competitionId: number|null }}
 */
export function getCompetitionMetadata() {
  return {
    eventId: currentEventId,
    classId: currentClassId,
    competitionId: currentCompetitionId,
  };
}

/**
 * Get metadata for a specific competition slot (legacy).
 *
 * @param {number} competitionId
 * @returns {{ eventId: number|null, classId: number|null, competitionId: number|null }}
 */
export function getCompetitionSpecificMetadata(competitionId) {
  const defaultId = getDefaultEventId();
  const eventId = defaultId !== null ? defaultId : currentEventId;

  if (eventId) {
    const state = eventStates.get(Number(eventId));
    if (state && state.competitions[competitionId]) {
      return {
        eventId: eventId,
        classId: state.competitions[competitionId].classId,
        competitionId: competitionId,
      };
    }
  }

  return {
    eventId: null,
    classId: null,
    competitionId: null,
  };
}

/**
 * Update state (legacy).
 * Auto-creates EventState if not present and updates legacy tracking variables.
 *
 * @param {Array} newLeaderboard - The leaderboard data
 * @param {number} eventId - The event identifier
 * @param {number} classId - The class identifier
 * @param {number} competitionId - The competition slot (1, 2, or 3)
 */
export function updateState(newLeaderboard, eventId, classId, competitionId) {
  // Update the per-event state (auto-creates if needed)
  updateEventState(eventId, competitionId, newLeaderboard, classId);

  // Update legacy tracking variables
  currentCompetitionId = competitionId;
  currentEventId = eventId;
  currentClassId = classId;
}
