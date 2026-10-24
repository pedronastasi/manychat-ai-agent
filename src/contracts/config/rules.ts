import { z } from 'zod';

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

/** The longest `burstWindowMs`: it leaves the model most of the race (specs/047). */
export const BURST_WINDOW_MAX_MS = 4_000;

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
   * Phrases that only the model's working notes contain, matched in a reply as
   * escalationKeywords are: case-insensitive substrings. Added to the built-in
   * markers (specs/001 § Working notes never reach the contact).
   */
  workingNoteMarkers: z.array(z.string().min(1)).default([]),
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
   * A contact who splits one message over several bubbles gets one reply
   * (specs/046). When true, a reply the model finished while the contact kept
   * writing is dropped, and their latest message's turn answers them all.
   * Bubbles that wait behind a running turn are folded whatever this says.
   */
  foldBursts: z.boolean().default(false),
  /**
   * How long a turn waits for the contact to write again before it calls the
   * model (specs/047). A bubble that arrives in that time folds this turn's
   * message into its own. The wait counts against the race deadline (C7), so
   * it is capped well inside it. 0, the default, waits for nothing.
   */
  burstWindowMs: z.number().int().min(0).max(BURST_WINDOW_MAX_MS).default(0),
  /**
   * Learning from outcomes (specs/031). Absent, no learning job runs, no
   * playbook is loaded, and the prompt is what it was before that spec.
   */
  learning: LearningSchema.optional(),
});
export type Rules = z.infer<typeof RulesSchema>;
