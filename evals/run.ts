/**
 * Replays an eval suite through the CURRENT prompt and config, and reports
 * where behavior drifted.
 *
 * This is the regression test for prompt edits — the thing no SDK provides and
 * the reason a wording change can otherwise silently break escalation. It is
 * also the only place the ungrounded-price heuristic is enforced, because a
 * human reads the failures here (see guardrails.findUngroundedPrices).
 *
 *   pnpm eval              # against AGENT_MODEL (spends money on a real one)
 *   pnpm eval:mock         # offline, deterministic, free
 *
 * EVAL_DIR selects the suite and CONFIG_DIR the tenant it runs against. Both
 * default to the framework's own, so a fresh clone needs neither
 * (specs/009-tenant-eval-suites.md).
 */
import { loadEnv, loadTenantConfig } from '../src/config/loader.ts';
import { resolveModel } from '../src/agent/registry.ts';
import { GenerateTextRunner } from '../src/agent/runner.ts';
import { checkCase, classify, evalDir, loadCases, type Status } from './cases.ts';

interface Outcome {
  id: string;
  status: Status;
  failures: string[];
  latencyMs: number;
  costUsd: number;
}

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const MARKS: Record<Status, string> = {
  passed: `${GREEN}pass${RESET}`,
  failed: `${RED}FAIL${RESET}`,
  reviewed: `${YELLOW}read${RESET}`,
};

async function main() {
  const env = loadEnv();
  const configDir = process.env.CONFIG_DIR ?? 'config';
  const suiteDir = evalDir();

  const tenant = loadTenantConfig(configDir);
  const cases = loadCases(suiteDir);

  // Defaults to the race deadline, so a suite that sets nothing behaves as
  // before. A tenant evaluating a reasoning model raises this rather than
  // RACE_DEADLINE_MS, which the live request path depends on.
  const latencyBudgetMs = Number(process.env.EVAL_MAX_LATENCY_MS ?? env.RACE_DEADLINE_MS);

  const runner = new GenerateTextRunner({
    model: resolveModel(env.AGENT_MODEL),
    modelSpec: env.AGENT_MODEL,
    config: () => tenant,
    maxOutputTokens: env.AGENT_MAX_OUTPUT_TOKENS,
    temperature: env.AGENT_TEMPERATURE,
    reasoningEffort: env.AGENT_REASONING_EFFORT,
  });

  console.log(`\n  model: ${env.AGENT_MODEL}   suite: ${suiteDir}   cases: ${cases.length}\n`);

  const outcomes: Outcome[] = [];
  for (const testCase of cases) {
    // Bounded the way the live request path bounds it (routes/turn.ts). Without
    // a signal the call is unbounded, and `latencyMs` spans the SDK's retries
    // and their backoff as well as the generation: one provider blip turned a
    // case whose reply was correct into a 56s latency failure, which reads as a
    // prompt problem and is not one. Aborting at the budget keeps the number
    // attributable and stops a flake dragging out the whole run.
    const deadline = AbortSignal.timeout(latencyBudgetMs);
    let result;
    try {
      result = await runner.run({
        text: testCase.text,
        history: testCase.history,
        signal: deadline,
      });
    } catch (error) {
      // The runner rethrows an abort so a caller can tell "too slow" apart from
      // "model misbehaved". Keyed off the signal rather than the error name,
      // which the SDK is free to wrap.
      if (!deadline.aborted) throw error;
      const failures = [`latency exceeds budget ${latencyBudgetMs}ms`];
      outcomes.push({
        id: testCase.id,
        status: 'failed',
        failures,
        latencyMs: latencyBudgetMs,
        costUsd: 0,
      });
      console.log(
        `  ${MARKS.failed}  ${testCase.id.padEnd(28)} ${DIM}>${latencyBudgetMs}ms${RESET}`,
      );
      for (const failure of failures) console.log(`        ${RED}${failure}${RESET}`);
      continue;
    }
    const failures = checkCase({
      testCase,
      reply: result.reply,
      catalog: tenant.catalog,
      latencyMs: result.latencyMs,
      latencyBudgetMs,
    });

    const status = classify(failures, testCase.review);

    outcomes.push({
      id: testCase.id,
      status,
      failures,
      latencyMs: result.latencyMs,
      costUsd: result.usage.costUsd,
    });

    console.log(
      `  ${MARKS[status]}  ${testCase.id.padEnd(28)} ${DIM}${result.latencyMs}ms${RESET}`,
    );
    for (const failure of failures) console.log(`        ${RED}${failure}${RESET}`);
    if (result.interventions.length > 0)
      console.log(`        ${DIM}interventions: ${result.interventions.join(', ')}${RESET}`);
    // The criterion is printed next to the reply so the person already reading
    // the output is told what to look for, rather than left to notice drift.
    if (testCase.review !== undefined)
      console.log(`        ${YELLOW}review: ${testCase.review}${RESET}`);
    // Replies are printed so a human reads them; a green suite whose tone has
    // drifted is still a failure, and only a person can see that.
    for (const text of result.reply.messages) console.log(`        ${DIM}${text}${RESET}`);
  }

  const count = (status: Status) => outcomes.filter(outcome => outcome.status === status).length;
  const failed = count('failed');
  const reviewed = count('reviewed');

  const latencies = outcomes
    .map(outcome => outcome.latencyMs)
    .sort((first, second) => first - second);
  const p95 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] ?? 0;
  const cost = outcomes.reduce((total, outcome) => total + outcome.costUsd, 0);

  // Three counts, not two: a suite of nothing but `review` cases must not be
  // able to report itself green (specs/009 § Verification).
  const summary = `${count('passed')} passed   ${failed} failed   ${reviewed} to review`;
  console.log(`\n  ${summary}   p95 ${p95}ms   cost $${cost.toFixed(4)}\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
