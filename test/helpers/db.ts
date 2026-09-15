import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as schema from '../../src/db/schema.ts';
import type { Database } from '../../src/db/client.ts';

/**
 * An in-process Postgres for tests. PGlite is real Postgres compiled to WASM, so
 * `FOR UPDATE SKIP LOCKED`, upserts and constraints behave as in production —
 * unlike a mock or an SQLite stand-in — with no container to start in CI.
 */
export async function createTestDatabase(): Promise<{ db: Database; close: () => Promise<void> }> {
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
  const db = drizzle(client, { schema }) as unknown as Database;
  return { db, close: () => client.close() };
}
