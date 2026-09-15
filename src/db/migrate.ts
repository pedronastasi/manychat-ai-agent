import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import type { Database } from './client.ts';

/**
 * Applies the generated SQL migrations.
 *
 * Deliberately minimal and idempotent-by-tracking-table rather than pulling in
 * drizzle-kit at runtime: the embedded dev database starts empty on every boot,
 * and a migration step that needs a separate CLI would break `clone and run`.
 */
export async function runMigrations(db: Database, dir = 'db/migrations'): Promise<string[]> {
  await db.execute(
    sql`CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  );

  const applied = new Set<string>();
  const existing: unknown = await db.execute(sql`SELECT name FROM _migrations`);
  const rows = Array.isArray(existing)
    ? (existing as { name: string }[])
    : ((existing as { rows?: { name: string }[] }).rows ?? []);
  for (const row of rows) applied.add(row.name);

  const ran: string[] = [];
  for (const file of readdirSync(dir)
    .filter(name => name.endsWith('.sql'))
    .sort()) {
    if (applied.has(file)) continue;
    const content = readFileSync(join(dir, file), 'utf8');
    for (const statement of content.split('--> statement-breakpoint')) {
      if (statement.trim()) await db.execute(sql.raw(statement));
    }
    await db.execute(sql`INSERT INTO _migrations (name) VALUES (${file})`);
    ran.push(file);
  }
  return ran;
}
