import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { outbox } from '../db/schema.ts';
import type { AgentReply, StagedAction } from '../contracts/agent.ts';

/** The channel every row was delivered through before plugin channels (specs/038). */
export const MANYCHAT_CHANNEL = 'manychat';

interface OutboxRowBase {
  id: string;
  tenantId: string;
  subscriberId: string;
  /** The adapter that delivers it (specs/038). */
  channel: string;
  conversationId: string | null;
  attempts: number;
}

/**
 * A deferred reply and the actions staged with it (specs/012), performed once
 * the text is delivered and resolved on the agent turn `turnId`.
 */
export interface ReplyPayload {
  messages: string[];
  actions?: StagedAction[];
  turnId?: string;
}

/**
 * A deferred reply, or the retry of a contact token's write (specs/019). The
 * token row carries the generation it retries, never the token.
 */
export type OutboxRow = OutboxRowBase &
  (
    | { kind: 'reply'; payload: ReplyPayload }
    | { kind: 'contact_token'; payload: { generation: number } }
  );

export const MAX_ATTEMPTS = 5;

export class OutboxQueue {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async enqueue(input: {
    tenantId: string;
    subscriberId: string;
    /** The adapter that delivers it; ManyChat when absent (specs/038). */
    channel?: string | undefined;
    conversationId: string | null;
    reply: AgentReply;
    /** Deferred with the reply, never dropped from it (specs/012). */
    actions?: { staged: readonly StagedAction[]; turnId: string } | undefined;
    /** Held until then: a flow sent this turn is still playing (specs/030). */
    notBefore?: Date | undefined;
  }): Promise<string> {
    const payload: ReplyPayload = { messages: input.reply.messages };
    if (input.actions && input.actions.staged.length > 0) {
      payload.actions = [...input.actions.staged];
      payload.turnId = input.actions.turnId;
    }
    const notBefore = input.notBefore
      ? sql`${input.notBefore.toISOString()}::timestamptz`
      : sql`now()`;
    const [row] = await this.db
      .insert(outbox)
      .values({
        tenantId: input.tenantId,
        subscriberId: input.subscriberId,
        channel: input.channel ?? MANYCHAT_CHANNEL,
        conversationId: input.conversationId,
        payload,
        // Never due before a reply already queued for the contact, so a later
        // reply cannot overtake it (specs/037 § A reply never overtakes an
        // earlier one). GREATEST ignores the NULL of a contact with none.
        nextAttemptAt: sql`GREATEST(${notBefore}, (
          SELECT max(${outbox.nextAttemptAt}) FROM ${outbox}
          WHERE ${this.queuedReplies(input.tenantId, input.subscriberId)}
        ))`,
      })
      .returning({ id: outbox.id });
    if (!row) throw new Error('enqueue: insert returned no row');
    return row.id;
  }

  /**
   * Whether a reply to the contact is still queued: pending, or being
   * delivered. A later reply goes behind it (specs/037).
   */
  async hasQueuedReply(tenantId: string, subscriberId: string): Promise<boolean> {
    const result: unknown = await this.db.execute(
      sql`SELECT 1 FROM ${outbox} WHERE ${this.queuedReplies(tenantId, subscriberId)} LIMIT 1`,
    );
    const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
    return rows.length > 0;
  }

  /** A failed row is never sent and a token write is not a reply: neither holds one back. */
  private queuedReplies(tenantId: string, subscriberId: string) {
    return sql`${outbox.tenantId} = ${tenantId}
      AND ${outbox.subscriberId} = ${subscriberId}
      AND ${outbox.kind} = 'reply'
      AND ${outbox.status} IN ('pending', 'delivering')`;
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
      channel: string;
      conversation_id: string | null;
      kind: OutboxRow['kind'];
      payload: OutboxRow['payload'];
      attempts: number;
    };

    // postgres-js returns a RowList (array); PGlite returns `{ rows }`. Tests run
    // against PGlite and production against postgres-js, so both are handled.
    //
    // RETURNING keeps no order, so the claimed rows are read back in the order
    // they were written: one contact's replies go out in that order (specs/002
    // § Messages to one contact are paced).
    const result: unknown = await this.db.execute(sql`
      WITH claimed AS (
        UPDATE ${outbox} SET status = 'delivering', attempts = ${outbox.attempts} + 1
        WHERE id IN (
          SELECT id FROM ${outbox} candidate
          WHERE status = 'pending' AND next_attempt_at <= now()
            -- A reply waits while an earlier one to the contact is being sent
            -- or waits out a retry, so it cannot overtake it (specs/037).
            AND NOT (kind = 'reply' AND EXISTS (
              SELECT 1 FROM ${outbox} earlier
              WHERE earlier.tenant_id = candidate.tenant_id
                AND earlier.subscriber_id = candidate.subscriber_id
                AND earlier.kind = 'reply'
                AND earlier.created_at < candidate.created_at
                AND (
                  earlier.status = 'delivering'
                  OR (earlier.status = 'pending' AND earlier.next_attempt_at > now())
                )
            ))
          ORDER BY next_attempt_at, created_at
          FOR UPDATE SKIP LOCKED
          LIMIT ${limit}
        )
        RETURNING id, tenant_id, subscriber_id, channel, conversation_id, kind, payload, attempts,
          created_at
      )
      SELECT id, tenant_id, subscriber_id, channel, conversation_id, kind, payload, attempts
      FROM claimed
      ORDER BY created_at
    `);

    const rows: Row[] = Array.isArray(result)
      ? (result as Row[])
      : ((result as { rows?: Row[] }).rows ?? []);

    return rows.map(
      row =>
        ({
          id: row.id,
          tenantId: row.tenant_id,
          subscriberId: row.subscriber_id,
          channel: row.channel,
          conversationId: row.conversation_id,
          kind: row.kind,
          payload: row.payload,
          attempts: row.attempts,
        }) as OutboxRow,
    );
  }

  /**
   * Hands claimed rows back unattempted: due again at once, with the claim's
   * attempt taken back (specs/002 § Messages to one contact are paced).
   */
  async release(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .update(outbox)
      .set({ status: 'pending', attempts: sql`${outbox.attempts} - 1` })
      .where(and(inArray(outbox.id, [...ids]), eq(outbox.status, 'delivering')));
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
    // The contact's later replies move back with it, so none comes due before
    // it and a full batch cannot claim one without it (specs/037 § A reply
    // never overtakes an earlier one).
    await this.db.execute(sql`
      UPDATE ${outbox} later
      SET next_attempt_at = GREATEST(later.next_attempt_at, failed.next_attempt_at)
      FROM ${outbox} failed
      WHERE failed.id = ${id}
        AND failed.kind = 'reply'
        AND later.tenant_id = failed.tenant_id
        AND later.subscriber_id = failed.subscriber_id
        AND later.kind = 'reply'
        AND later.status IN ('pending', 'delivering')
        AND later.created_at > failed.created_at
    `);
    return 'retrying';
  }
}
