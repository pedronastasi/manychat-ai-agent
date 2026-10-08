import { isIP } from 'node:net';
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
    // One, not ten. ManyChat accepts a ten-message array on WhatsApp and
    // delivers only the first, so the platform limit and the delivered limit
    // are different numbers. Ten was the platform's; this is the one that
    // decides what a contact actually reads, and the renderer joins the rest
    // into it rather than dropping them.
    maxMessages: 1,
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

export const OfferingSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  price: Money,
  // Optional: a product has neither, and a required null is a course-shaped
  // hole every other tenant would have to fill (specs/042).
  durationHours: z.number().positive().nullable().default(null),
  schedule: z.string().nullable().default(null),
  url: z.string().url().nullable().default(null),
});
export type Offering = z.infer<typeof OfferingSchema>;

/**
 * A way to pay the tenant has published: instalments, a deposit, a
 * private-class rate. A catalog fact the agent may present, not a negotiation
 * (specs/023 § Objections are answered from the catalog).
 */
export const PaymentOptionSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
});
export type PaymentOption = z.infer<typeof PaymentOptionSchema>;

export const CatalogSchema = z.object({
  businessName: z.string().min(1),
  currency: z.string().length(3),
  offerings: z.array(OfferingSchema).min(1),
  faq: z.array(z.object({ question: z.string(), answer: z.string() })).default([]),
  paymentOptions: z
    .array(PaymentOptionSchema)
    .default([])
    .refine(
      options => new Set(options.map(option => option.id)).size === options.length,
      'payment option ids must be unique',
    ),
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
  /**
   * Asks the contact to type what they sent as a voice note, image or video
   * the agent cannot read (specs/020). Optional so no existing rules.json
   * fails to load; without it such a turn hands off with `escalation`.
   */
  mediaFallback: z
    .string()
    .min(1)
    .optional()
    .describe('Sent when the contact sent media the agent cannot read.'),
  /**
   * Replaces a reply that repeats an earlier one verbatim (specs/013). Optional
   * so no existing rules.json fails to load; without it the repetition is
   * recorded and sent as it is.
   */
  closer: z
    .string()
    .min(1)
    .optional()
    .describe('Sent in place of a reply that repeats an earlier one word for word.'),
});
export type Messages = z.infer<typeof MessagesSchema>;

/** `rules.json`'s `learning` block (specs/031 § Paid conversion is the signal). */
export const LearningSchema = z
  .object({
    /** What the analyst writes proposals in: the reviewer's language. */
    language: z.string().min(1),
    /** The ManyChat tag a person sets on seeing a payment. Never shown to the model. */
    convertedTag: z.string().min(1),
    /** Caps one analyst call. Required: any default would guess at the tenant's spend. */
    maxRunCostUsd: z.number().positive(),
  })
  .strict();
export type Learning = z.infer<typeof LearningSchema>;

export const RulesSchema = z.object({
  messages: MessagesSchema,
  confidenceThreshold: z.number().min(0).max(1).default(0.6),
  /** Counted since the contact's last gap of `idleResetHours` (specs/018). */
  maxTurnsPerConversation: z.number().int().positive().default(25),
  idleResetHours: z.number().int().positive().default(24),
  /** How far back the model's history reaches (specs/018, ADR-0013). */
  historyDays: z.number().int().positive().default(30),
  /** Checked before the model runs — an instant, free handoff. */
  escalationKeywords: z.array(z.string()).default([]),
  /**
   * A sentinel the channel flow sends to open a conversation, and the scripted
   * reply it produces. Fully determined, so the model never sees it.
   *
   * Matched on the whole message, unlike `escalationKeywords`: those match
   * substrings because a contact asking for a person may phrase it any way,
   * whereas this is emitted by the flow, and a contact who happens to type the
   * phrase must not be able to replay the opening.
   */
  openingTrigger: z
    .object({
      keywords: z.array(z.string().min(1)).min(1),
      message: z.string().min(1),
    })
    .optional(),
  budget: z.object({
    dailyTokenCap: z.number().int().positive().default(1_000_000),
    dailyCostCapUsd: z.number().positive().default(5),
  }),
  rateLimit: z.object({
    turnsPerSubscriberPerHour: z.number().int().positive().default(60),
  }),
  /**
   * Learning from outcomes (specs/031). Absent, no learning job runs, no
   * playbook is loaded, and the prompt is what it was before that spec.
   */
  learning: LearningSchema.optional(),
});
export type Rules = z.infer<typeof RulesSchema>;

/**
 * What the model names an entry by. Kept to plain identifiers because it
 * becomes an enum value in a tool's parameter schema, which every provider
 * renders into JSON Schema.
 */
