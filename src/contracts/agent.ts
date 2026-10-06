import { z } from 'zod';

/**
 * Closed set of reasons the agent may hand a conversation to a human.
 * See specs/001-agent-behavior.md § Escalation.
 */
export const EscalationReason = z.enum([
  'price_negotiation',
  'complaint',
  'out_of_scope',
  'explicit_request',
  'low_confidence',
  // The agent cannot see a payment and must not confirm one (specs/023).
  'payment_reported',
]);
export type EscalationReason = z.infer<typeof EscalationReason>;

export const MAX_MESSAGE_CHARS = 1000;
export const MAX_MESSAGES_PER_REPLY = 3;

/**
 * Content messages plus the appended closing question.
 *
 * The model is asked for at most `MAX_MESSAGES_PER_REPLY`; guardrails append the
 * question as one more, so a validated reply can legitimately hold one extra.
 */
export const MAX_RENDERED_MESSAGES = MAX_MESSAGES_PER_REPLY + 1;

/**
 * Guidance shown to the model for `closing_question`.
 *
 * Exported because the system prompt and the schema must say the same thing: a
 * tenant reading one and not the other is how the two drift apart.
 */
export const CLOSING_QUESTION_DESCRIPTION =
  'The single question that ends this turn, or null when no question belongs ' +
  'here. Written on its own, without prices, list items or explanations — it is ' +
  'appended as the final message, so it must read as a complete question by itself.';

/**
 * The agent's structured output. Every field is validated before anything
 * reaches a customer (Constitution C3) — model output is untrusted input.
 *
 * `messages` is an array rather than a single string because chat reads better
 * as a few short messages than as one wall of text.
 */
export const AgentReply = z
  .object({
    messages: z
      .array(z.string().min(1).max(MAX_MESSAGE_CHARS))
      .min(1)
      .max(MAX_RENDERED_MESSAGES)
      .describe('Reply split the way a person types in chat: short, sequential messages.'),
    escalate: z.boolean().describe('True when a human must take over.'),
    escalation_reason: EscalationReason.nullable().describe('Non-null if and only if escalate.'),
    confidence: z.number().min(0).max(1).describe('Self-reported confidence, 0..1.'),
    closing_question: z
      .string()
      .min(1)
      .max(MAX_MESSAGE_CHARS)
      .nullable()
      .describe(CLOSING_QUESTION_DESCRIPTION),
  })
  // Enforces the "iff" in specs/001: a reason without an escalation, or an
  // escalation without a reason, is a malformed reply rather than a warning.
  .refine(reply => reply.escalate === (reply.escalation_reason !== null), {
    message: 'escalation_reason must be non-null exactly when escalate is true',
    path: ['escalation_reason'],
  });

export type AgentReply = z.infer<typeof AgentReply>;

/**
 * Shape sent to the model. The `.refine` above cannot be expressed in JSON
 * Schema, so the model is given the plain object and the refinement is applied
 * on the way back — validation, not generation, is where the rule is enforced.
 */
export const AgentReplyForModel = z.object({
  messages: z.array(z.string().min(1).max(MAX_MESSAGE_CHARS)).min(1).max(MAX_MESSAGES_PER_REPLY),
  escalate: z.boolean(),
  escalation_reason: EscalationReason.nullable(),
  confidence: z.number().min(0).max(1),
  /**
   * Required so the model must decide rather than trail off. Prose asking for a
   * closing question was followed about six turns in seven; a required field is
   * followed every time, because the reply does not validate without it.
   *
   * Nullable, not optional: a turn that should not ask — a handoff, a health
   * question, a contact already paying — states that by sending null, which is
   * a decision the reply records rather than an omission nobody can see.
   */
  closing_question: z
    .string()
    .min(1)
    .max(MAX_MESSAGE_CHARS)
    .nullable()
    .describe(CLOSING_QUESTION_DESCRIPTION),
});

