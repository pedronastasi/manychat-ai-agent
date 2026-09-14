import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { conversations, turns } from '../db/schema.ts';
import type { TurnOutcome } from '../contracts/agent.ts';

export interface ConversationRecord {
  id: string;
  turnCount: number;
  escalatedAt: Date | null;
}

export interface TurnUsage {
  model?: string | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cacheReadTokens?: number | undefined;
  costUsd?: number | undefined;
  latencyMs?: number | undefined;
}

/**
 * Finds or creates the conversation for a subscriber and increments its turn
 * count, in one statement.
 *
 * A read-then-write would race between concurrent messages from the same
 * contact — which is not hypothetical, since people send three messages in a row
 * and ManyChat delivers them concurrently.
 */
export async function startTurn(
  db: Database,
  input: { tenantId: string; subscriberId: string; channel: string },
): Promise<ConversationRecord> {
  const [row] = await db
    .insert(conversations)
    .values({
      tenantId: input.tenantId,
      subscriberId: input.subscriberId,
      channel: input.channel,
      turnCount: 1,
    })
    .onConflictDoUpdate({
      target: [conversations.tenantId, conversations.subscriberId],
      set: {
        turnCount: sql`${conversations.turnCount} + 1`,
        updatedAt: sql`now()`,
      },
    })
    .returning({
      id: conversations.id,
      turnCount: conversations.turnCount,
      escalatedAt: conversations.escalatedAt,
    });

  if (!row) throw new Error('startTurn: upsert returned no row');
  return row;
}

export async function recordUserMessage(db: Database, conversationId: string, text: string) {
  await db.insert(turns).values({ conversationId, role: 'user', text });
}

export async function recordAgentReply(
  db: Database,
  conversationId: string,
  text: string,
  outcome: TurnOutcome,
  usage: TurnUsage = {},
) {
  await db.insert(turns).values({
    conversationId,
    role: 'agent',
    text,
    outcome,
    model: usage.model ?? null,
    inputTokens: usage.inputTokens ?? null,
    outputTokens: usage.outputTokens ?? null,
    cacheReadTokens: usage.cacheReadTokens ?? null,
    costUsd: usage.costUsd != null ? usage.costUsd.toFixed(6) : null,
    latencyMs: usage.latencyMs ?? null,
  });
}

export async function markEscalated(db: Database, conversationId: string) {
  await db
    .update(conversations)
    .set({ escalatedAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(conversations.id, conversationId));
}

/** Recent turns, oldest-first, for prompt history. */
export async function recentTurns(db: Database, conversationId: string, limit = 10) {
  const rows = await db.query.turns.findMany({
    where: eq(turns.conversationId, conversationId),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
    limit,
    columns: { role: true, text: true },
  });
  return rows.reverse();
}

export async function findConversation(
  db: Database,
  tenantId: string,
  subscriberId: string,
): Promise<ConversationRecord | undefined> {
  return db.query.conversations.findFirst({
    where: and(eq(conversations.tenantId, tenantId), eq(conversations.subscriberId, subscriberId)),
    columns: { id: true, turnCount: true, escalatedAt: true },
  });
}
