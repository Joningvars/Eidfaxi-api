import { fetchLeaderboard } from './vendor.js';
import { normalizeLeaderboard } from './normalizer.js';
import { updateState, updateEventState } from './state.js';
import { persistEventSlot } from './event-registry.js';
import { log } from '../logger.js';

const DEBOUNCE_MS = Number(process.env.VMIX_DEBOUNCE_MS || 200);
const REFRESH_TIMEOUT_MS = Number(process.env.VMIX_REFRESH_TIMEOUT_MS || 30000);

/**
 * Maximum number of concurrent refresh operations allowed.
 */
export const MAX_CONCURRENT_REFRESHES = 5;

/**
 * Per-slot refresh tracking.
 * Map<string, RefreshSlot> where key = `${eventId}:${competitionId}`
 *
 * RefreshSlot = {
 *   inProgress: boolean,
 *   timer: NodeJS.Timeout | null,
 *   lastRefreshAt: string | null,
 *   lastError: string | null,
 * }
 */
const refreshSlots = new Map();

// --- Legacy state (backward compatibility) ---
let refreshTimer = null;
let refreshInProgress = false;
let pendingRefreshTimestamp = null;

let competitionContext = {
  eventId: null,
  classId: null,
  competitionId: null,
  forceRefresh: false,
};

// --- Helper functions ---

/**
 * Build the slot key for a given (eventId, competitionId) pair.
 */
function slotKey(eventId, competitionId) {
  return `${eventId}:${competitionId}`;
}

/**
 * Get or create a refresh slot for the given key.
 */
function getOrCreateSlot(key) {
  if (!refreshSlots.has(key)) {
    refreshSlots.set(key, {
      inProgress: false,
      timer: null,
      lastRefreshAt: null,
      lastError: null,
    });
  }
  return refreshSlots.get(key);
}

// --- Multi-event refresh API ---

/**
 * Get the number of currently in-progress refreshes.
 *
 * @returns {number} Count of active refreshes (0 to MAX_CONCURRENT_REFRESHES)
 */
export function getActiveRefreshCount() {
  let count = 0;
  for (const slot of refreshSlots.values()) {
    if (slot.inProgress) count++;
  }
  return count;
}

/**
 * Check if a refresh is in progress for a specific (eventId, competitionId) pair.
 * When called with no arguments, returns the legacy refreshInProgress flag.
 *
 * @param {number} [eventId] - The event identifier
 * @param {number} [competitionId] - The competition identifier
 * @returns {boolean}
 */
export function isRefreshInProgress(eventId, competitionId) {
  // Legacy behavior: no arguments returns the old boolean
  if (eventId === undefined && competitionId === undefined) {
    return refreshInProgress;
  }

  const key = slotKey(eventId, competitionId);
  const slot = refreshSlots.get(key);
  return slot ? slot.inProgress : false;
}

/**
 * Refresh a specific competition immediately.
 * Checks concurrency limits and rejects duplicates.
 *
 * @param {number} eventId - The event identifier
 * @param {number} classId - The class identifier
 * @param {number} competitionId - The competition slot (1, 2, or 3)
 * @param {boolean} [forceRefresh=true] - Whether to force a cache refresh
 * @returns {Promise<Array>} The normalized leaderboard data
 * @throws {Error} If a refresh is already in progress for this slot or concurrency limit reached
 */
export async function refreshCompetitionNow(
  eventId,
  classId,
  competitionId,
  forceRefresh = true,
) {
  const key = slotKey(eventId, competitionId);
  const slot = getOrCreateSlot(key);

  // Check if refresh already in progress for this slot
  if (slot.inProgress) {
    throw new Error(
      `Refresh already in progress for event ${eventId}, competition ${competitionId}`,
    );
  }

  // Check concurrency limit
  if (getActiveRefreshCount() >= MAX_CONCURRENT_REFRESHES) {
    throw new Error(
      `Concurrency limit reached: ${MAX_CONCURRENT_REFRESHES} refreshes already in progress`,
    );
  }

  // Mark slot as in-progress
  slot.inProgress = true;

  try {
    log.vmix.fetching(classId, competitionId, forceRefresh);

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error('Refresh timeout')),
        REFRESH_TIMEOUT_MS,
      );
    });

    const fetchPromise = fetchLeaderboard(
      eventId,
      classId,
      competitionId,
      forceRefresh,
    );

    const leaderboardData = await Promise.race([fetchPromise, timeoutPromise]);
    const normalizedLeaderboard = normalizeLeaderboard(leaderboardData);
    log.vmix.normalized(normalizedLeaderboard.length);

    // Update per-event state
    updateEventState(eventId, competitionId, normalizedLeaderboard, classId);

    // Also update legacy state for backward compatibility
    updateState(normalizedLeaderboard, eventId, classId, competitionId);

    // Persist the updated classId so it survives a restart (best-effort)
    persistEventSlot(eventId);

    // Update slot metadata
    slot.lastRefreshAt = new Date().toISOString();
    slot.lastError = null;

    return normalizedLeaderboard;
  } catch (error) {
    // Preserve existing state on failure — don't update state store
    slot.lastError = error.message;
    throw error;
  } finally {
    slot.inProgress = false;
  }
}

