import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  numeric,
  date,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';

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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [uniqueIndex('conversations_tenant_subscriber_uq').on(t.tenantId, t.subscriberId)],
);

export const turns = pgTable(
  'turns',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['user', 'agent'] }).notNull(),
    text: text('text').notNull(),
    outcome: text('outcome'),
    model: text('model'),

    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    /** Proves prompt caching is working; see src/agent/prompt.ts. */
    cacheReadTokens: integer('cache_read_tokens'),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }),
    latencyMs: integer('latency_ms'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [index('turns_conversation_created_idx').on(t.conversationId, t.createdAt)],
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
  t => [index('outbox_claim_idx').on(t.status, t.nextAttemptAt)],
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
  t => [primaryKey({ columns: [t.tenantId, t.day] })],
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
  t => [primaryKey({ columns: [t.tenantId, t.subscriberId, t.windowStart] })],
);
