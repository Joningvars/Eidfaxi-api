import { getEventIdFilter } from '../config.js';
import { initializeEventState, removeEventState, setEventClassId, getEventCompetitionClassIds } from './state.js';
import { cancelRefreshesForEvent } from './refresh.js';
import { saveAllSlots, saveSlot, loadSlots } from './slot-store.js';

/**
 * Maximum number of active events allowed per instance.
 */
export const MAX_ACTIVE_EVENTS = 10;

/**
 * Internal registry: Map<eventId, { eventId, addedAt }>
 */
const activeEvents = new Map();

/**
 * Build a snapshot of all slots for persistence.
 */
function snapshotSlots() {
  return Array.from(activeEvents.values()).map((entry, index) => ({
    eventId: entry.eventId,
    slotOrder: index + 1,
    label: entry.label || '',
    name: entry.name || '',
    allowedClassId: entry.allowedClassId ?? null,
    classIds: getEventCompetitionClassIds(entry.eventId),
  }));
}

/**
 * Persist the current registry state (fire-and-forget, best-effort).
 */
function persist() {
  saveAllSlots(snapshotSlots()).catch(() => {
    // best-effort: persistence failures don't break the in-memory registry
  });
}

/**
 * Hydrate the registry from the database on startup.
 * Restores slots, labels, names, and classId gates from the last session.
 *
 * @returns {Promise<number>} The number of slots restored
 */
export async function hydrateFromStore() {
  const slots = await loadSlots();
  if (slots.length === 0) return 0;

  activeEvents.clear();
  for (const slot of slots) {
    activeEvents.set(slot.eventId, {
      eventId: slot.eventId,
      addedAt: new Date().toISOString(),
      name: slot.name || '',
      label: slot.label || '',
      allowedClassId: slot.allowedClassId ?? null,
    });
    initializeEventState(slot.eventId);
    // Restore per-competition classIds from DB
    const classIds = slot.classIds || {};
    for (const [compId, classId] of Object.entries(classIds)) {
      const parsed = Number(classId);
      if (Number.isInteger(parsed) && parsed > 0) {
        setEventClassId(slot.eventId, Number(compId), parsed);
      }
    }
  }
  return slots.length;
}

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
    label: '',
  };
  activeEvents.set(parsed, entry);
  initializeEventState(parsed);
  persist();
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
  persist();
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
 * Resolve an eventId from either a real eventId or a slot number (1-10).
 * Slot numbers are assigned by registration order.
 *
 * @param {number} idOrSlot - Either a real eventId (large number) or slot number (1-10)
 * @returns {number|null} The resolved eventId, or null if not found
 */
export function resolveEventId(idOrSlot) {
  const parsed = Number(idOrSlot);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;

  // If it's a real eventId in the registry, return it directly
  if (activeEvents.has(parsed)) {
    return parsed;
  }

  // If it's a slot number (1-10), resolve by position
  if (parsed >= 1 && parsed <= MAX_ACTIVE_EVENTS) {
    const events = Array.from(activeEvents.values());
    if (parsed <= events.length) {
      return events[parsed - 1].eventId;
    }
  }

  return null;
}

/**
 * Get all active events with their slot numbers.
 *
 * @returns {Array<{ eventId: number, slot: number, addedAt: string, name: string }>}
 */
export function getActiveEventsWithSlots() {
  return Array.from(activeEvents.values()).map((entry, index) => ({
    ...entry,
    slot: index + 1,
  }));
}

/**
 * Clear all events from the registry. Used for testing.
 */
export function clearRegistry() {
  activeEvents.clear();
}

/**
 * Update the label (display name) for a registered event's slot.
 *
 * @param {number} eventId - The event to update
 * @param {string} label - The new label (e.g. "Bíll 1")
 * @returns {boolean} true if updated, false if event not found
 */
export function updateEventLabel(eventId, label) {
  const parsed = Number(eventId);
  if (!activeEvents.has(parsed)) return false;
  activeEvents.get(parsed).label = String(label || '');
  persist();
  return true;
}

/**
 * Set the allowed classId for gating webhooks on a specific event.
 * Only webhooks matching this classId will trigger a refresh for this event.
 * Set to null to allow all classIds.
 *
 * @param {number} eventId
 * @param {number|null} classId
 * @returns {boolean}
 */
export function setEventClassIdGate(eventId, classId) {
  const parsed = Number(eventId);
  if (!activeEvents.has(parsed)) return false;
  activeEvents.get(parsed).allowedClassId =
    classId === null ? null : Number(classId);
  persist();
  return true;
}

/**
 * Persist the current slot state (including competition classIds) for a single event.
 * Call this after updating competition classIds via setEventClassId/updateEventState.
 *
 * @param {number} eventId
 */
export function persistEventSlot(eventId) {
  const parsed = Number(eventId);
  const entry = activeEvents.get(parsed);
  if (!entry) return;
  const index = Array.from(activeEvents.keys()).indexOf(parsed);
  saveSlot({
    eventId: parsed,
    slotOrder: index + 1,
    label: entry.label || '',
    name: entry.name || '',
    allowedClassId: entry.allowedClassId ?? null,
    classIds: getEventCompetitionClassIds(parsed),
  }).catch(() => {
    // best-effort
  });
}

/**
 * Get the allowed classId gate for a specific event.
 *
 * @param {number} eventId
 * @returns {number|null}
 */
export function getEventClassIdGate(eventId) {
  const parsed = Number(eventId);
  if (!activeEvents.has(parsed)) return null;
  return activeEvents.get(parsed).allowedClassId ?? null;
}

/**
 * Replace the event on a slot with a new event, keeping the slot position and label.
 * Cleans up old event state and initializes new event state.
 *
 * @param {number} oldEventId - The current event to replace
 * @param {number} newEventId - The new event to put in its place
 * @param {string} [newName] - Optional name for the new event
 * @returns {{ eventId: number, addedAt: string, name: string, label: string }} The new entry
 * @throws {Error} If oldEventId not found or newEventId invalid
 */
export function replaceEvent(oldEventId, newEventId, newName) {
  const oldParsed = Number(oldEventId);
  const newParsed = Number(newEventId);

  if (!activeEvents.has(oldParsed)) {
    throw new Error(`Event ${oldEventId} is not registered`);
  }
  if (!Number.isInteger(newParsed) || newParsed <= 0) {
    throw new Error(`Invalid new eventId: must be a positive integer`);
  }
  if (activeEvents.has(newParsed) && newParsed !== oldParsed) {
    throw new Error(`Event ${newParsed} is already registered in another slot`);
  }

  const oldEntry = activeEvents.get(oldParsed);
  const label = oldEntry.label;

  // Rebuild map preserving order, swapping old for new
  const entries = Array.from(activeEvents.entries());
  activeEvents.clear();

  const newEntry = {
    eventId: newParsed,
    addedAt: new Date().toISOString(),
    name: newName ? String(newName) : '',
    label,
  };

  for (const [key, value] of entries) {
    if (key === oldParsed) {
      activeEvents.set(newParsed, newEntry);
    } else {
      activeEvents.set(key, value);
    }
  }

  // Clean up old, initialize new
  removeEventState(oldParsed);
  cancelRefreshesForEvent(oldParsed);
  initializeEventState(newParsed);
  persist();

  return newEntry;
}
