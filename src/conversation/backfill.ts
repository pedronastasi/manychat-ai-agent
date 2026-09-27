import { and, eq, exists, gte, isNull } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { conversations, turns } from '../db/schema.ts';
import type { ContactTokens } from './tokens.ts';

/**
 * Rollout of contact tokens (specs/019 § Tokens reach existing contacts before
 * they are required). Tokens must be in ManyChat before any request can carry
 * them, so every contact with a turn inside the history window is issued one
 * before `CONTACT_TOKENS_ENFORCED` is turned on.
 */

export interface BackfillResult {
  /** Contacts issued a token whose write landed. */
  written: number;
  /** Contacts issued a token whose write failed; the outbox worker retries it. */
  queued: number;
}

/** Contacts with a turn since `since` and no token hash: the ones still to do. */
function withoutTokens(db: Database, tenantId: string, since: Date) {
  return db
    .select({ id: conversations.id, subscriberId: conversations.subscriberId })
    .from(conversations)
    .where(
      and(
        eq(conversations.tenantId, tenantId),
        isNull(conversations.tokenHash),
        exists(
          db
            .select({ id: turns.id })
            .from(turns)
            .where(and(eq(turns.conversationId, conversations.id), gte(turns.createdAt, since))),
        ),
      ),
    );
}

/**
 * Issues a token to every contact of `tenantId` with a turn since `since` that
 * has none yet. Safe to run again: a contact issued a token, by this or by a
 * live request, is skipped.
 */
export async function backfillContactTokens(
  db: Database,
  tokens: ContactTokens,
  input: { tenantId: string; since: Date },
): Promise<BackfillResult> {
  const result: BackfillResult = { written: 0, queued: 0 };
  for (const contact of await withoutTokens(db, input.tenantId, input.since)) {
    const issued = await tokens.issue({
      tenantId: input.tenantId,
      subscriberId: contact.subscriberId,
      conversationId: contact.id,
    });
    // A live request issued one between the query and here.
    if (!issued) continue;
    try {
      await issued.written;
      result.written++;
    } catch {
      result.queued++;
    }
  }
  return result;
}

/** Rollout step 4: how many contacts inside the window still lack a token hash. */
export async function countContactsWithoutTokens(
  db: Database,
  input: { tenantId: string; since: Date },
): Promise<number> {
  return (await withoutTokens(db, input.tenantId, input.since)).length;
}
