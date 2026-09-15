import { sql } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { outbox } from '../db/schema.ts';
import type { AgentReply } from '../contracts/agent.ts';

export interface OutboxRow {
  id: string;
  tenantId: string;
  subscriberId: string;
  payload: { messages: string[] };
  attempts: number;
}

export const MAX_ATTEMPTS = 5;

export class OutboxQueue {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async enqueue(input: {
    tenantId: string;
    subscriberId: string;
    conversationId: string | null;
    reply: AgentReply;
  }): Promise<string> {
    const [row] = await this.db
      .insert(outbox)
      .values({
        tenantId: input.tenantId,
        subscriberId: input.subscriberId,
        conversationId: input.conversationId,
        payload: { messages: input.reply.messages },
      })
      .returning({ id: outbox.id });
    if (!row) throw new Error('enqueue: insert returned no row');
    return row.id;
  }

  /**
   * Atomically claims up to `limit` due rows.
   *
   * `FOR UPDATE SKIP LOCKED` is what makes multiple workers safe without any
   * external coordination (ADR-0004): a row already locked by another worker is
   * skipped rather than waited on.
   */
  async claimBatch(limit = 10): Promise<OutboxRow[]> {
    type Row = {
      id: string;
      tenant_id: string;
      subscriber_id: string;
      payload: { messages: string[] };
      attempts: number;
    };

    // postgres-js returns a RowList (array); PGlite returns `{ rows }`. Tests run
    // against PGlite and production against postgres-js, so both are handled.
    const result: unknown = await this.db.execute(sql`
      UPDATE ${outbox} SET status = 'delivering', attempts = ${outbox.attempts} + 1
      WHERE id IN (
        SELECT id FROM ${outbox}
        WHERE status = 'pending' AND next_attempt_at <= now()
        ORDER BY next_attempt_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      RETURNING id, tenant_id, subscriber_id, payload, attempts
    `);

    const rows: Row[] = Array.isArray(result)
      ? (result as Row[])
      : ((result as { rows?: Row[] }).rows ?? []);

    return rows.map(r => ({
      id: r.id,
      tenantId: r.tenant_id,
      subscriberId: r.subscriber_id,
      payload: r.payload,
      attempts: r.attempts,
    }));
  }

  async markDelivered(id: string): Promise<void> {
    await this.db.execute(
      sql`UPDATE ${outbox} SET status = 'delivered', delivered_at = now() WHERE id = ${id}`,
    );
  }

  /**
   * Reschedules with exponential backoff, or dead-letters.
   *
   * A non-retryable API error (4xx that is not 429) dead-letters immediately —
   * retrying a malformed request five times just delays the alert.
   */
  async markFailed(
    id: string,
    attempts: number,
    error: string,
    retryable: boolean,
  ): Promise<'retrying' | 'dead-lettered'> {
    const exhausted = !retryable || attempts >= MAX_ATTEMPTS;
    if (exhausted) {
      await this.db.execute(
        sql`UPDATE ${outbox} SET status = 'failed', last_error = ${error} WHERE id = ${id}`,
      );
      return 'dead-lettered';
    }
    const backoffSeconds = Math.min(300, 2 ** attempts);
    await this.db.execute(sql`
      UPDATE ${outbox}
      SET status = 'pending',
          last_error = ${error},
          next_attempt_at = now() + (${backoffSeconds} * interval '1 second')
      WHERE id = ${id}
    `);
    return 'retrying';
  }
}
