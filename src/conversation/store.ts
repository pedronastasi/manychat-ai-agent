import { and, eq, gte, sql } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { conversations, turns } from '../db/schema.ts';
import type { MediaKind, TurnOutcome } from '../contracts/agent.ts';
import type { TokenState } from './tokens.ts';

export interface ConversationRecord {
  id: string;
  turnCount: number;
  escalatedAt: Date | null;
}

/** A conversation as found before the turn, with what binding needs (specs/019). */
export interface KnownConversation extends ConversationRecord, TokenState {}

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
          // The column as encoder: postgres-js would send a bare Date as Date.toString().
          turnCount: sql`CASE WHEN ${conversations.lastMessageAt} <= ${sql.param(idleSince, conversations.lastMessageAt)} THEN 1 ELSE ${conversations.turnCount} + 1 END`,
          // GREATEST: concurrent requests read their clocks in any order.
          lastMessageAt: sql`GREATEST(${conversations.lastMessageAt}, ${sql.param(now, conversations.lastMessageAt)})`,
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

  /**
   * `bound` says whether the request carried the contact's token. An unbound
   * turn is kept but never enters history (specs/019), so a caller without the
   * token cannot plant text in the contact's conversation.
   */
  async recordUserMessage(
    conversationId: string,
    text: string,
    turn: { bound: boolean; mediaKind?: MediaKind | undefined },
  ): Promise<string> {
    const [row] = await this.db
      .insert(turns)
      .values({
        conversationId,
        role: 'user',
        text,
        bound: turn.bound,
        mediaKind: turn.mediaKind ?? null,
      })
      .returning({ id: turns.id });
    if (!row) throw new Error('recordUserMessage: insert returned no row');
    return row.id;
  }

  /**
   * Replaces a media turn's marker with its transcript once there is one
   * (specs/020). The row is written first so the message keeps its place in
   * the conversation while the download and transcription run.
   */
  async replaceUserMessage(turnId: string, text: string) {
    await this.db.update(turns).set({ text }).where(eq(turns.id, turnId));
  }

  async recordAgentReply(
    conversationId: string,
    text: string,
    outcome: TurnOutcome,
    turn: { bound: boolean; usage?: TurnUsage },
  ) {
    const usage = turn.usage ?? {};
    await this.db.insert(turns).values({
      conversationId,
      role: 'agent',
      text,
      outcome,
      bound: turn.bound,
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
   * The last `limit` bound turns recorded since `since`, oldest-first, for
   * prompt history. Older turns are kept, just not shown to the model
   * (specs/018), and unbound ones never are (specs/019).
   */
  async recentTurns(conversationId: string, since: Date, limit = 10) {
    const rows = await this.db.query.turns.findMany({
      where: and(
        eq(turns.conversationId, conversationId),
        gte(turns.createdAt, since),
        eq(turns.bound, true),
      ),
      orderBy: (table, { desc }) => [desc(table.seq)],
      limit,
      columns: { role: true, text: true },
    });
    return rows.reverse();
  }

  async find(tenantId: string, subscriberId: string): Promise<KnownConversation | undefined> {
    return this.db.query.conversations.findFirst({
      where: and(
        eq(conversations.tenantId, tenantId),
        eq(conversations.subscriberId, subscriberId),
      ),
      columns: {
        id: true,
        turnCount: true,
        escalatedAt: true,
        tokenHash: true,
        previousTokenHash: true,
      },
    });
  }
}
