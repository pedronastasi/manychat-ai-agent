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
import { sql } from 'drizzle-orm';
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
    /**
     * The course this contact is buying, a catalog course id: the latest a
     * request carried, or a write to the course field this service performed
     * (specs/028). A nudge turn, which has no request, reads it from here.
     */
    course: text('course'),
    /**
     * When the opening flow was claimed for this contact: set once, by the one
     * turn that sends it, so concurrent first messages send it once (specs/032).
     */
    openingSentAt: timestamp('opening_sent_at', { withTimezone: true }),
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
    /**
     * The playbook version the model ran with, null when none was active
     * (specs/031). A version id, never insight text.
     */
    playbookVersion: text('playbook_version'),

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
  table => [
    index('outbox_claim_idx').on(table.status, table.nextAttemptAt),
    // A contact's queued replies, read on every turn and every claim to keep
    // their order (specs/037). Partial, so delivered rows never weigh on it.
    index('outbox_queued_reply_idx')
      .on(table.tenantId, table.subscriberId, table.createdAt)
      .where(sql`${table.kind} = 'reply' AND ${table.status} IN ('pending', 'delivering')`),
  ],
);

/**
 * Follow-ups the agent scheduled for a contact who went quiet (specs/025). The
 * conversation's id and nothing about the contact, so a cancelled row needs no
 * redaction (C5).
 *
 * `running` is the worker's claim: a row past it is never claimed again, so a
 * crash mid-turn loses the nudge rather than sending it twice.
 */
export const nudges = pgTable(
  'nudges',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    status: text('status', { enum: ['pending', 'running', 'sent', 'skipped', 'cancelled'] })
      .notNull()
      .default('pending'),
    cancelReason: text('cancel_reason', {
      enum: [
        'contact_replied',
        'escalated',
        'link_sent',
        'window_closing',
        'human_active',
        'read_failed',
        'cap_reached',
      ],
    }),
    /** When the pending nudge was last scheduled; a later escalation cancels it. */
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    // At most one nudge waits per contact, held by the database rather than a
    // check in code, so two processes scheduling at once cannot both insert
    // one (specs/025, specs/026 § A scheduled job runs where its claim is atomic).
    uniqueIndex('nudges_one_pending_uq')
      .on(table.conversationId)
      .where(sql`${table.status} = 'pending'`),
    index('nudges_claim_idx').on(table.status, table.dueAt),
  ],
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

/**
 * One run of the learning job (specs/031). `week` is the ISO week its claim is
 * keyed on: the replica whose insert succeeds runs, and any other skips. A
 * forced run is recorded beside the week's, outside the claim.
 *
 * Counts, cost and a status: never transcript or proposal text (C5).
 */
export const learningRuns = pgTable(
  'learning_runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: text('tenant_id').notNull(),
    week: text('week').notNull(),
    forced: boolean('forced').notNull().default(false),
    status: text('status', {
      enum: ['running', 'completed', 'insufficient', 'skipped_budget', 'failed'],
    })
      .notNull()
      .default('running'),
    enrolledCount: integer('enrolled_count'),
    notEnrolledCount: integer('not_enrolled_count'),
    /** The analyst call's cost, never added to `budget_counters`. */
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  table => [
    uniqueIndex('learning_runs_week_uq')
      .on(table.tenantId, table.week)
      .where(sql`${table.forced} = false`),
  ],
);

/**
 * A tactic the analyst proposed (specs/031). Text the analyst wrote, in the
 * reviewer's language, and the turn ids it cites: never transcript text.
 */
export const insightProposals = pgTable(
  'insight_proposals',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: text('tenant_id').notNull(),
    runId: uuid('run_id')
      .notNull()
      .references(() => learningRuns.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    rationale: text('rationale').notNull(),
    enrolledCount: integer('enrolled_count').notNull(),
    notEnrolledCount: integer('not_enrolled_count').notNull(),
    turnIds: jsonb('turn_ids').$type<string[]>().notNull(),
    status: text('status', { enum: ['pending', 'approved', 'rejected'] })
      .notNull()
      .default('pending'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [index('insight_proposals_tenant_status_idx').on(table.tenantId, table.status)],
);

/**
 * An immutable set of approved tactics (specs/031). Identified by the hash of
 * its insights; at most one per tenant is active.
 */
export const playbookVersions = pgTable(
  'playbook_versions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: text('tenant_id').notNull(),
    contentHash: text('content_hash').notNull(),
    insights: jsonb('insights').$type<string[]>().notNull(),
    active: boolean('active').notNull().default(false),
    /** The last activation. Set once a version has been live, so it can be rolled back to. */
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    uniqueIndex('playbook_versions_content_uq').on(table.tenantId, table.contentHash),
    uniqueIndex('playbook_versions_one_active_uq')
      .on(table.tenantId)
      .where(sql`${table.active} = true`),
  ],
);

/**
 * What `pnpm eval` returned for one playbook against one suite (specs/031).
 * An empty `playbookHash` is the prompt with no playbook. Case ids and their
 * asserted outcomes only.
 */
export const evalRecords = pgTable(
  'eval_records',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: text('tenant_id').notNull(),
    playbookHash: text('playbook_hash').notNull(),
    suiteHash: text('suite_hash').notNull(),
    model: text('model').notNull(),
    outcomes: jsonb('outcomes').$type<Record<string, 'passed' | 'failed' | 'reviewed'>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    index('eval_records_lookup_idx').on(table.tenantId, table.playbookHash, table.suiteHash),
  ],
);