const ToolEntryId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'Expected lowercase letters, digits, "_" or "-"');

/** Guidance the model reads: what the entry is and when to use it. Tenant copy. */
const ToolDescription = z.string().min(1);

const uniqueIds = (entries: { id: string }[]) =>
  new Set(entries.map(entry => entry.id)).size === entries.length;

/**
 * The stages of a sale, in order (specs/023 § The funnel is a field the agent
 * moves). A conversion is not one: only a person who has seen the payment sets
 * it, in the tenant's ManyChat account.
 */
export const FUNNEL_STAGES = [
  'new',
  'qualifying',
  'nurturing',
  'offered',
  'prepared',
  'link_sent',
] as const;

/**
 * The stage the payment link waits for, unless the contact asked to pay
 * (specs/032 § The payment link waits for readiness).
 */
export const PREPARED = 'prepared';

/** The stage the server writes when the payment-link flow is performed, never the model. */
export const LINK_SENT = 'link_sent';

/**
 * Whether the contact means to buy, in the order intent may move
 * (specs/034 § Intent is a field the model records). No value is unknown.
 */
export const INTENT_VALUES = ['not_prospect', 'prospect'] as const;

/** The intent that opens the sale's tools, and is final once recorded (specs/034). */
export const PROSPECT = 'prospect';

/**
 * The latest a nudge may be scheduled for: an hour inside WhatsApp's 24-hour
 * window, for the worker's poll, a deferred delivery and the model call. Chosen,
 * not measured (specs/025 § The agent schedules a nudge; it does not send one).
 */
export const MAX_NUDGE_MINUTES = 1380;

/**
 * When the agent may follow up on a lead who went quiet (specs/025). The model
 * names a delay by `id`; `humanActiveTag` names a tag in the tenant's ManyChat
 * account and is never shown to it.
 */
export const NudgeSchema = z.object({
  delays: z
    .array(
      z.object({
        id: ToolEntryId,
        minutes: z
          .number()
          .int()
          .positive()
          .max(MAX_NUDGE_MINUTES, `a nudge delay may not exceed ${MAX_NUDGE_MINUTES} minutes`),
      }),
    )
    .min(1)
    .refine(uniqueIds, 'delay ids must be unique'),
  humanActiveTag: z.string().min(1).optional(),
});
export type Nudge = z.infer<typeof NudgeSchema>;

/**
 * The flows, tags and field values the agent may act with (specs/012). The
 * model sees `id` and `description` only; `flowNs`, `tag` and `field` name
 * objects in the tenant's ManyChat account and stay server-side, so renaming
 * one there is a config edit no prompt depends on.
 */
/** An enum field: the model reads and writes only its configured `values` (specs/012). */
const EnumFieldEntry = z.object({
  id: ToolEntryId,
  field: z.string().min(1),
  // Never free text: a value the model composed would reach a field a
  // flow may render to the contact (specs/012 § Free-text field values
  // are refused).
  values: z
    .array(z.string().min(1))
    .min(1)
    .refine(values => new Set(values).size === values.length, 'values must be unique'),
  description: ToolDescription,
});

const TagEntry = z.object({
  id: ToolEntryId,
  tag: z.string().min(1),
  description: ToolDescription,
});

/**
 * The longest note the agent may write: a ManyChat text field with room to
 * spare. Chosen, not measured (specs/024 § Three free-text notes).
 */
export const MAX_NOTE_LENGTH = 500;

/**
 * The longest a flow may declare it takes to play (specs/030). The reply waits
 * that long after the flow is sent, in a process that has to stay up for it, so
 * the bound is kept short. Chosen, not measured.
 */
export const MAX_SETTLE_SECONDS = 30;

/**
 * A free-text field the agent may write, which the tenant declares no flow
 * renders to the contact (specs/024, ADR-0017). `neverRendered` checks
 * nothing; it makes the tenant say so in the file.
 */
/**
 * A tracking flow the server sends when the funnel advances to `stage`
 * (specs/027). The tenant's flow logs a conversion event and sends no
 * message. The model never sees an entry: not its id, not its flow.
 */
const EventEntry = z.object({
  id: ToolEntryId,
  // `new` is every contact's first stage, so an event on it reports nothing
  // the entry flow does not.
  stage: z
    .enum(FUNNEL_STAGES)
    .refine(stage => stage !== 'new', 'an event may not be keyed on stage "new"'),
  flowNs: z.string().min(1),
});

