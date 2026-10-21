import { isIP } from 'node:net';
import { z } from 'zod';
import { CHANNEL_CAPABILITIES } from './channels.ts';

/**
 * Treats an empty env var as unset.
 *
 * `.env` files conventionally carry empty placeholders (`MANYCHAT_API_TOKEN=`),
 * and `.optional()` alone accepts only `undefined`, so an empty value would fail
 * validation and stop the process from booting at all.
 */
const emptyAsUnset = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optionalString = z.preprocess(emptyAsUnset, z.string().min(1).optional());

const MODEL_SPEC = /^[a-z0-9_-]+:[A-Za-z0-9._:-]+$/;

const csv = (raw: string) =>
  raw
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);

const PROXY_PRESETS = new Set(['loopback', 'linklocal', 'uniquelocal']);

function isProxyAddress(entry: string): boolean {
  if (PROXY_PRESETS.has(entry)) return true;
  const [address = '', prefix, ...rest] = entry.split('/');
  const family = isIP(address);
  if (family === 0 || rest.length > 0) return false;
  if (prefix === undefined) return true;
  const bits = Number(prefix);
  return /^\d+$/.test(prefix) && bits <= (family === 4 ? 32 : 128);
}

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    /** `provider:model` — the whole model-agnosticism story (ADR-0002). */
    AGENT_MODEL: z.string().regex(MODEL_SPEC, 'Expected "provider:model"'),
    AGENT_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(400),
    AGENT_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.3),
    /**
     * How hard a reasoning model deliberates before answering. Unset by default
     * so non-reasoning models are sent nothing at all.
     *
     * It matters because reasoning is charged and capped as OUTPUT: a model that
     * deliberates past AGENT_MAX_OUTPUT_TOKENS never emits the structured reply,
     * generateText throws, and the turn fails closed to a human. A front desk
     * answering from a fixed catalog gains little from deliberation, so 'low' or
     * 'minimal' buys latency and cost back.
     */
    AGENT_REASONING_EFFORT: z
      .enum(['minimal', 'low', 'medium', 'high'])
      .optional()
      .describe('Reasoning models only. Ignored by providers that do not support it.'),

    /**
     * Turns voice notes and video soundtracks into text (specs/020). A second
     * model rather than a setting on AGENT_MODEL: not every answering model
     * takes audio. Unset sends voice notes to the media fallback.
     */
    TRANSCRIPTION_MODEL: z.preprocess(
      emptyAsUnset,
      z.string().regex(MODEL_SPEC, 'Expected "provider:model"').optional(),
    ),

    /**
     * The analyst of the weekly learning job (specs/031). Off the request path,
     * so a model apart from AGENT_MODEL. Unset, the job does not run.
     */
    INSIGHT_MODEL: z.preprocess(
      emptyAsUnset,
      z.string().regex(MODEL_SPEC, 'Expected "provider:model"').optional(),
    ),

    /** The channel of a request that names none (specs/048). */
    CHANNEL: z.string().default('whatsapp'),
    /**
     * The channels this deployment answers, comma-separated (specs/048 § The
     * channel belongs to the request). Unset, it is `CHANNEL` alone.
     */
    CHANNELS: z.preprocess(emptyAsUnset, z.string().transform(csv).optional()),
    // ManyChat refuses a non-HTTPS callback, and the response schema refuses it
    // before that, so an http:// base would fail every turn rather than boot
    // (specs/017 § Callbacks are HTTPS or the process does not boot).
    PUBLIC_BASE_URL: z
      .string()
      .url()
      .startsWith('https://', 'PUBLIC_BASE_URL must be https://')
      .describe('HTTPS base for external_message_callback.'),

    /**
     * The proxies whose X-Forwarded-For is believed, as addresses, CIDR ranges
     * or proxy-addr presets. Empty trusts none, so `req.ip` is the socket peer
     * (specs/017 § Rate limiting is attached before any route).
     */
    TRUST_PROXY: z
      .string()
      .default('')
      .transform(csv)
      .refine(entries => entries.every(isProxyAddress), {
        message: 'Expected addresses, CIDR ranges, or loopback|linklocal|uniquelocal',
      }),

    /** Comma-separated to allow rotation without flow downtime (ADR-0012). */
    MANYCHAT_SHARED_SECRET: z.string().min(16).transform(csv),
    MANYCHAT_API_TOKEN: optionalString,
    MANYCHAT_API_BASE: z.string().url().default('https://api.manychat.com'),
    // Both name objects inside the tenant's ManyChat account, not in this repo.
    // Renaming either there breaks delivery at runtime and no test can see it
    // (specs/002-channel-contract.md § Verification).
    MANYCHAT_REPLY_FIELD: z.string().min(1).default('ai_message'),
    MANYCHAT_REPLY_FLOW_NS: optionalString,
    /** The reply flows of the other channels, authored per channel (specs/048). */
    MANYCHAT_REPLY_FLOW_NS_INSTAGRAM: optionalString,
    MANYCHAT_REPLY_FLOW_NS_MESSENGER: optionalString,
    /**
     * The pause before each deferred reply message after the first, and
     * between two replies to one contact (specs/002 § Messages to one contact
     * are paced).
     */
    MANYCHAT_REPLY_GAP_MS: z.coerce.number().int().min(0).max(10_000).default(2_000),
    /** The contact's custom field that holds their token (specs/019, ADR-0012). */
    MANYCHAT_TOKEN_FIELD: z.string().min(1).default('ai_token'),
    /**
     * For the rollout only. False lets a request without the contact's token
     * read history as before specs/019, while tokens reach existing contacts.
     */
    CONTACT_TOKENS_ENFORCED: z
      .enum(['true', 'false'])
      .default('true')
      .transform(value => value === 'true'),

    DATABASE_URL: z.string().min(1),
    TENANT_ID: z.string().min(1).default('demo'),

    RACE_DEADLINE_MS: z.coerce.number().int().positive().default(8_000),
    /** Outer safety net for the deferred continuation; see the refine below. */
    MODEL_ABORT_MS: z.coerce.number().int().positive().default(30_000),

    OLLAMA_BASE_URL: z.string().url().default('http://localhost:11434/v1'),

    ANTHROPIC_API_KEY: optionalString,
    OPENAI_API_KEY: optionalString,
    GOOGLE_GENERATIVE_AI_API_KEY: optionalString,
  })
  // Losing the race must not cancel the model call - it continues and delivers
  // through the outbox (ADR-0001). If the abort fired first it would kill every
  // slow turn instead, and the deferred path could never run.
  .refine(env => env.MODEL_ABORT_MS > env.RACE_DEADLINE_MS, {
    message: 'MODEL_ABORT_MS must be greater than RACE_DEADLINE_MS',
    path: ['MODEL_ABORT_MS'],
  })
  .refine(env => isKnownChannel(env.CHANNEL), {
    message: `CHANNEL must be one of ${Object.keys(CHANNEL_CAPABILITIES).join(', ')}`,
    path: ['CHANNEL'],
  })
  .refine(env => (env.CHANNELS ?? []).every(isKnownChannel), {
    message: `CHANNELS may list only ${Object.keys(CHANNEL_CAPABILITIES).join(', ')}`,
    path: ['CHANNELS'],
  })
  .refine(env => acceptedChannels(env).includes(env.CHANNEL), {
    message: 'CHANNELS must include CHANNEL, the channel of a request that names none',
    path: ['CHANNELS'],
  })
  // A channel accepted with no flow to defer its replies through would strand
  // every race it lost (specs/048 § A reply goes to the channel of the turn it
  // answers, C6). Without an API token nothing is deferred at all.
  .refine(
    env =>
      !env.MANYCHAT_API_TOKEN ||
      acceptedChannels(env)
        .filter(channel => OWN_REPLY_FLOW.has(channel))
        .every(channel => replyFlowFor(env, channel) !== undefined),
    {
      message: 'Instagram and Messenger in CHANNELS need MANYCHAT_REPLY_FLOW_NS_<CHANNEL>',
      path: ['CHANNELS'],
    },
  );