/** What a contact sent when it was not text (specs/020). */
export const MediaKind = z.enum(['audio', 'image', 'video', 'unsupported']);
export type MediaKind = z.infer<typeof MediaKind>;

/**
 * A file the contact sent, as a pointer only the server resolves. Nothing past
 * the channel adapter knows what the URL looks like, and it is never stored,
 * logged or shown to the model (specs/020).
 */
export const InboundMedia = z.object({
  kind: MediaKind,
  url: z.string().url(),
});
export type InboundMedia = z.infer<typeof InboundMedia>;

/** Normalized inbound message, independent of any channel. */
export const InboundMessage = z.object({
  tenantId: z.string().min(1),
  subscriberId: z.string().min(1),
  text: z.string(),
  channel: z.string().min(1),
  contactName: z.string().nullable(),
  locale: z.string().nullable(),
  /** What the request presented as the contact's token, if anything (specs/019). */
  contactToken: z.string().nullable(),
  /** Set when `text` was a media pointer rather than something the contact typed. */
  media: InboundMedia.optional(),
  /**
   * What the request presented as the contact's course, unchecked: the turn
   * keeps it only if it is one of the course field's values (specs/028).
   */
  course: z.string().nullish(),
  receivedAt: z.date(),
});
export type InboundMessage = z.infer<typeof InboundMessage>;

/** Why a turn ended the way it did — recorded per turn for observability. */
export const TurnOutcome = z.enum([
  'answered_inline', // model won the race
  'answered_scripted', // opening-trigger sentinel; model never ran
  'deferred', // race lost; delivered via outbox
  'escalated_precheck', // keyword/budget/rate-limit escalation, model never ran
  'escalated_model', // model chose to escalate
  'failed_validation', // model output failed the schema; escalated
  'error', // unexpected failure; escalated
  'media_fallback', // media the agent cannot read; contact asked to type (specs/020)
  'nudge_sent', // a follow-up the agent started, delivered through the outbox (specs/025)
  'nudge_skipped', // a follow-up the model declined by escalating; nothing sent (specs/025)
]);
export type TurnOutcome = z.infer<typeof TurnOutcome>;

/**
 * The things the agent can do to a contact on a turn (specs/012, specs/024,
 * specs/025). `get_contact` is not one: it reads, is performed when called,
 * and leaves no record on the turn.
 */
export const ToolName = z.enum([
  'send_flow',
  'add_tag',
  'remove_tag',
  'set_field',
  'write_note',
  'schedule_nudge',
]);
export type ToolName = z.infer<typeof ToolName>;

/**
 * What a turn's `actions` entry may record: a tool the model called, or a
 * `send_event`, which no model is ever offered. The server performs it as a
 * follow-on of a funnel write (specs/027 § Every event is recorded beside the
 * write that caused it). A plugin tool is recorded as `plugin`, its name as
 * the id (specs/036).
 */
export const ActionKind = z.enum([...ToolName.options, 'send_event', 'plugin']);
export type ActionKind = z.infer<typeof ActionKind>;

/**
 * An action the model staged, resolved against `tools.json` at the moment it
 * was staged. Carries the ManyChat names it will be performed with, so it
 * never leaves the server except as a request to ManyChat: the outbox holds
 * it, the `turns` record does not (see `ActionRecord`).
 */
/**
 * A tracking flow the server sends when a funnel write advances the stage
 * (specs/027). Never staged by the model, so never a `StagedAction` itself:
 * it only rides as the follow-on of the write it reports.
 */
export const SendEventAction = z.object({
  tool: z.literal('send_event'),
  id: z.string(),
  flowNs: z.string(),
});
export type SendEventAction = z.infer<typeof SendEventAction>;

/**
 * Why the server sent a flow the model did not call: the contact's first model
 * turn, or a funnel write to the stage the flow is tied to (specs/032).
 */
export const FlowOrigin = z.enum(['opening', 'stage']);
export type FlowOrigin = z.infer<typeof FlowOrigin>;

