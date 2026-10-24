import { sql } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';

const DAY_MS = 86_400_000;

type Column = { table_name: string; column_name: string; data_type: string };

/**
 * A repetition's own clock (specs/043 § The production turn path determines
 * state and action outcomes). Production reads the time wherever it needs it,
 * in code and in SQL, and compares it with times it stored. Moving every
 * stored time back by `ms` is the same, to all of it, as `ms` passing: a nudge
 * comes due, a flow finishes playing, a window closes. Nothing in production
 * needs a clock it can be handed, and no model call is made to look faster:
 * deadlines run on real time.
 *
 * Only the repetition's own database moves, so no state crosses repetitions.
 */
export class VirtualClock {
  private readonly db: Database;
  private offsetMs = 0;
  private columns: Column[] | undefined;

  constructor(db: Database) {
    this.db = db;
  }

  /** How far the repetition has been moved past real time, in milliseconds. */
  get elapsedMs(): number {
    return this.offsetMs;
  }

  async advance(ms: number): Promise<void> {
    if (ms <= 0) return;
    // A date column holds a day, not an instant: it moves only when the
    // advance as a whole crosses a day.
    const days = Math.floor((this.offsetMs + ms) / DAY_MS) - Math.floor(this.offsetMs / DAY_MS);
    this.offsetMs += ms;
    for (const column of await this.timeColumns()) {
      const table = sql.identifier(column.table_name);
      const name = sql.identifier(column.column_name);
      if (column.data_type === 'date') {
        if (days > 0)
          await this.db.execute(sql`UPDATE ${table} SET ${name} = ${name} - ${days}::int`);
      } else {
        await this.db.execute(
          sql`UPDATE ${table} SET ${name} = ${name} - (${ms}::bigint * interval '1 millisecond')`,
        );
      }
    }
  }

  private async timeColumns(): Promise<Column[]> {
    if (this.columns) return this.columns;
    const result: unknown = await this.db.execute(sql`
      SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public'
        AND data_type IN ('timestamp with time zone', 'timestamp without time zone', 'date')
      ORDER BY table_name, column_name
    `);
    // postgres-js returns a RowList (array); PGlite returns `{ rows }`.
    this.columns = Array.isArray(result)
      ? (result as Column[])
      : ((result as { rows?: Column[] }).rows ?? []);
    return this.columns;
  }
}