const NoteEntry = z.object({
  id: ToolEntryId,
  field: z.string().min(1),
  maxLength: z.number().int().positive().max(MAX_NOTE_LENGTH),
  neverRendered: z.literal(true, 'a note must declare "neverRendered": true'),
  /** Still written when the model or the confidence threshold escalates the turn. */
  onEscalation: z.boolean().default(false),
  description: ToolDescription,
});

export const ToolsSchema = z
  .object({
    flows: z
      .array(
        z.object({
          id: ToolEntryId,
          flowNs: z.string().min(1),
          description: ToolDescription,
          /** Exempt from "sent at most once per contact" (specs/023). */
          repeatable: z.boolean().optional(),
          /**
           * `payment_link`: performing it writes the funnel field to `link_sent`
           * (specs/023). `opening`: the server sends it on the contact's first
           * model turn, and the model never does (specs/032).
           */
          role: z.enum(['payment_link', 'opening']).optional(),
          /**
           * The funnel stage at which the server sends this flow, when the
           * model records it (specs/032 § A stage move can carry a flow).
           */
          onStage: z
            .enum(FUNNEL_STAGES)
            .refine(
              stage => stage !== 'new' && stage !== 'link_sent',
              'a flow may not be tied to stage "new" or "link_sent"',
            )
            .optional(),
          /**
           * The catalog offering this flow belongs to; absent, it serves every
           * offering (specs/028 § A flow belongs to one offering or to all).
           */
          offering: z.string().min(1).optional(),
          /**
           * How long the flow takes to play in ManyChat, Smart Delays included:
           * the reply that follows it waits this long after it is sent
           * (specs/030). Absent, it does not wait.
           */
          settleSeconds: z.number().int().min(0).max(MAX_SETTLE_SECONDS).optional(),
        }),
      )
      .default([])
      .refine(uniqueIds, 'flow ids must be unique')
      .refine(
        flows => flows.filter(flow => flow.role === 'payment_link').length <= 1,
        'only one flow may have role "payment_link"',
      )
      // One payment flow serves every offering and branches on the offering
      // field inside ManyChat (specs/028 § One payment flow serves every offering).
      .refine(
        flows => !flows.some(flow => flow.role === 'payment_link' && flow.offering !== undefined),
        'the "payment_link" flow may not have an "offering"',
      )
      // Sent once, to every contact, before anything is known of them
      // (specs/032 § The opening flow is the server's, not the model's).
      .refine(
        flows => flows.filter(flow => flow.role === 'opening').length <= 1,
        'only one flow may have role "opening"',
      )
      .refine(
        flows =>
          !flows.some(
            flow => flow.role === 'opening' && (flow.offering !== undefined || flow.repeatable),
          ),
        'the "opening" flow may not have an "offering" or be "repeatable"',
      )
      .refine(
        flows => !flows.some(flow => flow.role !== undefined && flow.onStage !== undefined),
        'the "opening" and "payment_link" flows may not have an "onStage"',
      )
      .refine(flows => {
        const tied = flows.flatMap(flow => (flow.onStage ? [flow.onStage] : []));
        return new Set(tied).size === tied.length;
      }, 'at most one flow per "onStage"'),
    tags: z.array(TagEntry).default([]).refine(uniqueIds, 'tag ids must be unique'),
    fields: z
      .array(
        EnumFieldEntry.extend({
          /** The field the agent's position in the sale is kept in (specs/023). */
          funnel: z.boolean().optional(),
          /**
           * The field the contact's offering is kept in. Its values must be
           * the catalog's offering ids, checked when the catalog is loaded
           * beside it (specs/028).
           */
          offering: z.boolean().optional(),
          /**
           * The field the contact's intent is kept in: until it is `prospect`
           * every sales tool refuses (specs/034).
           */
          intent: z.boolean().optional(),
        }),
      )
      .default([])
      .refine(uniqueIds, 'field ids must be unique')
      .refine(
        fields => fields.filter(field => field.intent).length <= 1,
        'only one field may be marked "intent"',
      )
      .refine(
        fields => !fields.some(field => field.intent && (field.funnel || field.offering)),
        'a field may not be marked both "intent" and "funnel" or "offering"',
      )
      // The values are the system's, as the funnel's stages are (specs/034).
      .refine(
        fields =>
          fields
            .filter(field => field.intent)
            .every(field => field.values.join() === INTENT_VALUES.join()),
        `an "intent" field's values must be ${INTENT_VALUES.join(', ')}, in that order`,
      )
      // A deployment that sells cannot run without the gate (specs/034).
      .refine(
        fields => !fields.some(field => field.funnel) || fields.some(field => field.intent),
        'a field marked "funnel" needs a field marked "intent"',
      )
      .refine(
        fields => fields.filter(field => field.funnel).length <= 1,
        'only one field may be marked "funnel"',
      )
      .refine(
        fields => fields.filter(field => field.offering).length <= 1,
        'only one field may be marked "offering"',
      )
      .refine(
        fields => !fields.some(field => field.funnel && field.offering),
        'a field may not be marked both "funnel" and "offering"',
      )
      // Forward-only is decided by position in this list, so a list out of
      // order would let the agent move a lead backwards.
      .refine(
        fields =>
          fields
            .filter(field => field.funnel)
            .every(field => field.values.join() === FUNNEL_STAGES.join()),
        `a "funnel" field's values must be ${FUNNEL_STAGES.join(', ')}, in that order`,
      ),
    /** Absent: `schedule_nudge` is not offered (specs/025). */
    nudge: NudgeSchema.optional(),
    /**
     * Tags and enum fields the tenant's own flows set, which `get_contact`
     * returns but no tool writes (specs/024).
     */
    readable: z
      .object({
        tags: z.array(TagEntry).default([]),
        fields: z.array(EnumFieldEntry).default([]),
      })
      .default({ tags: [], fields: [] }),
    notes: z.array(NoteEntry).default([]).refine(uniqueIds, 'note ids must be unique'),
    /** Conversion events fired on a stage advance, never offered to the model (specs/027). */
    events: z
      .array(EventEntry)
      .default([])
      .refine(uniqueIds, 'event ids must be unique')
      .refine(
        events => new Set(events.map(event => event.stage)).size === events.length,
        'at most one event per stage',
      ),
  })
  // `get_contact` returns writable and readable entries side by side, by id.
  .refine(tools => uniqueIds([...tools.tags, ...tools.readable.tags]), {
    message: 'tag ids must be unique across tags and readable.tags',
    path: ['readable', 'tags'],
  })
  .refine(tools => uniqueIds([...tools.fields, ...tools.readable.fields]), {
    message: 'field ids must be unique across fields and readable.fields',
    path: ['readable', 'fields'],
  })
  // The agent may add or remove any configured tag, so the tag that silences
  // it must not be one of them (specs/025).
  .refine(tools => !tools.tags.some(entry => entry.tag === tools.nudge?.humanActiveTag), {
    message: 'nudge.humanActiveTag may not be a tag the agent writes',
    path: ['nudge'],
  })
  // The opening goes out on the turn that records `prospect`, so without an
  // intent field it never would (specs/034 § The opening waits for a prospect).
  .refine(
    tools =>
      !tools.flows.some(flow => flow.role === 'opening') ||
      tools.fields.some(field => field.intent),
    {
      message: 'an "opening" flow needs a field marked "intent"',
      path: ['flows'],
    },
  )
  // A flow tied to a stage needs a stage to be tied to (specs/032).
  .refine(
    tools => !tools.flows.some(flow => flow.onStage) || tools.fields.some(field => field.funnel),
    {
      message: 'a flow with "onStage" needs a field marked "funnel"',
      path: ['flows'],
    },
  )
  // An event is keyed on a stage, so there must be a stage to key on (specs/027).
  .refine(tools => tools.events.length === 0 || tools.fields.some(field => field.funnel), {
    message: 'events need a field marked "funnel"',
    path: ['events'],
  })
  // A tracking flow that is also a content flow would be sent once by the
  // model and once by the server, and the event would count twice (specs/027).
  .refine(
    tools =>
      new Set([...tools.flows, ...tools.events].map(entry => entry.flowNs)).size ===
      new Set(tools.flows.map(flow => flow.flowNs)).size + tools.events.length,
    {
      message: "an event's flowNs may not be a flow's or another event's",
      path: ['events'],
    },
  );
export type Tools = z.infer<typeof ToolsSchema>;
export type Note = Tools['notes'][number];

/** A deployment with no `tools.json`: no tools are offered (specs/012). */
export const NO_TOOLS: Tools = {
  flows: [],
  tags: [],
  fields: [],
  readable: { tags: [], fields: [] },
  notes: [],
  events: [],
};

/** Whether `tools.json` gives the agent anything to act with or read, a follow-up included (specs/025). */
export function offersTools(tools: Tools): boolean {
  return (
    tools.flows.length +
      tools.tags.length +
      tools.fields.length +
      tools.notes.length +
      tools.readable.tags.length +
      tools.readable.fields.length >
      0 || tools.nudge !== undefined
  );
}

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

    CHANNEL: z.string().default('whatsapp'),
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
  });
export type Env = z.infer<typeof EnvSchema>;
