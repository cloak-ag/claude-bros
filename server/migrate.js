#!/usr/bin/env node
/**
 * One-time migration: import an existing JSON state file into Postgres.
 *
 *   DATABASE_URL=postgres://... node server/migrate.js data/bounty.json
 *
 * Uses the room name embedded in the file. Safe to re-run — it overwrites the
 * row, and running with no DB just prints the intended destination.
 */
import fs from 'node:fs';
import * as db from './db.js';

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: DATABASE_URL=... node server/migrate.js <state.json>');
    process.exit(1);
  }
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  const room = state.room || file.replace(/.*\/([^/]+)\.json$/, '$1');
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log(`Would import "${room}" (${JSON.stringify(state).length} bytes) into Postgres. Set DATABASE_URL to do it.`);
    return;
  }
  await db.ensureSchema();
  await db.saveState(room, state);
  await db.closePool();
  console.log(`Imported "${room}" into Postgres (${Object.keys(state.agents).length} agents, ${(state.messages || []).length} messages).`);
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
