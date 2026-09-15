import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Channel capabilities                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Channel differences are data, not branches (ADR-0005). The renderer consults
 * this rather than testing `if (channel === 'whatsapp')`.
 */
export const ChannelCapabilities = z.object({
  /** WhatsApp and Telegram silently drop quick replies — omit the key entirely. */
  supportsQuickReplies: z.boolean(),
  maxButtonsPerMessage: z.number().int().nonnegative(),
  maxMessages: z.number().int().positive(),
  maxActions: z.number().int().nonnegative(),
});
export type ChannelCapabilities = z.infer<typeof ChannelCapabilities>;

export const CHANNEL_CAPABILITIES: Record<string, ChannelCapabilities> = {
  whatsapp: {
    supportsQuickReplies: false,
    maxButtonsPerMessage: 3,
    maxMessages: 10,
    maxActions: 5,
  },
  instagram: {
    supportsQuickReplies: true,
    maxButtonsPerMessage: 3,
    maxMessages: 10,
    maxActions: 5,
  },
  messenger: {
    supportsQuickReplies: true,
    maxButtonsPerMessage: 3,
    maxMessages: 10,
    maxActions: 5,
  },
  telegram: {
    supportsQuickReplies: false,
    maxButtonsPerMessage: 10,
    maxMessages: 10,
    maxActions: 5,
  },
};

export function capabilitiesFor(channel: string): ChannelCapabilities {
  const caps = CHANNEL_CAPABILITIES[channel];
  if (!caps) {
    throw new Error(
      `Unknown channel '${channel}'. Known: ${Object.keys(CHANNEL_CAPABILITIES).join(', ')}`,
    );
  }
  return caps;
}

/* -------------------------------------------------------------------------- */
/* Tenant configuration files                                                  */
/* -------------------------------------------------------------------------- */

/** Prices are integers in minor units with an explicit currency (specs/003). */
export const Money = z.object({
  amount: z.number().int().nonnegative().describe('Minor units, e.g. cents.'),
  currency: z.string().length(3).describe('ISO 4217, e.g. ARS, USD.'),
});
export type Money = z.infer<typeof Money>;

export const CourseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  price: Money,
  durationHours: z.number().positive().nullable(),
  schedule: z.string().nullable(),
  enrollmentUrl: z.string().url().nullable(),
});
export type Course = z.infer<typeof CourseSchema>;

export const CatalogSchema = z.object({
  businessName: z.string().min(1),
  currency: z.string().length(3),
  courses: z.array(CourseSchema).min(1),
  faq: z.array(z.object({ question: z.string(), answer: z.string() })).default([]),
});
export type Catalog = z.infer<typeof CatalogSchema>;

/**
 * Copy a contact actually receives. Required, with no default in source: a
 * missing value must fail at boot rather than silently emitting English at a
 * contact who does not read it (Constitution C9).
 */
export const MessagesSchema = z.object({
  acknowledgement: z
    .string()
    .min(1)
    .describe('Sent when the model loses the race and the reply is deferred.'),
  escalation: z.string().min(1).describe('Sent whenever the turn hands off to a human.'),
});
export type Messages = z.infer<typeof MessagesSchema>;

export const RulesSchema = z.object({
  messages: MessagesSchema,
  confidenceThreshold: z.number().min(0).max(1).default(0.6),
  maxTurnsPerConversation: z.number().int().positive().default(25),
  /** Checked before the model runs — an instant, free handoff. */
  escalationKeywords: z.array(z.string()).default([]),
  budget: z.object({
    dailyTokenCap: z.number().int().positive().default(1_000_000),
    dailyCostCapUsd: z.number().positive().default(5),
  }),
  rateLimit: z.object({
    turnsPerSubscriberPerHour: z.number().int().positive().default(60),
  }),
});
export type Rules = z.infer<typeof RulesSchema>;

/* -------------------------------------------------------------------------- */
/* Environment                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Treats an empty env var as unset.
 *
 * `.env` files conventionally carry empty placeholders (`MANYCHAT_API_TOKEN=`),
 * and `.optional()` alone accepts only `undefined`, so an empty value would fail
 * validation and stop the process from booting at all.
 */
const optionalString = z.preprocess(
  v => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().min(1).optional(),
);

const csv = (v: string) =>
  v
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    /** `provider:model` — the whole model-agnosticism story (ADR-0002). */
    AGENT_MODEL: z.string().regex(/^[a-z0-9_-]+:[A-Za-z0-9._-]+$/, 'Expected "provider:model"'),
    AGENT_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(400),
    AGENT_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.3),

    CHANNEL: z.string().default('whatsapp'),
    PUBLIC_BASE_URL: z.string().url().describe('HTTPS base for external_message_callback.'),

    /** Comma-separated to allow rotation without flow downtime (ADR-0006). */
    MANYCHAT_SHARED_SECRET: z.string().min(16).transform(csv),
    MANYCHAT_API_TOKEN: optionalString,
    MANYCHAT_API_BASE: z.string().url().default('https://api.manychat.com'),

    DATABASE_URL: z.string().min(1),
    TENANT_ID: z.string().min(1).default('demo'),

    RACE_DEADLINE_MS: z.coerce.number().int().positive().default(8_000),
    /** Outer safety net for the deferred continuation; see the refine below. */
    MODEL_ABORT_MS: z.coerce.number().int().positive().default(30_000),

    ANTHROPIC_API_KEY: optionalString,
    OPENAI_API_KEY: optionalString,
    GOOGLE_GENERATIVE_AI_API_KEY: optionalString,
  })
  // Losing the race must not cancel the model call - it continues and delivers
  // through the outbox (ADR-0001). If the abort fired first it would kill every
  // slow turn instead, and the deferred path could never run.
  .refine(e => e.MODEL_ABORT_MS > e.RACE_DEADLINE_MS, {
    message: 'MODEL_ABORT_MS must be greater than RACE_DEADLINE_MS',
    path: ['MODEL_ABORT_MS'],
  });
export type Env = z.infer<typeof EnvSchema>;
