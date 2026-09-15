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
]);
export type EscalationReason = z.infer<typeof EscalationReason>;

export const MAX_MESSAGE_CHARS = 1000;
export const MAX_MESSAGES_PER_REPLY = 3;

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
      .max(MAX_MESSAGES_PER_REPLY)
      .describe('Reply split the way a person types in chat: short, sequential messages.'),
    escalate: z.boolean().describe('True when a human must take over.'),
    escalation_reason: EscalationReason.nullable().describe('Non-null if and only if escalate.'),
    confidence: z.number().min(0).max(1).describe('Self-reported confidence, 0..1.'),
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
});

/** Normalized inbound message, independent of any channel. */
export const InboundMessage = z.object({
  tenantId: z.string().min(1),
  subscriberId: z.string().min(1),
  text: z.string(),
  channel: z.string().min(1),
  contactName: z.string().nullable(),
  locale: z.string().nullable(),
  receivedAt: z.date(),
});
export type InboundMessage = z.infer<typeof InboundMessage>;

/** Why a turn ended the way it did — recorded per turn for observability. */
export const TurnOutcome = z.enum([
  'answered_inline', // model won the race
  'deferred', // race lost; delivered via outbox
  'escalated_precheck', // keyword/budget/rate-limit escalation, model never ran
  'escalated_model', // model chose to escalate
  'failed_validation', // model output failed the schema; escalated
  'error', // unexpected failure; escalated
]);
export type TurnOutcome = z.infer<typeof TurnOutcome>;
