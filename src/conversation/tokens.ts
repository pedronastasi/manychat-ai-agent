import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { conversations, outbox } from '../db/schema.ts';

/**
 * Contact tokens (specs/019, ADR-0012).
 *
 * The shared secret proves the caller, not the contact. What proves the contact
 * is a random token held in their own ManyChat custom field, which ManyChat
 * fills into every request it sends for them. Only its hash is stored here, and
 * the token itself never appears in a response or a log line.
 */

const HOUR_MS = 3_600_000;

/** A contact's token is issued again at most this often (specs/019). */
export const REISSUE_AFTER_MS = HOUR_MS;

/**
 * How long a token write has to succeed in-process before the outbox worker
 * retries it. Longer than the write's own timeout, so the worker never replaces
 * a token whose write is still in flight.
 */
export const TOKEN_RETRY_DELAY_MS = 60_000;

/** Writes a contact's token to where the channel keeps it for them. */
export interface ContactTokenWriter {
  writeToken(subscriberId: string, token: string): Promise<void>;
}

export interface TokenState {
  tokenHash: string | null;
  previousTokenHash: string | null;
}

/**
 * - `first`: the contact has no token yet, so this request starts their history.
 * - `bound`: the request carried the contact's current or previous token.
 * - `unbound`: it carried no token, or a wrong one.
 */
export type Binding = 'first' | 'bound' | 'unbound';

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function sameDigest(presented: Buffer, storedHex: string): boolean {
  const stored = Buffer.from(storedHex, 'hex');
  return stored.length === presented.length && timingSafeEqual(presented, stored);
}

/**
 * Compares by hash, in constant time, against the current and the previous
 * token. Both are always compared, so the timing does not say which matched.
 */
export function bindingFor(state: TokenState | undefined, presented: string | null): Binding {
  if (!state?.tokenHash) return 'first';
  if (!presented) return 'unbound';
  const digest = Buffer.from(hashToken(presented), 'hex');
  const current = sameDigest(digest, state.tokenHash);
  const previous = state.previousTokenHash !== null && sameDigest(digest, state.previousTokenHash);
  return current || previous ? 'bound' : 'unbound';
}

export interface IssueInput {
  tenantId: string;
  subscriberId: string;
  conversationId: string;
}

export class ContactTokens {
  private readonly db: Database;
  private readonly writer: ContactTokenWriter;
  /** The adapter whose outbox row retries a failed write (specs/038). */
  private readonly channel: string;

  constructor(db: Database, writer: ContactTokenWriter, channel = 'manychat') {
    this.db = db;
    this.writer = writer;
    this.channel = channel;
  }

  /**
   * Issues the contact a fresh token, unless they already have one issued
   * within the hour, and starts writing it to their field.
   *
   * Returns the write in flight, or null when no token was due. The write is
   * not awaited by the turn: it runs alongside the model call, which is why it
   * is wrapped rather than returned, since an async function would flatten it. Its retry is
   * queued in the same transaction as the issue and cancelled once the write
   * succeeds, so a failed write, or a process that dies before it lands, is
   * retried by the outbox worker rather than leaving the contact unbound for an
   * hour.
   *
   * The current token becomes the previous one, which stays valid until the
   * next issue: a message sent before the new token landed still binds.
   */
  async issue(input: IssueInput, now = new Date()): Promise<{ written: Promise<void> } | null> {
    const token = generateToken();
    const reissueBefore = new Date(now.getTime() - REISSUE_AFTER_MS);

    const jobId = await this.db.transaction(async tx => {
      const [issued] = await tx
        .update(conversations)
        .set({
          // Every SET expression reads the row as it was before the update.
          previousTokenHash: sql`${conversations.tokenHash}`,
          tokenHash: hashToken(token),
          tokenIssuedAt: now,
          tokenGeneration: sql`${conversations.tokenGeneration} + 1`,
        })
        .where(
          and(
            eq(conversations.id, input.conversationId),
            or(
              isNull(conversations.tokenHash),
              isNull(conversations.tokenIssuedAt),
              lte(conversations.tokenIssuedAt, reissueBefore),
            ),
          ),
        )
        .returning({ generation: conversations.tokenGeneration });
      if (!issued) return null;

      // The retry names the generation, never the token: the token is stored
      // nowhere but the contact's field.
      const [job] = await tx
        .insert(outbox)
        .values({
          tenantId: input.tenantId,
          subscriberId: input.subscriberId,
          channel: this.channel,
          conversationId: input.conversationId,
          kind: 'contact_token',
          payload: { generation: issued.generation },
          nextAttemptAt: new Date(now.getTime() + TOKEN_RETRY_DELAY_MS),
        })
        .returning({ id: outbox.id });
      return job?.id ?? null;
    });
    if (!jobId) return null;

    const written = this.writer.writeToken(input.subscriberId, token).then(async () => {
      await this.db
        .update(outbox)
        .set({ status: 'delivered', deliveredAt: sql`now()` })
        .where(and(eq(outbox.id, jobId), eq(outbox.status, 'pending')));
    });
    return { written };
  }

  /**
   * For the outbox worker: replaces a token whose write never succeeded with a
   * fresh one to write instead, or returns null when a newer issue superseded
   * it. The worker cannot write the original, because it was never stored.
   *
   * The previous token is left alone, since it is the one ManyChat still holds.
   */
  async replaceUnwritten(conversationId: string, generation: number): Promise<string | null> {
    const token = generateToken();
    const [row] = await this.db
      .update(conversations)
      .set({ tokenHash: hashToken(token) })
      .where(
        and(eq(conversations.id, conversationId), eq(conversations.tokenGeneration, generation)),
      )
      .returning({ id: conversations.id });
    return row ? token : null;
  }
}
