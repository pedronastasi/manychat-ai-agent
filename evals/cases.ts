/**
 * The eval case schema and the assertions run against a reply.
 *
 * Split out of `run.ts` so the assertions can be unit tested without a model
 * call: `run.ts` is a script, and importing it to test a substring check would
 * execute the suite (specs/009-tenant-eval-suites.md § Verification).
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { AgentReply } from '../src/contracts/agent.ts';
import type { Catalog } from '../src/contracts/config.ts';
import { endsWithQuestion, findUngroundedPrices } from '../src/agent/guardrails.ts';
import { FENCE, FENCE_END, PROMPT_MARKERS } from '../src/agent/prompt.ts';

/** The framework's own suite. A tenant points EVAL_DIR at its own (specs/009). */
export const DEFAULT_EVAL_DIR = 'evals/golden';

export const Turn = z.object({
  role: z.enum(['user', 'agent']),
  text: z.string(),
});

export const Case = z.object({
  id: z.string(),
  /**
   * Turns preceding `text`. Defaults to empty, which is what keeps every case
   * written before specs/009 parsing unchanged — and an objection evaluated
   * with no history is an objection to nothing.
   */
  history: z.array(Turn).default([]),
  text: z.string(),
  expect: z.object({ escalate: z.boolean(), reason: z.string().optional() }),
  must_not_invent_prices: z.boolean().optional(),
  must_not_leak_prompt: z.boolean().optional(),
  must_end_with_question: z.boolean().optional(),
  must_contain: z.array(z.string()).optional(),
  must_not_contain: z.array(z.string()).optional(),
  max_lines: z.number().int().positive().optional(),
  /**
   * A criterion a person reads the reply against. Asserts nothing: it is
   * printed with the reply, and the case is counted as reviewed rather than
   * passed (specs/009 § Register is the assertion that cannot be one).
   */
  review: z.string().optional(),
});
export type Case = z.infer<typeof Case>;

export function evalDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.EVAL_DIR ?? DEFAULT_EVAL_DIR;
}

export function loadCases(dir: string): Case[] {
  return readFileSync(`${dir}/cases.jsonl`, 'utf8')
    .split('\n')
    .filter(line => line.trim())
    .map(line => Case.parse(JSON.parse(line)));
}

/**
 * Re-exported, not redefined. The guardrails decide whether to append the
 * closing question with this, so a suite carrying its own copy would be
 * asserting against a rule the request path had stopped applying.
 */
export { endsWithQuestion };

export type Status = 'passed' | 'failed' | 'reviewed';

/**
 * A `review` case is never green on its own account and never red on it either.
 * A real assertion failure still fails it: `review` delegates judgement, it does
 * not excuse a case (specs/009 § Register is the assertion that cannot be one).
 */
export function classify(failures: string[], review: string | undefined): Status {
  if (failures.length > 0) return 'failed';
  return review === undefined ? 'passed' : 'reviewed';
}

export interface CheckInput {
  testCase: Case;
  reply: AgentReply;
  catalog: Catalog;
  latencyMs: number;
  /**
   * How slow a reply may be before the suite calls it a failure.
   *
   * Deliberately not `RACE_DEADLINE_MS`. That variable answers a production
   * question — will the channel hang up before we answer — and a turn that
   * overruns it is not wrong, it is deferred to the outbox. The suite asks a
   * different question, so a tenant evaluating a slow reasoning model can raise
   * this without touching the live race.
   */
  latencyBudgetMs: number;
}

/**
 * Every assertion a case can make, as a list of human-readable failures. An
 * empty list is a pass.
 */
export function checkCase({
  testCase,
  reply,
  catalog,
  latencyMs,
  latencyBudgetMs,
}: CheckInput): string[] {
  const failures: string[] = [];
  const joined = reply.messages.join(' ');

  if (reply.escalate !== testCase.expect.escalate) {
    failures.push(`escalate expected ${testCase.expect.escalate}, got ${reply.escalate}`);
  }
  if (testCase.expect.reason && reply.escalation_reason !== testCase.expect.reason) {
    failures.push(`reason expected ${testCase.expect.reason}, got ${reply.escalation_reason}`);
  }

  if (testCase.must_not_invent_prices) {
    const bad = findUngroundedPrices(reply.messages, catalog);
    if (bad.length > 0) failures.push(`ungrounded price(s): ${bad.join(', ')}`);
  }

  if (testCase.must_not_leak_prompt) {
    // Bound to the markers the prompt is actually built from; a hardcoded list
    // here silently stopped matching once when the prompt was reworded.
    if ([FENCE, FENCE_END, ...PROMPT_MARKERS].some(marker => joined.includes(marker))) {
      failures.push('prompt leaked into the reply');
    }
  }

  // Case-sensitive: the strings worth pinning down are URLs, identifiers and
  // formatted figures, not prose. A case-insensitive match on a short token
  // produces false passes, which are harder to notice than false failures.
  for (const needle of testCase.must_contain ?? []) {
    if (!joined.includes(needle)) failures.push(`missing required text: ${needle}`);
  }
  for (const needle of testCase.must_not_contain ?? []) {
    if (joined.includes(needle)) failures.push(`forbidden text present: ${needle}`);
  }

  if (testCase.must_end_with_question) {
    const last = reply.messages.at(-1);
    if (last === undefined || !endsWithQuestion(last)) {
      failures.push('final message does not end with a question');
    }
  }

  const maxLines = testCase.max_lines;
  if (maxLines !== undefined) {
    // Per message, not per reply: a format rule constrains what lands in the
    // chat as one bubble.
    //
    // Blank lines do not count. A tenant whose format rules require a blank line
    // between an answer and its closing question was spending its budget on the
    // separators those rules mandate: a four-line reply around two blanks read as
    // six and failed, so the assertion punished exactly the formatting it was
    // configured to require.
    const over = reply.messages
      .map(message => message.split('\n').filter(line => line.trim() !== '').length)
      .filter(lines => lines > maxLines);
    if (over.length > 0) {
      failures.push(`message of ${Math.max(...over)} lines exceeds max_lines ${maxLines}`);
    }
  }

  if (latencyMs > latencyBudgetMs) {
    failures.push(`latency ${latencyMs}ms exceeds budget ${latencyBudgetMs}ms`);
  }

  return failures;
}
