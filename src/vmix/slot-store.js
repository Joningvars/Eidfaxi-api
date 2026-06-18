import { queryDb, isDbConfigured } from '../db/client.js';
import { log } from '../logger.js';

/**
 * Persistence layer for vMix event slots.
 *
 * Stores the event registry (slots, labels, names, classId gates) in Postgres
 * so that a server restart / deploy does not lose the operator's configuration.
 *
 * All writes are best-effort: if the DB is not configured or a write fails,
 * the in-memory registry continues to work — we just lose persistence.
 */

/**
 * Persist (upsert) a single slot to the database.
 *
 * @param {{ eventId: number, slotOrder: number, label?: string, name?: string, allowedClassId?: number|null }} slot
 */
export async function saveSlot(slot) {
  if (!isDbConfigured()) return;
  try {
    await queryDb(
      `INSERT INTO vmix_event_slots (event_id, slot_order, label, name, allowed_class_id, class_ids, login_username, login_password, source_event_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
       ON CONFLICT (event_id) DO UPDATE SET
         slot_order = EXCLUDED.slot_order,
         label = EXCLUDED.label,
         name = EXCLUDED.name,
         allowed_class_id = EXCLUDED.allowed_class_id,
         class_ids = EXCLUDED.class_ids,
         login_username = EXCLUDED.login_username,
         login_password = EXCLUDED.login_password,
         source_event_id = EXCLUDED.source_event_id,
         updated_at = NOW()`,
      [
        slot.eventId,
        slot.slotOrder,
        slot.label || '',
        slot.name || '',
        slot.allowedClassId ?? null,
        JSON.stringify(slot.classIds ?? {}),
        slot.loginUsername ?? null,
        slot.loginPassword ?? null,
        slot.sourceEventId ?? slot.eventId,
      ],
    );
  } catch (error) {
    log.error('slot-store saveSlot', error);
  }
}

/**
 * Remove a slot from the database.
 *
 * @param {number} eventId
 */
export async function deleteSlot(eventId) {
  if (!isDbConfigured()) return;
  try {
    await queryDb('DELETE FROM vmix_event_slots WHERE event_id = $1', [
      eventId,
    ]);
  } catch (error) {
    log.error('slot-store deleteSlot', error);
  }
}

/**
 * Persist the full ordered list of slots, replacing the table contents.
 * Used after operations that reorder slots (e.g. replace).
 *
 * @param {Array<{ eventId: number, slotOrder: number, label?: string, name?: string, allowedClassId?: number|null }>} slots
 */
export async function saveAllSlots(slots) {
  if (!isDbConfigured()) return;
  try {
    await queryDb('BEGIN');
    await queryDb('DELETE FROM vmix_event_slots');
    for (const slot of slots) {
      await queryDb(
        `INSERT INTO vmix_event_slots (event_id, slot_order, label, name, allowed_class_id, class_ids, login_username, login_password, source_event_id, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
        [
          slot.eventId,
          slot.slotOrder,
          slot.label || '',
          slot.name || '',
          slot.allowedClassId ?? null,
          JSON.stringify(slot.classIds ?? {}),
          slot.loginUsername ?? null,
          slot.loginPassword ?? null,
          slot.sourceEventId ?? slot.eventId,
        ],
      );
    }
    await queryDb('COMMIT');
  } catch (error) {
    try {
      await queryDb('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    log.error('slot-store saveAllSlots', error);
  }
}

/**
 * Load all persisted slots, ordered by slot_order.
 *
 * @returns {Promise<Array<{ eventId: number, slotOrder: number, label: string, name: string, allowedClassId: number|null }>>}
 */
export async function loadSlots() {
  if (!isDbConfigured()) return [];
  try {
    const result = await queryDb(
      `SELECT event_id, slot_order, label, name, allowed_class_id, class_ids, login_username, login_password, source_event_id
       FROM vmix_event_slots
       ORDER BY slot_order ASC`,
    );
    return result.rows.map((row) => {
      let classIds = {};
      if (row.class_ids) {
        try {
          classIds =
            typeof row.class_ids === 'string'
              ? JSON.parse(row.class_ids)
              : row.class_ids;
        } catch {
          classIds = {};
        }
      }
      return {
        eventId: Number(row.event_id),
        slotOrder: Number(row.slot_order),
        label: row.label || '',
        name: row.name || '',
        allowedClassId:
          row.allowed_class_id == null ? null : Number(row.allowed_class_id),
        classIds,
        loginUsername: row.login_username || null,
        loginPassword: row.login_password || null,
        sourceEventId:
          row.source_event_id == null
            ? Number(row.event_id)
            : Number(row.source_event_id),
      };
    });
  } catch (error) {
    log.error('slot-store loadSlots', error);
    return [];
  }
}
