import { and, eq, gte, isNotNull, isNull, max, ne, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { conversations, turns } from '../db/schema.ts';
import type { ActionRecord, MediaKind, TurnOutcome } from '../contracts/agent.ts';
import type { TokenState } from './tokens.ts';

export interface ConversationRecord {
  id: string;
  turnCount: number;
  escalatedAt: Date | null;
}

/** A conversation as found before the turn, with what binding needs (specs/019). */
export interface KnownConversation extends ConversationRecord, TokenState {
  /** The course the conversation held before this turn (specs/028). */
  course?: string | null;
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

  /**
   * `actions` is null when no tool was offered, so "no tools" stays apart from
   * "tools offered, none chosen" (specs/012). Returns the row's id, which the
   * staged actions are resolved against once they run.
   */
  async recordAgentReply(
    conversationId: string,
    text: string,
    outcome: TurnOutcome,
    turn: { bound: boolean; usage?: TurnUsage; actions?: ActionRecord[] | null | undefined },
  ): Promise<string> {
    const usage = turn.usage ?? {};
    const [row] = await this.db
      .insert(turns)
      .values({
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
        actions: turn.actions ?? null,
      })
      .returning({ id: turns.id });
    if (!row) throw new Error('recordAgentReply: insert returned no row');
    return row.id;
  }

  /**
   * Replaces the turn's `staged` entries, in order, with what became of them.
   * The entries were written in the order the actions were staged, which is
   * the order they are performed in, so the nth group of outcomes belongs to
   * the nth staged entry. A group holds the action's own record and then any
   * follow-on the server performed after it (specs/023). Entries already
   * settled (`dropped_over_cap`) are kept.
   */
  async resolveStaged(turnId: string, outcomes: ActionRecord[][]) {
    const row = await this.db.query.turns.findFirst({
      where: eq(turns.id, turnId),
      columns: { actions: true },
    });
    if (!row?.actions) return;
    let next = 0;
    const actions = row.actions.flatMap(entry =>
      entry.status === 'staged' && next < outcomes.length ? outcomes[next++]! : [entry],
    );
    await this.db.update(turns).set({ actions }).where(eq(turns.id, turnId));
  }

  /**
   * Every agent turn's action record for the conversation, oldest first,
   * bound or not: an action performed on an unbound turn still reached the
   * contact's ManyChat record. Read so the next turn's tools know what was
   * already sent and which stage the sale is at (specs/023).
   */
  async actionHistory(conversationId: string) {
    return this.db.query.turns.findMany({
      where: and(
        eq(turns.conversationId, conversationId),
        eq(turns.role, 'agent'),
        isNotNull(turns.actions),
      ),
      orderBy: (table, { asc }) => [asc(table.seq)],
      columns: { createdAt: true, actions: true },
    });
  }

  /**
   * Whether the model has run for this contact before: an agent turn that
   * recorded the model that wrote it. The opening flow goes only to a contact
   * for whom none has (specs/032 § The opening flow is the server's).
   */
  async hasModelTurn(conversationId: string): Promise<boolean> {
    const row = await this.db.query.turns.findFirst({
      where: and(
        eq(turns.conversationId, conversationId),
        eq(turns.role, 'agent'),
        isNotNull(turns.model),
      ),
      columns: { id: true },
    });
    return row !== undefined;
  }

  /**
   * Claims the contact's opening flow, once: true for the one caller that
   * set the mark, false for every other, concurrent ones included (specs/032).
   */
  async claimOpening(conversationId: string): Promise<boolean> {
    const rows = await this.db
      .update(conversations)
      .set({ openingSentAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(conversations.id, conversationId), isNull(conversations.openingSentAt)))
      .returning({ id: conversations.id });
    return rows.length > 0;
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
   * (specs/018), and unbound ones never are (specs/019). Nor is a nudge the
   * model declined: nothing of it reached the contact (specs/025).
   */
  async recentTurns(conversationId: string, since: Date, limit = 10) {
    const rows = await this.db.query.turns.findMany({
      where: and(
        eq(turns.conversationId, conversationId),
        gte(turns.createdAt, since),
        eq(turns.bound, true),
        or(isNull(turns.outcome), ne(turns.outcome, 'nudge_skipped')),
      ),
      orderBy: (table, { desc }) => [desc(table.seq)],
      limit,
      columns: { role: true, text: true, actions: true },
    });
    return rows.reverse();
  }

  /** A conversation by its id, with the contact it belongs to: the nudge worker's lookup (specs/025). */
  async byId(conversationId: string) {
    return this.db.query.conversations.findFirst({
      where: eq(conversations.id, conversationId),
      columns: {
        id: true,
        tenantId: true,
        subscriberId: true,
        turnCount: true,
        escalatedAt: true,
        course: true,
      },
    });
  }

  /**
   * Records the contact's course: the one a request carried, or one this
   * service wrote to the course field (specs/028 § The server learns the
   * course from the inbound request).
   */
  async setCourse(conversationId: string, course: string) {
    await this.db
      .update(conversations)
      .set({ course, updatedAt: sql`now()` })
      .where(eq(conversations.id, conversationId));
  }

  /**
   * When the contact last wrote, bound or not: WhatsApp's 24-hour window opens
   * on any message, not only those that carried the token (specs/025).
   */
  async lastInbound(conversationId: string): Promise<Date | null> {
    const [row] = await this.db
      .select({ at: max(turns.createdAt) })
      .from(turns)
      .where(and(eq(turns.conversationId, conversationId), eq(turns.role, 'user')));
    return row?.at ? new Date(row.at) : null;
  }

  /**
   * Counts a turn no contact started toward the turn cap, without moving the
   * idle gap: a nudge is not the contact writing (specs/025).
   */
  async countTurn(conversationId: string) {
    await this.db
      .update(conversations)
      .set({ turnCount: sql`${conversations.turnCount} + 1`, updatedAt: sql`now()` })
      .where(eq(conversations.id, conversationId));
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
        course: true,
      },
    });
  }
}
