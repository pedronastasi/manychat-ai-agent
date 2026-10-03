import type { StagedAction } from '../contracts/agent.ts';
import { endsWithQuestion } from '../agent/guardrails.ts';
import { redactText } from '../observability/redact.ts';

/**
 * A reply's closing question, held back until the flows its turn sent have
 * played out (specs/029 § The question waits for the flow).
 */
export interface HeldQuestion {
  text: string;
  /** How long to wait after the turn's actions: the longest staged flow's settle time. */
  settleMs: number;
}

/** Delivers a held question; `ManyChatClient` is one. */
export interface QuestionSender {
  sendText(subscriberId: string, messages: string[]): Promise<void>;
}

export interface QuestionLogger {
  warn: (fields: object, message: string) => void;
}

/**
 * Splits the question off a reply that sends a flow.
 *
 * Held only when the turn staged a `send_flow` and the reply ends on a
 * question with something before it: a reply that is nothing but its question
 * keeps it, because the response must carry a message (specs/029 § What is
 * held). The question is the last message whichever way it got there, the
 * appended `closing_question` or the model's own question in the body
 * (specs/001 § Every reply ends with a question).
 */
export function holdQuestion(
  messages: readonly string[],
  staged: readonly StagedAction[],
): { messages: string[]; held: HeldQuestion | undefined } {
  const flows = staged.filter(action => action.tool === 'send_flow');
  const last = messages.at(-1);
  if (flows.length === 0 || messages.length < 2 || last === undefined || !endsWithQuestion(last)) {
    return { messages: [...messages], held: undefined };
  }
  const settleSeconds = Math.max(0, ...flows.map(flow => flow.settleSeconds ?? 0));
  return {
    messages: messages.slice(0, -1),
    held: { text: last, settleMs: settleSeconds * 1000 },
  };
}

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Sends a held question once its flows have had time to play out.
 *
 * Sent whether or not the flows were performed: the question is part of the
 * reply of record, and a failed flow leaves it the reply's last word, as it
 * would have been. One attempt, logged on failure and never retried, like an
 * action (specs/029 § One attempt).
 */
export async function sendHeldQuestion(
  sender: QuestionSender,
  subscriberId: string,
  held: HeldQuestion,
  logger: QuestionLogger,
  sleep: (ms: number) => Promise<void> = wait,
): Promise<void> {
  if (held.settleMs > 0) await sleep(held.settleMs);
  try {
    await sender.sendText(subscriberId, [held.text]);
  } catch (error) {
    // ManyChat's answer can quote the field value it was sent, which is the
    // question, and the subscriber it was asked about (C5).
    const raw = error instanceof Error ? error.message : String(error);
    const reason = raw.split(held.text).join('[question]').split(subscriberId).join('[subscriber]');
    logger.warn({ error: redactText(reason).slice(0, 200) }, 'held question not delivered');
  }
}