const SetFieldAction = z.object({
  tool: z.literal('set_field'),
  id: z.string(),
  field: z.string(),
  value: z.string(),
  /**
   * Set when the field is the course field, so whoever performs the write
   * can record the contact's course without reading `tools.json` (specs/028).
   */
  course: z.literal(true).optional(),
  /**
   * Performed by the server once this write is, and only if it is: the event
   * configured for the stage it advances to. Not counted against the
   * per-turn cap (specs/027 § The event follows the stage write it records).
   */
  followOn: SendEventAction.optional(),
});

export const StagedAction = z.discriminatedUnion('tool', [
  z.object({
    tool: z.literal('send_flow'),
    id: z.string(),
    flowNs: z.string(),
    /**
     * Performed by the server once this flow is, and only if it is: the
     * payment-link flow's write of the funnel field to `link_sent`. Not
     * staged by the model and not counted against the per-turn cap
     * (specs/023 § The sale ends at the payment-link flow).
     */
    followOn: SetFieldAction.optional(),
    /** Sent by the server, not chosen by the model (specs/032). */
    origin: FlowOrigin.optional(),
    /** The payment link sent before `prepared`, on the model's word (specs/032). */
    contactAsked: z.literal(true).optional(),
  }),
  z.object({ tool: z.literal('add_tag'), id: z.string(), tag: z.string() }),
  z.object({ tool: z.literal('remove_tag'), id: z.string(), tag: z.string() }),
  SetFieldAction,
  /**
   * Free text, already cleaned when it was staged (specs/024 § Note text is
   * cleaned before it is written). `onEscalation` lets it outlive an
   * escalation the model or the confidence threshold made.
   */
  z.object({
    tool: z.literal('write_note'),
    id: z.string(),
    field: z.string(),
    text: z.string(),
    onEscalation: z.boolean(),
  }),
  /**
   * A follow-up `minutes` after the reply is delivered. Performed as a row in
   * `nudges`, never as a ManyChat request (specs/025).
   */
  z.object({ tool: z.literal('schedule_nudge'), id: z.string(), minutes: z.number() }),
  /**
   * A tool a tenant's plugin declares, `id` being its name. Its parameters
   * were validated against the declaration when it was staged, and its notes
   * cleaned and kept apart so they can be kept out of the logs as a
   * `write_note`'s text is. The plugin performs it, never ManyChat (specs/036).
   */
  z.object({
    tool: z.literal('plugin'),
    id: z.string(),
    plugin: z.string(),
    params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    notes: z.record(z.string(), z.string()).optional(),
  }),
]);
export type StagedAction = z.infer<typeof StagedAction>;

/** Everything that may reach ManyChat as an action: a staged one, or a follow-on event (specs/027). */
export type PerformableAction = StagedAction | SendEventAction;

/** What became of a staged action (specs/012 § Every staged action is recorded on its turn). */
export const ActionStatus = z.enum([
  'staged', // deferred path; waiting for the outbox worker
  'performed', // ManyChat accepted the request
  'failed', // ManyChat rejected it; `error` holds the reason
  'discarded', // the turn escalated
  'dropped_over_cap', // staged past the per-turn limit and never sent
  'dead_lettered', // its outbox row was dead-lettered, so it was never sent
]);
export type ActionStatus = z.infer<typeof ActionStatus>;

/**
 * One entry of a turn's `actions` column. Configured ids and values only,
 * never a flow namespace, tag or field name, or contact text, so the record
 * needs no redaction (C5). A note is recorded by its length, never its text
 * (specs/024 § Note text never reaches the record or the logs).
 */
export const ActionRecord = z.object({
  tool: ActionKind,
  id: z.string(),
  value: z.string().optional(),
  length: z.number().int().nonnegative().optional(),
  status: ActionStatus,
  error: z.string().optional(),
  origin: FlowOrigin.optional(),
  contactAsked: z.literal(true).optional(),
});
export type ActionRecord = z.infer<typeof ActionRecord>;
