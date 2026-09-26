import { and, eq, gte, sql } from 'drizzle-orm';
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

const HOUR_MS = 3_600_000;

export class ConversationStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Finds or creates the conversation for a subscriber and counts this message
   * toward its turn cap, in one statement.
   *
   * The count starts again at one when the contact's previous message is at
   * least `idleResetHours` old, so the cap bounds one stretch of conversation
   * rather than a contact's lifetime (specs/018).
   *
   * A read-then-write would race between concurrent messages from the same
   * contact — which is not hypothetical, since people send three messages in a
   * row and ManyChat delivers them concurrently.
   */
  async startTurn(
    input: {
      tenantId: string;
      subscriberId: string;
      channel: string;
      idleResetHours: number;
    },
    now = new Date(),
  ): Promise<ConversationRecord> {
    const idleSince = new Date(now.getTime() - input.idleResetHours * HOUR_MS);
    const [row] = await this.db
      .insert(conversations)
      .values({
        tenantId: input.tenantId,
        subscriberId: input.subscriberId,
        channel: input.channel,
        turnCount: 1,
        lastMessageAt: now,
      })
      .onConflictDoUpdate({
        target: [conversations.tenantId, conversations.subscriberId],
        set: {
          turnCount: sql`CASE WHEN ${conversations.lastMessageAt} <= ${idleSince} THEN 1 ELSE ${conversations.turnCount} + 1 END`,
          // GREATEST: concurrent requests read their clocks in any order.
          lastMessageAt: sql`GREATEST(${conversations.lastMessageAt}, ${now})`,
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

  async recordUserMessage(conversationId: string, text: string) {
    await this.db.insert(turns).values({ conversationId, role: 'user', text });
  }

  async recordAgentReply(
    conversationId: string,
    text: string,
    outcome: TurnOutcome,
    usage: TurnUsage = {},
  ) {
    await this.db.insert(turns).values({
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

  async markEscalated(conversationId: string) {
    await this.db
      .update(conversations)
      .set({ escalatedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(conversations.id, conversationId));
  }

  /**
   * The last `limit` turns recorded since `since`, oldest-first, for prompt
   * history. Older turns are kept, just not shown to the model (specs/018).
   */
  async recentTurns(conversationId: string, since: Date, limit = 10) {
    const rows = await this.db.query.turns.findMany({
      where: and(eq(turns.conversationId, conversationId), gte(turns.createdAt, since)),
      orderBy: (table, { desc }) => [desc(table.seq)],
      limit,
      columns: { role: true, text: true },
    });
    return rows.reverse();
  }

  async find(tenantId: string, subscriberId: string): Promise<ConversationRecord | undefined> {
    return this.db.query.conversations.findFirst({
      where: and(
        eq(conversations.tenantId, tenantId),
        eq(conversations.subscriberId, subscriberId),
      ),
      columns: { id: true, turnCount: true, escalatedAt: true },
    });
  }
}