export type Env = z.infer<typeof EnvSchema>;

/** The channels whose reply flow has a variable of its own (specs/048). */
const OWN_REPLY_FLOW: ReadonlySet<string> = new Set(['instagram', 'messenger']);

/** The configured flows of the channels that have their own, by channel (specs/048). */
export function ownReplyFlows(env: ChannelEnv): Record<string, string> {
  return Object.fromEntries(
    [...OWN_REPLY_FLOW].flatMap(channel => {
      const flow = replyFlowFor(env, channel);
      return flow === undefined ? [] : [[channel, flow]];
    }),
  );
}

function isKnownChannel(channel: string): boolean {
  return Object.hasOwn(CHANNEL_CAPABILITIES, channel);
}

/** What the channel helpers read; spelled out, since the schema's own refines call them. */
interface ChannelEnv {
  CHANNEL: string;
  CHANNELS?: string[] | undefined;
  MANYCHAT_REPLY_FLOW_NS?: string | undefined;
  MANYCHAT_REPLY_FLOW_NS_INSTAGRAM?: string | undefined;
  MANYCHAT_REPLY_FLOW_NS_MESSENGER?: string | undefined;
}

/** The channels a request may name (specs/048). */
export function acceptedChannels(env: Pick<ChannelEnv, 'CHANNEL' | 'CHANNELS'>): string[] {
  return env.CHANNELS ?? [env.CHANNEL];
}

/**
 * The flow that renders a deferred reply on `channel` (specs/048). A channel
 * without one of its own, such as WhatsApp, uses `MANYCHAT_REPLY_FLOW_NS`.
 */
export function replyFlowFor(env: ChannelEnv, channel: string): string | undefined {
  if (channel === 'instagram') return env.MANYCHAT_REPLY_FLOW_NS_INSTAGRAM;
  if (channel === 'messenger') return env.MANYCHAT_REPLY_FLOW_NS_MESSENGER;
  return env.MANYCHAT_REPLY_FLOW_NS;
}
