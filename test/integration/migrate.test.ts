import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as schema from '../../src/db/schema.ts';
import type { Database } from '../../src/db/client.ts';
import { runMigrations } from '../../src/db/migrate.ts';

/** specs/004-testing.md P3. */

function freshDb() {
  const client = new PGlite();
  return { db: drizzle(client, { schema }) as unknown as Database, close: () => client.close() };
}

const tableNames = async (db: Database) => {
  const r: unknown = await db.execute(
    sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`,
  );
  const rows = Array.isArray(r) ? r : ((r as { rows: { table_name: string }[] }).rows ?? []);
  return (rows as { table_name: string }[]).map(x => x.table_name);
};

describe('runMigrations', () => {
  it('applies the real migrations and creates every table', async () => {
    const { db, close } = freshDb();
    const applied = await runMigrations(db, 'db/migrations');

    expect(applied.length).toBeGreaterThan(0);
    expect(await tableNames(db)).toEqual(
      expect.arrayContaining([
        'budget_counters',
        'conversations',
        'outbox',
        'rate_counters',
        'turns',
      ]),
    );
    await close();
  });

  it('is idempotent — a second run applies nothing', async () => {
    // The embedded dev database boots on every start; re-running must be safe.
    const { db, close } = freshDb();
    const first = await runMigrations(db, 'db/migrations');
    const second = await runMigrations(db, 'db/migrations');

    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual([]);
    await close();
  });

  it('records what it applied so later runs can skip it', async () => {
    const { db, close } = freshDb();
    const applied = await runMigrations(db, 'db/migrations');
    const r: unknown = await db.execute(sql`SELECT name FROM _migrations ORDER BY name`);
    const rows = Array.isArray(r) ? r : ((r as { rows: { name: string }[] }).rows ?? []);
    expect((rows as { name: string }[]).map(x => x.name)).toEqual(applied);
    await close();
  });

  it('applies new migrations added after the first run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    writeFileSync(join(dir, '0000_first.sql'), 'CREATE TABLE a (id int);');
    const { db, close } = freshDb();

    expect(await runMigrations(db, dir)).toEqual(['0000_first.sql']);
    writeFileSync(join(dir, '0001_second.sql'), 'CREATE TABLE b (id int);');
    expect(await runMigrations(db, dir)).toEqual(['0001_second.sql']);
    expect(await tableNames(db)).toEqual(expect.arrayContaining(['a', 'b']));

    await close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('applies files in lexical order, not directory order', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-order-'));
    // Written out of order on purpose; 0001 depends on 0000 existing.
    writeFileSync(join(dir, '0001_add_column.sql'), 'ALTER TABLE ordered ADD COLUMN v int;');
    writeFileSync(join(dir, '0000_create.sql'), 'CREATE TABLE ordered (id int);');
    const { db, close } = freshDb();

    expect(await runMigrations(db, dir)).toEqual(['0000_create.sql', '0001_add_column.sql']);

    await close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('does NOT record a migration that failed', async () => {
    // Recording a failed migration would permanently skip it, leaving the
    // schema broken with no way to notice.
    const dir = mkdtempSync(join(tmpdir(), 'mig-bad-'));
    writeFileSync(join(dir, '0000_broken.sql'), 'CREATE TABLE ( this is not sql;');
    const { db, close } = freshDb();

    await expect(runMigrations(db, dir)).rejects.toThrow();
    const r: unknown = await db.execute(sql`SELECT count(*)::int AS n FROM _migrations`);
    const rows = Array.isArray(r) ? r : ((r as { rows: { n: number }[] }).rows ?? []);
    expect((rows as { n: number }[])[0]!.n).toBe(0);

    await close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('ignores non-SQL files in the migrations directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-mixed-'));
    writeFileSync(join(dir, '0000_ok.sql'), 'CREATE TABLE ok (id int);');
    writeFileSync(join(dir, 'journal.json'), '{"entries":[]}');
    const { db, close } = freshDb();

    expect(await runMigrations(db, dir)).toEqual(['0000_ok.sql']);

    await close();
    rmSync(dir, { recursive: true, force: true });
  });
});
