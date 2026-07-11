import {
  DATABASE_POOL_MAX,
  DATABASE_SSL,
  DATABASE_URL,
} from '../config.js';

let poolPromise = null;

function assertConfigured() {
  if (!DATABASE_URL) {
    const error = new Error('Database is not configured (DATABASE_URL is missing).');
    error.code = 'DB_NOT_CONFIGURED';
    throw error;
  }
}

export async function getDbPool() {
  assertConfigured();

  if (!poolPromise) {
    poolPromise = (async () => {
      const { Pool } = await import('pg');
      const pool = new Pool({
        connectionString: DATABASE_URL,
        max: DATABASE_POOL_MAX,
        ssl: DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
      });
      return pool;
    })();
  }

  return poolPromise;
}

export async function queryDb(text, params = []) {
  const pool = await getDbPool();
  return pool.query(text, params);
}

/**
 * Run `fn(client)` inside a real BEGIN/COMMIT transaction on a SINGLE
 * dedicated connection. `pool.query` sends each statement on an arbitrary
 * pooled connection, so BEGIN/…/COMMIT issued through `queryDb` do NOT form a
 * transaction — the statements autocommit independently and a mid-sequence
 * crash (e.g. a deploy SIGTERM) can persist a destructive statement (DELETE)
 * without the statements that were meant to follow it. Rolls back and
 * rethrows on error; always releases the client.
 *
 * @template T
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withDbTransaction(fn) {
  const pool = await getDbPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // connection may already be gone; the pool will discard it
    }
    throw error;
  } finally {
    client.release();
  }
}

export function isDbConfigured() {
  return Boolean(DATABASE_URL);
}
