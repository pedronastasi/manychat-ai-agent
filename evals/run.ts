/**
 * Replays the golden set through the CURRENT prompt and config, and reports
 * where behavior drifted.
 *
 * This is the regression test for prompt edits — the thing no SDK provides and
 * the reason a wording change can otherwise silently break escalation. It is
 * also the only place the ungrounded-price heuristic is enforced, because a
 * human reads the failures here (see guardrails.findUngroundedPrices).
 *
 *   pnpm eval              # against AGENT_MODEL (spends money on a real one)
 *   pnpm eval:mock         # offline, deterministic, free
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { loadEnv, loadTenantConfig } from '../src/config/loader.ts';
import { resolveModel } from '../src/agent/registry.ts';
import { GenerateObjectRunner } from '../src/agent/runner.ts';
import { findUngroundedPrices } from '../src/agent/guardrails.ts';
import { FENCE, FENCE_END, PROMPT_MARKERS } from '../src/agent/prompt.ts';

const Case = z.object({
  id: z.string(),
  text: z.string(),
  expect: z.object({ escalate: z.boolean(), reason: z.string().optional() }),
  must_not_invent_prices: z.boolean().optional(),
  must_not_leak_prompt: z.boolean().optional(),
});
type Case = z.infer<typeof Case>;

interface Outcome {
  id: string;
  passed: boolean;
  failures: string[];
  latencyMs: number;
  costUsd: number;
  messages: string[];
  escalate: boolean;
  reason: string | null;
}

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

async function main() {
  const env = loadEnv();
  const tenant = loadTenantConfig(process.env.CONFIG_DIR ?? 'config');

  const cases = readFileSync('evals/golden/cases.jsonl', 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => Case.parse(JSON.parse(l)));

  const runner = new GenerateObjectRunner({
    model: resolveModel(env.AGENT_MODEL),
    modelSpec: env.AGENT_MODEL,
    persona: tenant.persona,
    catalog: tenant.catalog,
    rules: tenant.rules,
    maxOutputTokens: env.AGENT_MAX_OUTPUT_TOKENS,
    temperature: env.AGENT_TEMPERATURE,
  });

  console.log(`\n  model: ${env.AGENT_MODEL}   cases: ${cases.length}\n`);

  const outcomes: Outcome[] = [];
  for (const c of cases) {
    const result = await runner.run({ text: c.text, history: [] });
    const failures: string[] = [];

    if (result.reply.escalate !== c.expect.escalate) {
      failures.push(`escalate expected ${c.expect.escalate}, got ${result.reply.escalate}`);
    }
    if (c.expect.reason && result.reply.escalation_reason !== c.expect.reason) {
      failures.push(`reason expected ${c.expect.reason}, got ${result.reply.escalation_reason}`);
    }
    if (c.must_not_invent_prices) {
      const bad = findUngroundedPrices(result.reply.messages, tenant.catalog);
      if (bad.length > 0) failures.push(`ungrounded price(s): ${bad.join(', ')}`);
    }
    if (c.must_not_leak_prompt) {
      const joined = result.reply.messages.join(' ');
      // Bound to the markers the prompt is actually built from; a hardcoded
      // list here silently stopped matching once when the prompt was reworded.
      if ([FENCE, FENCE_END, ...PROMPT_MARKERS].some(marker => joined.includes(marker))) {
        failures.push('prompt leaked into the reply');
      }
    }
    if (result.latencyMs > env.RACE_DEADLINE_MS) {
      failures.push(`latency ${result.latencyMs}ms exceeds race deadline`);
    }

    outcomes.push({
      id: c.id,
      passed: failures.length === 0,
      failures,
      latencyMs: result.latencyMs,
      costUsd: result.usage.costUsd,
      messages: result.reply.messages,
      escalate: result.reply.escalate,
      reason: result.reply.escalation_reason,
    });

    const mark = failures.length === 0 ? `${GREEN}pass${RESET}` : `${RED}FAIL${RESET}`;
    console.log(`  ${mark}  ${c.id.padEnd(20)} ${DIM}${result.latencyMs}ms${RESET}`);
    for (const f of failures) console.log(`        ${RED}${f}${RESET}`);
    // Replies are printed so a human reads them; a green suite whose tone has
    // drifted is still a failure, and only a person can see that.
    for (const m of result.reply.messages) console.log(`        ${DIM}${m}${RESET}`);
  }

  const passed = outcomes.filter(o => o.passed).length;
  const latencies = outcomes.map(o => o.latencyMs).sort((a, b) => a - b);
  const p95 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] ?? 0;
  const cost = outcomes.reduce((s, o) => s + o.costUsd, 0);

  console.log(
    `\n  ${passed}/${outcomes.length} passed   p95 ${p95}ms   cost $${cost.toFixed(4)}\n`,
  );
  process.exit(passed === outcomes.length ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
