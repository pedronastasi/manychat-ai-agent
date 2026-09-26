import {
  AgentReply,
  AgentReplyForModel,
  MAX_MESSAGE_CHARS,
  MAX_MESSAGES_PER_REPLY,
} from '../contracts/agent.ts';
import type { EscalationReason } from '../contracts/agent.ts';
import type { Catalog, Rules } from '../contracts/config.ts';
import { FENCE, FENCE_END, PROMPT_MARKERS } from './prompt.ts';

export interface GuardedReply {
  reply: AgentReply;
  /** Adjustments applied after the model returned; surfaced in logs and evals. */
  interventions: string[];
}

/**
 * Whitespace and emoji trailing the final character.
 *
 * Deliberately NOT `\p{Emoji_Component}`, which includes the ASCII digits: that
 * would strip a trailing price off the message before testing it.
 *
 * Written as an alternation rather than one character class: a class holding
 * ZWJ and the skin-tone modifiers can match half a grapheme, which is what
 * `no-misleading-character-class` exists to catch.
 */
const TRAILING_DECORATION = /(?:\s|\p{Extended_Pictographic}|️|‍|[\u{1F3FB}-\u{1F3FF}])+$/u;

/**
 * Whether a message leaves the turn on a question, ignoring the emoji a chat
 * persona signs off with.
 *
 * Lives here rather than in the eval suite because the guardrails now decide
 * with it: a check the suite and the request path disagreed on would pass the
 * suite while a contact read something else.
 */
export function endsWithQuestion(message: string): boolean {
  return message.replace(TRAILING_DECORATION, '').endsWith('?');
}

/**
 * A line that writes one of the reply's own fields into the text:
 * `confidence: 0.9`, `"escalate": false`, `**closing_question:** ...`.
 *
 * Built from the schema's keys, so a field added later is covered without
 * anyone remembering to extend a list here.
 */
const FIELD_ECHO = new RegExp(
  `^[\\s"'*_\`>-]*(?:${Object.keys(AgentReplyForModel.shape).join('|')})["'*_\`]*\\s*[:=]`,
  'i',
);

/**
 * Whether a message carries a line that echoes a reply field.
 *
 * Exported for the eval suite, which fails any reply that still carries one: a
 * suite with its own copy would pass while the request path let one through.
 */
export function hasFieldEcho(text: string): boolean {
  return text.split('\n').some(line => FIELD_ECHO.test(line));
}

/** The text without its field-echo lines, and without the gap they leave. */
function stripFieldEchoes(text: string): string {
  return text
    .split('\n')
    .filter(line => !FIELD_ECHO.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
    // A handoff has no next step to offer; the human takes the turn from here.
    closing_question: null,
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
        `schema_invalid: ${parsed.error.issues.map(issue => issue.path.join('.')).join(',')}`,
      ],
    };
  }

  let reply = parsed.data;

  // Reply fields written into the text, such as a trailing "confidence: 0.9".
  // The fields are for the system, not the contact. Only the offending lines
  // go: the rest is a good answer, and handing off over one stray line would
  // cost the contact that answer (specs/001 § Reply fields never reach the
  // contact).
  const echoed =
    reply.messages.some(hasFieldEcho) ||
    (reply.closing_question !== null && hasFieldEcho(reply.closing_question));
  if (echoed) {
    interventions.push('field_echo_stripped');
    const messages = reply.messages
      .map(message => (hasFieldEcho(message) ? stripFieldEchoes(message) : message))
      .filter(message => message.length > 0);
    if (messages.length === 0) {
      return {
        reply: escalationReply('low_confidence', rules.messages.escalation),
        interventions,
      };
    }
    const closing =
      reply.closing_question !== null && hasFieldEcho(reply.closing_question)
        ? stripFieldEchoes(reply.closing_question) || null
        : reply.closing_question;
    reply = { ...reply, messages, closing_question: closing };
  }

  // Prompt/fence leakage: the model echoing its own scaffolding back.
  const leaked = reply.messages.some(
    message =>
      message.includes(FENCE) ||
      message.includes(FENCE_END) ||
      PROMPT_MARKERS.some(marker => message.includes(marker)),
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
  const overlong = reply.messages.some(message => message.length > MAX_MESSAGE_CHARS);
  if (overlong) {
    reply = {
      ...reply,
      messages: reply.messages.map(message => message.slice(0, MAX_MESSAGE_CHARS)),
    };
    interventions.push('message_truncated');
  }

  // Appended as its own message rather than joined onto the last one. That is
  // what makes the rule structural: a reply whose body ends on a bullet or a
  // URL still ends on a question, because the question is a separate message
  // and nothing can follow it.
  //
  // Skipped on an escalation, where the tenant's handoff copy is the whole
  // reply and a sales question after it would be absurd.
  //
  // Skipped when the body already ends on a question. The prompt tells the
  // model to leave the question to the field and it mostly complies, but when
  // it writes one into the body as well, appending a second asked the contact
  // the same thing twice in a row. Prose could not close that gap — this is the
  // same reason the question became a field in the first place.
  //
  // The body's own question wins because it is the one written in context. What
  // matters is that exactly one question ends the turn, not which.
  const body = reply.messages.at(-1);
  if (reply.closing_question !== null && !reply.escalate) {
    if (body !== undefined && endsWithQuestion(body)) {
      interventions.push('closing_question_already_in_body');
    } else {
      reply = { ...reply, messages: [...reply.messages, reply.closing_question] };
    }
  }

  return { reply, interventions };
}

/** Numbers with a currency cue nearby, e.g. "$45.000", "45000 pesos". */
const PRICE_PATTERN = /(?:\$\s?)([\d][\d.,]{2,})|([\d][\d.,]{2,})\s?(?:pesos|ars|usd)/gi;

/** Digits only, so "45.000", "45,000" and "45000" compare equal. */
const digits = (value: string) => value.replace(/[.,]/g, '');

/**
 * Flags prices that do not appear in the catalog.
 *
 * Used by the eval suite rather than the request path: the check is a heuristic
 * over numbers in text, and blocking live replies on a heuristic would trade a
 * rare invented price for frequent false escalations. In evals it is exactly the
 * right tool, because a human reads the failures.
 *
 * Grounding reads the catalog's prose as well as `price.amount`. A tenant whose
 * offering has tiers — a web-only discount, a deposit, a balance — documents
 * those figures in an FAQ answer or a course description, because `price` holds
 * one number per course and cannot express them. Grounding against `price` alone
 * flagged every correct mention of such a figure, which is the failure mode that
 * gets the whole assertion switched off.
 */
export function findUngroundedPrices(messages: string[], catalog: Catalog): string[] {
  const allowed = new Set<string>();

  for (const course of catalog.courses) {
    const major = course.price.amount / 100;
    allowed.add(digits(String(major)));
    allowed.add(digits(String(course.price.amount)));
    allowed.add(digits(major.toLocaleString('es-AR')));
    allowed.add(digits(major.toLocaleString('en-US')));
  }

  const prose = [
    ...catalog.courses.map(course => course.description),
    ...catalog.faq.map(entry => entry.answer),
  ].join(' ');
  for (const match of prose.matchAll(PRICE_PATTERN)) {
    allowed.add(digits((match[1] ?? match[2] ?? '').trim()));
  }

  const found: string[] = [];
  for (const message of messages) {
    for (const match of message.matchAll(PRICE_PATTERN)) {
      const value = (match[1] ?? match[2] ?? '').trim();
      if (!allowed.has(digits(value))) found.push(value);
    }
  }
  return found;
}
