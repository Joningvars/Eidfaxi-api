import { getEventIdFilter } from '../config.js';
import { initializeEventState, removeEventState } from './state.js';
import { cancelRefreshesForEvent } from './refresh.js';

/**
 * Maximum number of active events allowed per instance.
 */
export const MAX_ACTIVE_EVENTS = 10;

/**
 * Internal registry: Map<eventId, { eventId, addedAt }>
 */
const activeEvents = new Map();

/**
 * Register a new event in the registry.
 * Validates that eventId is a positive integer, enforces the 10-event cap,
 * and ignores duplicates (returns existing entry).
 *
 * @param {number} eventId - Positive integer event identifier
 * @param {string} [name] - Optional event name for display purposes
 * @returns {{ eventId: number, addedAt: string, name: string }} The registered event entry
 * @throws {Error} If eventId is invalid or registry is at capacity
 */
export function registerEvent(eventId, name) {
  const parsed = Number(eventId);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid eventId: must be a positive integer, got ${JSON.stringify(eventId)}`,
    );
  }

  // Idempotent: return existing entry (update name if provided)
  if (activeEvents.has(parsed)) {
    const existing = activeEvents.get(parsed);
    if (name && !existing.name) {
      existing.name = String(name);
    }
    return existing;
  }

  if (activeEvents.size >= MAX_ACTIVE_EVENTS) {
    throw new Error(
      `Cannot register event ${parsed}: maximum of ${MAX_ACTIVE_EVENTS} active events reached`,
    );
  }

  const entry = {
    eventId: parsed,
    addedAt: new Date().toISOString(),
    name: name ? String(name) : '',
  };
  activeEvents.set(parsed, entry);
  initializeEventState(parsed);
  return entry;
}

/**
 * Remove an event from the registry.
 * Cleans up associated state and cancels pending refreshes.
 *
 * @param {number} eventId - The event to remove
 * @returns {boolean} true if the event was removed, false if it wasn't registered
 */
export function removeEvent(eventId) {
  const parsed = Number(eventId);
  if (!activeEvents.has(parsed)) {
    return false;
  }
  activeEvents.delete(parsed);
  removeEventState(parsed);
  cancelRefreshesForEvent(parsed);
  return true;
}

/**
 * Get all active events ordered by registration time.
 *
 * @returns {Array<{ eventId: number, addedAt: string }>}
 */
export function getActiveEvents() {
  return Array.from(activeEvents.values());
}

/**
 * Check if a specific event is currently active.
 *
 * @param {number} eventId
 * @returns {boolean}
 */
export function isEventActive(eventId) {
  return activeEvents.has(Number(eventId));
}

/**
 * Get the number of currently active events.
 *
 * @returns {number}
 */
export function getEventCount() {
  return activeEvents.size;
}

/**
 * Resolve the default event for legacy route resolution.
 *
 * Resolution order:
 * 1. If exactly one event is active, return that event's id
 * 2. If eventIdFilter is configured and that event is active, return it
 * 3. Otherwise return null (ambiguous)
 *
 * @returns {number|null}
 */
export function getDefaultEventId() {
  if (activeEvents.size === 1) {
    return activeEvents.values().next().value.eventId;
  }

  const filterValue = getEventIdFilter();
  if (filterValue !== null && activeEvents.has(filterValue)) {
    return filterValue;
  }

  return null;
}

/**
 * Clear all events from the registry. Used for testing.
 */
export function clearRegistry() {
  activeEvents.clear();
}
