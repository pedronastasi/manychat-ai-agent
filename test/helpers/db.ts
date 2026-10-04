import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { Logger } from 'drizzle-orm';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as schema from '../../src/db/schema.ts';
import type { Database } from '../../src/db/client.ts';

/**
 * A migrated data directory, built once per test file. Booting PGlite is most
 * of the cost of a test database (~1.5 s, against ~0.3 s to restore a dump), so
 * every test restores this snapshot instead of booting and migrating its own.
 */
let template: Promise<File | Blob> | undefined;

async function migratedDataDir(): Promise<File | Blob> {
  const client = new PGlite();
  const dir = join(import.meta.dirname, '../../db/migrations');
  for (const file of readdirSync(dir)
    .filter(name => name.endsWith('.sql'))
    .sort()) {
    const sql = readFileSync(join(dir, file), 'utf8');
    for (const stmt of sql.split('--> statement-breakpoint')) {
      if (stmt.trim()) await client.exec(stmt);
    }
  }
  const dump = await client.dumpDataDir('none');
  await client.close();
  return dump;
}

/**
 * An in-process Postgres for tests. PGlite is real Postgres compiled to WASM, so
 * `FOR UPDATE SKIP LOCKED`, upserts and constraints behave as in production —
 * unlike a mock or an SQLite stand-in — with no container to start in CI. Each
 * call returns its own instance; nothing is shared between tests but the
 * freshly migrated starting state.
 */
export async function createTestDatabase(
  options: { logger?: Logger } = {},
): Promise<{ db: Database; close: () => Promise<void> }> {
  template ??= migratedDataDir();
  const client = new PGlite({ loadDataDir: await template });
  // Restoring blocks the event loop for as long as it takes. Without this it
  // happens on the first query instead, inside the test, where the server's
  // under-pressure check sees the stall and sheds the request.
  await client.waitReady;
  const db = drizzle(client, { schema, ...options }) as unknown as Database;
  return { db, close: () => client.close() };
}