/**
 * Schedule a debounced refresh for a specific event/competition.
 * If a timer is already pending for this slot, it is reset.
 *
 * @param {number} eventId - The event identifier
 * @param {number} classId - The class identifier
 * @param {number} competitionId - The competition slot (1, 2, or 3)
 * @param {boolean} [forceRefresh=false] - Whether to force a cache refresh
 */
export function scheduleRefreshForEvent(
  eventId,
  classId,
  competitionId,
  forceRefresh = false,
) {
  const key = slotKey(eventId, competitionId);
  const slot = getOrCreateSlot(key);

  // Clear existing timer for this slot
  if (slot.timer) {
    clearTimeout(slot.timer);
    slot.timer = null;
  }

  // Schedule new debounced refresh
  slot.timer = setTimeout(async () => {
    slot.timer = null;

    // Skip if already in progress for this slot
    if (slot.inProgress) {
      log.vmix.skipped();
      return;
    }

    try {
      await refreshCompetitionNow(
        eventId,
        classId,
        competitionId,
        forceRefresh,
      );
      log.vmix.updated();
    } catch (error) {
      log.error('vMix refresh', error);
    }
  }, DEBOUNCE_MS);
}

/**
 * Cancel all pending and in-progress refreshes for a given eventId.
 * Used for cleanup when an event is removed from the registry.
 *
 * @param {number} eventId - The event identifier to cancel refreshes for
 */
export function cancelRefreshesForEvent(eventId) {
  const prefix = `${eventId}:`;
  for (const [key, slot] of refreshSlots) {
    if (key.startsWith(prefix)) {
      if (slot.timer) {
        clearTimeout(slot.timer);
        slot.timer = null;
      }
      refreshSlots.delete(key);
    }
  }
}

// --- Legacy API (backward compatibility) ---

/**
 * Set the competition context for legacy scheduled refreshes.
 * Delegates to scheduleRefreshForEvent when valid context is provided.
 */
export function setCompetitionContext(
  eventId,
  classId,
  competitionId,
  forceRefresh = false,
) {
  competitionContext = { eventId, classId, competitionId, forceRefresh };
}

/**
 * Schedule a refresh using the legacy competition context.
 * Delegates to scheduleRefreshForEvent if context is available.
 */
export function scheduleRefresh() {
  pendingRefreshTimestamp = Date.now();

  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }

  refreshTimer = setTimeout(() => {
    executeRefresh();
  }, DEBOUNCE_MS);
}

/**
 * Reset all refresh state. Used for testing.
 */
export function _resetRefreshState() {
  // Clear legacy state
  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }
  refreshTimer = null;
  refreshInProgress = false;
  pendingRefreshTimestamp = null;

  // Clear per-event slots
  for (const slot of refreshSlots.values()) {
    if (slot.timer) {
      clearTimeout(slot.timer);
    }
  }
  refreshSlots.clear();
}

// --- Legacy internal implementation ---

async function executeRefresh() {
  if (refreshInProgress) {
    log.vmix.skipped();
    return;
  }

  refreshInProgress = true;
  refreshTimer = null;

  try {
    const { eventId, classId, competitionId } = competitionContext;

    if (!classId || !competitionId) {
      log.vmix.noContext();
      return;
    }

    log.vmix.starting(eventId, classId, competitionId);

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error('Refresh timeout')),
        REFRESH_TIMEOUT_MS,
      );
    });

    await Promise.race([refreshWithTimeout(), timeoutPromise]);

    log.vmix.updated();
  } catch (error) {
    log.error('vMix refresh', error);
  } finally {
    refreshInProgress = false;

    const timeSinceLastSchedule = pendingRefreshTimestamp
      ? Date.now() - pendingRefreshTimestamp
      : Infinity;

    if (timeSinceLastSchedule >= DEBOUNCE_MS) {
      pendingRefreshTimestamp = null;
    }
  }
}

async function refreshWithTimeout() {
  const { eventId, classId, competitionId, forceRefresh } = competitionContext;
  log.vmix.fetching(classId, competitionId, forceRefresh);
  const leaderboardData = await fetchLeaderboard(
    eventId,
    classId,
    competitionId,
    forceRefresh,
  );
  const normalizedLeaderboard = normalizeLeaderboard(leaderboardData);
  log.vmix.normalized(normalizedLeaderboard.length);
  updateState(normalizedLeaderboard, eventId, classId, competitionId);
  return normalizedLeaderboard;
}
