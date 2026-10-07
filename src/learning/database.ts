import type { Env } from '../contracts/config.ts';
import type { Database } from '../db/client.ts';

/**
 * Opens the database for a command that runs outside the server (`pnpm eval`,
 * `insights:*`), migrated as `agent serve` would leave it (specs/031).
 */
export async function openDatabase(env: Env): Promise<Database> {
  const { createDatabase, createEmbeddedDatabase, isEmbedded } = await import('../db/client.ts');
  const { runMigrations } = await import('../db/migrate.ts');
  const db = isEmbedded(env.DATABASE_URL)
    ? ((await createEmbeddedDatabase(env.DATABASE_URL)).db as unknown as Database)
    : createDatabase(env.DATABASE_URL, { max: 1 });
  await runMigrations(db);
  return db;
}
