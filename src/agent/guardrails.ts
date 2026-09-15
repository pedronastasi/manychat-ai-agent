import { AgentReply, MAX_MESSAGE_CHARS, MAX_MESSAGES_PER_REPLY } from '../contracts/agent.ts';
import type { EscalationReason } from '../contracts/agent.ts';
import type { Catalog, Rules } from '../contracts/config.ts';
import { FENCE, FENCE_END, PROMPT_MARKERS } from './prompt.ts';

export interface GuardedReply {
  reply: AgentReply;
  /** Adjustments applied after the model returned; surfaced in logs and evals. */
  interventions: string[];
}

/**
 * Deterministic escalation used whenever the model must not or cannot decide.
 *
 * The message is supplied by the caller from tenant configuration; this module
 * deliberately owns no customer-facing text (Constitution C9).
 */
export function escalationReply(reason: EscalationReason, message: string): AgentReply {
  return {
    messages: [message],
    escalate: true,
    escalation_reason: reason,
    confidence: 1,
  };
}

/**
 * Applies everything that must hold regardless of what the model produced
 * (Constitution C3). Model output is untrusted input: it is validated, clamped,
 * and checked for leakage before any of it can reach a customer.
 */
export function applyGuardrails(raw: unknown, rules: Rules): GuardedReply {
  const interventions: string[] = [];

  const parsed = AgentReply.safeParse(raw);
  if (!parsed.success) {
    // A malformed reply is never repaired into a customer-facing answer — the
    // model failed to follow the contract, so a human takes the turn.
    return {
      reply: escalationReply('low_confidence', rules.messages.escalation),
      interventions: [
        `schema_invalid: ${parsed.error.issues.map(i => i.path.join('.')).join(',')}`,
      ],
    };
  }

  let reply = parsed.data;

  // Prompt/fence leakage: the model echoing its own scaffolding back.
  const leaked = reply.messages.some(
    m =>
      m.includes(FENCE) ||
      m.includes(FENCE_END) ||
      PROMPT_MARKERS.some(marker => m.includes(marker)),
  );
  if (leaked) {
    return {
      reply: escalationReply('low_confidence', rules.messages.escalation),
      interventions: ['prompt_leak_detected'],
    };
  }

  // Low confidence forces a handoff even when the model was happy to answer.
  if (!reply.escalate && reply.confidence < rules.confidenceThreshold) {
    interventions.push(`confidence_below_threshold: ${reply.confidence}`);
    reply = escalationReply('low_confidence', rules.messages.escalation);
  }

  // Defensive clamps. The schema already bounds these, so reaching them means
  // something upstream changed; record it rather than failing the turn.
  if (reply.messages.length > MAX_MESSAGES_PER_REPLY) {
    reply = { ...reply, messages: reply.messages.slice(0, MAX_MESSAGES_PER_REPLY) };
    interventions.push('messages_truncated');
  }
  const overlong = reply.messages.some(m => m.length > MAX_MESSAGE_CHARS);
  if (overlong) {
    reply = { ...reply, messages: reply.messages.map(m => m.slice(0, MAX_MESSAGE_CHARS)) };
    interventions.push('message_truncated');
  }

  return { reply, interventions };
}

/**
 * Flags prices that do not appear in the catalog.
 *
 * Used by the eval suite rather than the request path: the check is a heuristic
 * over numbers in text, and blocking live replies on a heuristic would trade a
 * rare invented price for frequent false escalations. In evals it is exactly the
 * right tool, because a human reads the failures.
 */
export function findUngroundedPrices(messages: string[], catalog: Catalog): string[] {
  const allowed = new Set<string>();
  for (const c of catalog.courses) {
    const major = c.price.amount / 100;
    allowed.add(String(major));
    allowed.add(String(c.price.amount));
    allowed.add(major.toLocaleString('es-AR'));
    allowed.add(major.toLocaleString('en-US'));
  }
  const found: string[] = [];
  for (const m of messages) {
    // Numbers with a currency cue nearby, e.g. "$45.000", "45000 pesos".
    for (const match of m.matchAll(
      /(?:\$\s?)([\d][\d.,]{2,})|([\d][\d.,]{2,})\s?(?:pesos|ars|usd)/gi,
    )) {
      const value = (match[1] ?? match[2] ?? '').trim();
      const normalized = value.replace(/[.,]/g, '');
      const isKnown = [...allowed].some(a => a.replace(/[.,]/g, '') === normalized);
      if (!isKnown) found.push(value);
    }
  }
  return found;
}
