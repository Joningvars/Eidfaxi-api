import dotenv from 'dotenv';

dotenv.config();

export const WEBHOOK_SECRET = process.env.SPORTFENGUR_WEBHOOK_SECRET || '';
export const WEBHOOK_SECRET_REQUIRED = true;
export const SPORTFENGUR_BASE_URL =
  process.env.SPORTFENGUR_BASE_URL || 'https://sportfengur.com/api/v1';
export const SPORTFENGUR_LOCALE = process.env.SPORTFENGUR_LOCALE || 'is';
export const SPORTFENGUR_USERNAME = process.env.EIDFAXI_USERNAME || '';
export const SPORTFENGUR_PASSWORD = process.env.EIDFAXI_PASSWORD || '';
export const DEDUPE_TTL_MS = Number(process.env.DEDUPE_TTL_MS || 30000);
export const MIN_FETCH_INTERVAL_MS = Number(
  process.env.MIN_FETCH_INTERVAL_MS || 1500,
);
export const FETCH_MAX_RETRIES = Number(process.env.FETCH_MAX_RETRIES || 3);
export const FETCH_RETRY_BASE_MS = Number(
  process.env.FETCH_RETRY_BASE_MS || 750,
);
export const DEBUG_MODE = process.env.DEBUG_MODE === 'true';
export const DEBUG_LOGS = DEBUG_MODE;
export const CONTROL_AUTH_USERNAME = process.env.CONTROL_AUTH_USERNAME || '';
export const CONTROL_AUTH_PASSWORD = process.env.CONTROL_AUTH_PASSWORD || '';

function parseSlotLogins(raw) {
  const map = new Map();
  if (!raw) return map;
  for (const entry of String(raw).split(';')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(':');
    if (parts.length < 3) continue;
    const username = parts[0].trim();
    const password = parts[1].trim();
    const slot = Number.parseInt(parts[2].trim(), 10);
    if (!username || !password || !Number.isInteger(slot) || slot <= 0) {
      continue;
    }
    map.set(username, { username, password, slot });
  }
  return map;
}

export const SLOT_LOGINS = parseSlotLogins(process.env.SLOT_LOGINS);

const parsedEventId = Number(
  process.env.EVENT_ID_FILTER ?? process.env.EVENT_ID,
);
let eventIdFilter = Number.isInteger(parsedEventId) ? parsedEventId : null;
export function getEventIdFilter() {
  return eventIdFilter;
}
export function setEventIdFilter(value) {
  if (value === null) {
    eventIdFilter = null;
    return;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('Invalid event ID filter');
  }
  eventIdFilter = parsed;
}
export const VMIX_DEBOUNCE_MS = Number(process.env.VMIX_DEBOUNCE_MS || 200);
export const VMIX_REFRESH_TIMEOUT_MS = Number(
  process.env.VMIX_REFRESH_TIMEOUT_MS || 30000,
);
export const DATABASE_URL = process.env.DATABASE_URL || '';
export const DATABASE_SSL = process.env.DATABASE_SSL === 'true';
export const DATABASE_POOL_MAX = Number(process.env.DATABASE_POOL_MAX || 10);
export const ROSTER_CACHE_TTL_MS = Number(
  process.env.ROSTER_CACHE_TTL_MS || 60000,
);
