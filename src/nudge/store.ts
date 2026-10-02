import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { nudges } from '../db/schema.ts';

/** Why a pending nudge was dropped without a turn (specs/025 § A nudge is cancelled by anything that makes it wrong). */
export type CancelReason = NonNullable<typeof nudges.$inferSelect.cancelReason>;

/** A due nudge the worker has claimed. */
export interface ClaimedNudge {
  id: string;
  conversationId: string;
  dueAt: Date;
  scheduledAt: Date;
}

const MINUTE_MS = 60_000;

/**
 * The `nudges` table (specs/025). Every write names the conversation, never
 * the contact (C5).
 */
export class NudgeStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Schedules a nudge `minutes` from `now`, replacing any pending one for the
   * conversation in the same statement. The partial unique index makes "at
   * most one waits" hold between processes, not just within one.
   */
  async schedule(conversationId: string, minutes: number, now = new Date()): Promise<void> {
    const dueAt = new Date(now.getTime() + minutes * MINUTE_MS);
    await this.db
      .insert(nudges)
      .values({ conversationId, dueAt, scheduledAt: now })
      .onConflictDoUpdate({
        target: nudges.conversationId,
        targetWhere: sql`${nudges.status} = 'pending'`,
        set: { dueAt, scheduledAt: now, updatedAt: sql`now()` },
      });
  }

  /** Cancels the conversation's pending nudge, if it has one. */
  async cancel(conversationId: string, reason: CancelReason): Promise<void> {
    await this.db
      .update(nudges)
      .set({ status: 'cancelled', cancelReason: reason, updatedAt: sql`now()` })
      .where(and(eq(nudges.conversationId, conversationId), eq(nudges.status, 'pending')));
  }

  /** Cancels a nudge the worker claimed, at due time. */
  async cancelClaimed(id: string, reason: CancelReason): Promise<void> {
    await this.db
      .update(nudges)
      .set({ status: 'cancelled', cancelReason: reason, updatedAt: sql`now()` })
      .where(eq(nudges.id, id));
  }

  async finish(id: string, status: 'sent' | 'skipped'): Promise<void> {
    await this.db
      .update(nudges)
      .set({ status, updatedAt: sql`now()` })
      .where(eq(nudges.id, id));
  }

  /**
   * Atomically claims up to `limit` due nudges, as the outbox claims its rows
   * (ADR-0004): a row another worker holds is skipped, never waited on.
   */
  async claimDue(limit = 10): Promise<ClaimedNudge[]> {
    type Row = {
      id: string;
      conversation_id: string;
      due_at: Date | string;
      scheduled_at: Date | string;
    };
    const result: unknown = await this.db.execute(sql`
      UPDATE ${nudges} SET status = 'running', updated_at = now()
      WHERE id IN (
        SELECT id FROM ${nudges}
        WHERE status = 'pending' AND due_at <= now()
        ORDER BY due_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      RETURNING id, conversation_id, due_at, scheduled_at
    `);
    // postgres-js returns a RowList (array); PGlite returns `{ rows }`.
    const rows: Row[] = Array.isArray(result)
      ? (result as Row[])
      : ((result as { rows?: Row[] }).rows ?? []);
    return rows.map(row => ({
      id: row.id,
      conversationId: row.conversation_id,
      dueAt: new Date(row.due_at),
      scheduledAt: new Date(row.scheduled_at),
    }));
  }
}
