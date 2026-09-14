import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.ts';

/**
 * `DATABASE_URL=pglite` runs an embedded Postgres in-process, so the project can
 * be cloned and run with no database to install. Real Postgres semantics, since
 * PGlite is Postgres compiled to WASM — but single-process and not durable
 * across restarts unless a path is given (`pglite:./data/dev`).
 */
export function isEmbedded(url: string): boolean {
  return url === 'pglite' || url.startsWith('pglite:');
}

export async function createEmbeddedDatabase(url: string) {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle: drizzlePglite } = await import('drizzle-orm/pglite');
  const dataDir = url.startsWith('pglite:') ? url.slice('pglite:'.length) : undefined;
  const client = dataDir ? new PGlite(dataDir) : new PGlite();
  return { db: drizzlePglite(client, { schema }), client };
}

export type Database = ReturnType<typeof createDatabase>;

/**
 * Production client. Tests use a PGlite-backed instance instead (see
 * test/helpers/db.ts) — real Postgres semantics without a container, which is
 * what keeps `FOR UPDATE SKIP LOCKED` honestly covered in CI.
 */
export function createDatabase(url: string, options?: { max?: number }) {
  const sql = postgres(url, {
    max: options?.max ?? 10,
    // The request path already races an 8s deadline; a connection that takes
    // longer than that is useless to it.
    connect_timeout: 10,
    idle_timeout: 30,
    onnotice: () => {},
  });
  return drizzle(sql, { schema });
}

export { schema };
