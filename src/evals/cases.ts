/**
 * The eval case schema and the assertions run against a reply.
 *
 * Split out of the runner so the assertions can be unit tested without a model
 * call: the runner is a script, and importing it to test a substring check
 * would execute the suite (specs/009-tenant-eval-suites.md § Verification).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { AgentReply } from '../contracts/agent.ts';
import type { Catalog } from '../contracts/config.ts';
import { endsWithQuestion, findUngroundedPrices, hasFieldEcho } from '../agent/guardrails.ts';
import { FENCE, FENCE_END, PROMPT_MARKERS } from '../agent/prompt.ts';

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
  /**
   * Runs the case as a nudge turn (specs/025): no contact message, the
   * server's trigger note after `history`. `text` is then ignored.
   */
  nudge: z.boolean().optional(),
  /**
   * What the server already knows about the contact as the turn starts: the
   * funnel stage last performed (specs/023), the offering (specs/028) and intent (specs/034).
   * Absent, the contact is new. Strict, so a case still carrying the keys
   * `agent upgrade` renames fails to load rather than losing them (specs/042).
   */
  contact: z
    .object({
      funnel_stage: z.string().optional(),
      offering: z.string().optional(),
      /** The contact's recorded intent; absent is unknown (specs/034). */
      intent: z.enum(['not_prospect', 'prospect']).optional(),
      /** The opening goes out on the turn that stages prospect (specs/034). */
      opening_due: z.boolean().optional(),
      /** The offering of the advert the contact arrived through (specs/034). */
      advert_offering: z.string().optional(),
    })
    .strict()
    .optional(),
  expect: z.object({
    escalate: z.boolean(),
    reason: z.string().optional(),
    /**
     * The actions the turn stages, as `send_flow intro_course_brochure`, in any
     * order. `[]` asserts that tools were offered and none chosen (specs/012
     * § Verification).
     */
    actions: z.array(z.string()).optional(),
  }),
  must_not_invent_prices: z.boolean().optional(),
  must_not_leak_prompt: z.boolean().optional(),
  /** True: the final message ends with a question. False: it does not. */
  must_end_with_question: z.boolean().optional(),
  must_contain: z.array(z.string()).optional(),
  must_not_contain: z.array(z.string()).optional(),
  max_lines: z.number().int().positive().optional(),
  /**
   * Criteria the reply is read against. Without a judge, each is printed with
   * the reply and the case is counted as reviewed rather than passed
   * (specs/009 § Register is the assertion that cannot be one). With a
   * calibrated judge, each is its own verdict (specs/016 § One criterion per
   * verdict). A string is a one-entry list.
   */
  review: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
});
export type Case = z.infer<typeof Case>;

export function evalDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.EVAL_DIR ?? DEFAULT_EVAL_DIR;
}

/**
 * Identifies the suite by its cases, so an eval record says which suite it
 * was run against and a changed suite needs a new record (specs/031).
 */
export function suiteHash(dir: string): string {
  return createHash('sha256')
    .update(readFileSync(`${dir}/cases.jsonl`))
    .digest('hex');
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

export type Status = 'passed' | 'failed' | 'judged-fail' | 'judged-pass' | 'reviewed';

/** A case's `review` criteria as a list: a string is a one-entry list (specs/016). */
export function reviewCriteria(review: Case['review']): string[] {
  if (review === undefined) return [];
  return typeof review === 'string' ? [review] : review;
}

/** What the judge made of one criterion; `ungraded` when its verdict cannot count. */
export type Graded = 'pass' | 'fail' | 'ungraded';

/** The judge's outcomes for a case: one per `review` entry, in order, and the rubric's. */
export interface Judged {
  review: Graded[];
  rubric: Graded[];
}

/**
 * A case's status. Assertions decide first and the judge never overrides them.
 * Without a judge, a `review` case is never green on its own account and never
 * red on it either (specs/009 § Register is the assertion that cannot be one).
 * With one, outcomes take the most severe of `failed`, `judged-fail` and
 * `reviewed`; `judged-pass` needs every `review` entry to have passed, and a
 * case without `review` stays `passed` (specs/016 § A judged failure is counted
 * apart from an asserted one).
 */
export function classify(failures: string[], review: Case['review'], judged?: Judged): Status {
  if (failures.length > 0) return 'failed';
  const criteria = reviewCriteria(review);
  if (judged && [...judged.review, ...judged.rubric].includes('fail')) return 'judged-fail';
  if (criteria.length === 0) return 'passed';
  if (
    judged &&
    judged.review.length === criteria.length &&
    judged.review.every(outcome => outcome === 'pass')
  )
    return 'judged-pass';
  return 'reviewed';
}

export interface CheckInput {
  testCase: Case;
  reply: AgentReply;
  catalog: Catalog;
  latencyMs: number;
  /** What the turn staged, or null when the tenant offers no tools (specs/012). */
  actions?: string[] | null;
  /** What the guardrails adjusted after the model returned. */
  interventions?: string[];
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
  actions = null,
  interventions = [],
}: CheckInput): string[] {
  const failures: string[] = [];
  const joined = reply.messages.join(' ');

  if (reply.escalate !== testCase.expect.escalate) {
    failures.push(`escalate expected ${testCase.expect.escalate}, got ${reply.escalate}`);
  }
  if (testCase.expect.reason && reply.escalation_reason !== testCase.expect.reason) {
    failures.push(`reason expected ${testCase.expect.reason}, got ${reply.escalation_reason}`);
  }

  const expected = testCase.expect.actions;
  if (expected !== undefined) {
    if (actions === null) {
      failures.push('actions expected, but the tenant offers no tools');
    } else {
      const sorted = (list: string[]) => [...list].sort().join(', ') || 'none';
      if (sorted(actions) !== sorted(expected)) {
        failures.push(`actions expected ${sorted(expected)}, got ${sorted(actions)}`);
      }
    }
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

  // Unconditional: no reply should ever carry one of its own fields, and the
  // guardrail strips them, so one here means the request path let it through
  // (specs/001 § Reply fields never reach the contact).
  if (reply.messages.some(hasFieldEcho)) failures.push('reply field written into the text');

  // Unconditional, and read from the interventions rather than the reply: the
  // guardrail swaps a repetition for the tenant's closer, so the reply alone
  // looks right even when the model replayed an earlier answer. The prompt rule
  // is what the suite samples (specs/013 § Verification).
  if (
    interventions.includes('duplicate_replaced') ||
    interventions.includes('duplicate_detected')
  ) {
    failures.push('reply repeated an earlier one word for word');
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

  if (testCase.must_end_with_question !== undefined) {
    const last = reply.messages.at(-1);
    const asks = last !== undefined && endsWithQuestion(last);
    if (testCase.must_end_with_question && !asks) {
      failures.push('final message does not end with a question');
    } else if (!testCase.must_end_with_question && asks) {
      // A turn whose question someone else already asked, as the opening flow
      // does (specs/032 § The opening flow is the server's, not the model's).
      failures.push('final message ends with a question');
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
