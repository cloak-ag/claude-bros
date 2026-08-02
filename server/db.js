/**
 * Postgres persistence for the Room state — a JSONB document store.
 *
 * The relay keeps the entire board as one in-memory `state` object (single-threaded
 * Node, so mutations are atomic) and persists it wholesale. Postgres replaces the
 * container-local JSON file so the board survives Cloud Run instance recycling and
 * deploys. One row per room; JSONB keeps the schema as simple as the file did.
 *
 * When DATABASE_URL is unset the Room falls back to the file/in-memory path, so
 * local dev and the test suite are unchanged.
 */
let pool = null;
let pgModule = null;
let schemaReady = null;

/** Lazily create a shared connection pool (max 5 — the relay is single-threaded). */
export async function getPool(url = process.env.DATABASE_URL) {
  if (!pool) {
    if (!url) throw new Error('DATABASE_URL is not set');
    if (!pgModule) {
      try {
        pgModule = await import('pg');
      } catch (err) {
        throw new Error(
          'DATABASE_URL is set but the "pg" driver is not installed. Run `npm install pg`, ' +
          'or unset DATABASE_URL to fall back to file persistence.',
        );
      }
    }
    pool = new pgModule.Pool({ connectionString: url, max: 5, idleTimeoutMillis: 30_000 });
  }
  return pool;
}

/**
 * Callers may hand us a pool, a promise of one, or nothing at all — `getPool` is
 * async, so a caller that forgets to await it would otherwise pass a Promise and
 * every query would fail with "p.query is not a function".
 */
async function resolvePool(p) {
  return p ? await p : getPool();
}

/** Create the document table if it does not exist. Idempotent. */
export async function ensureSchema(p) {
  const client = await resolvePool(p);
  // Once per process — not on the path of every read and write.
  schemaReady ||= client.query(`
    CREATE TABLE IF NOT EXISTS room_state (
      room       TEXT PRIMARY KEY,
      state      JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await schemaReady;
  return client;
}

/** Read a room's state, or null when the room has never been saved. */
export async function loadState(roomName, p) {
  const client = await ensureSchema(p);
  const { rows } = await client.query('SELECT state FROM room_state WHERE room = $1', [roomName]);
  return rows[0]?.state ?? null;
}

/** Upsert a room's full state. */
export async function saveState(roomName, state, p) {
  const client = await ensureSchema(p);
  await client.query(
    `INSERT INTO room_state (room, state, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (room) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
    [roomName, JSON.stringify(state)],
  );
}

/** Close the pool on shutdown. Safe to call more than once. */
export async function closePool() {
  if (!pool) return;
  const p = pool;
  pool = null;
  schemaReady = null;
  await p.end();
}
