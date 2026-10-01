import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  serial,
  numeric,
  date,
  index,
  uniqueIndex,
  primaryKey,
  boolean,
} from 'drizzle-orm/pg-core';
import type { ActionRecord } from '../contracts/agent.ts';

/**
 * All tables are tenant-scoped from the first migration. Retrofitting a tenant
 * column onto a live conversation table is a migration nobody enjoys.
 */

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: text('tenant_id').notNull(),
    subscriberId: text('subscriber_id').notNull(),
    channel: text('channel').notNull(),
    turnCount: integer('turn_count').notNull().default(0),
    escalatedAt: timestamp('escalated_at', { withTimezone: true }),
    /** The contact's latest message; a gap since it resets the turn cap (specs/018). */
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * SHA-256 of the contact's token, which ManyChat holds in a custom field
     * (specs/019, ADR-0012). The token itself is never stored.
     */
    tokenHash: text('token_hash'),
    /** The token issued before the current one, still accepted until the next issue. */
    previousTokenHash: text('previous_token_hash'),
    tokenIssuedAt: timestamp('token_issued_at', { withTimezone: true }),
    /** Counts issues, so a retried write can tell whether a newer token superseded it. */
    tokenGeneration: integer('token_generation').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    uniqueIndex('conversations_tenant_subscriber_uq').on(table.tenantId, table.subscriberId),
  ],
);

export const turns = pgTable(
  'turns',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    seq: serial('seq').notNull(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['user', 'agent'] }).notNull(),
    text: text('text').notNull(),
    outcome: text('outcome'),
    model: text('model'),
    /**
     * Whether the request carried the contact's token. Only bound turns enter
     * history or the turn cap (specs/019); turns from before it are all bound.
     */
    bound: boolean('bound').notNull().default(true),
    /**
     * What the contact sent when it was not typed text, so a transcript can be
     * told apart from a typed message. `text` then holds the transcript or a
     * marker such as `[image]`, never the media URL (specs/020).
     */
    mediaKind: text('media_kind', { enum: ['audio', 'image', 'video', 'unsupported'] }),
    /**
     * Every action the agent staged on this turn and what became of it
     * (specs/012). Null when no tool was offered, `[]` when tools were offered
     * and none chosen. Configured ids only, so it needs no redaction.
     */
    actions: jsonb('actions').$type<ActionRecord[]>(),

    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    /** Proves prompt caching is working; see src/agent/prompt.ts. */
    cacheReadTokens: integer('cache_read_tokens'),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }),
    latencyMs: integer('latency_ms'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [index('turns_conversation_created_idx').on(table.conversationId, table.createdAt)],
);

/**
 * Deferred replies (ADR-0004). Written in the same transaction as the turn, so a
 * reply can never be recorded without being queued.
 */
export const outbox = pgTable(
  'outbox',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: text('tenant_id').notNull(),
    subscriberId: text('subscriber_id').notNull(),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'cascade',
    }),
    /** A deferred reply, or a contact token whose write has to be retried (specs/019). */
    kind: text('kind', { enum: ['reply', 'contact_token'] })
      .notNull()
      .default('reply'),
    payload: jsonb('payload').notNull(),
    status: text('status', { enum: ['pending', 'delivering', 'delivered', 'failed'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  // The worker's claim query orders by this; without the index it degrades to a
  // sequential scan once the table accumulates delivered rows.
  table => [index('outbox_claim_idx').on(table.status, table.nextAttemptAt)],
);

/** Daily spend caps (Constitution C6: fail closed, toward a human). */
export const budgetCounters = pgTable(
  'budget_counters',
  {
    tenantId: text('tenant_id').notNull(),
    day: date('day').notNull(),
    tokens: integer('tokens').notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
  },
  table => [primaryKey({ columns: [table.tenantId, table.day] })],
);

/** Per-subscriber rate limiting, in the same store as everything else. */
export const rateCounters = pgTable(
  'rate_counters',
  {
    tenantId: text('tenant_id').notNull(),
    subscriberId: text('subscriber_id').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count: integer('count').notNull().default(0),
  },
  table => [primaryKey({ columns: [table.tenantId, table.subscriberId, table.windowStart] })],
);
