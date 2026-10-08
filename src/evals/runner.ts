import { loadEnv, loadTenantConfig } from '../config/loader.ts';
import type { Env } from '../contracts/config.ts';
import { resolveModel } from '../agent/registry.ts';
import { GenerateTextRunner } from '../agent/runner.ts';
import { loadPlugins } from '../plugins/loader.ts';
import { PluginReads } from '../plugins/reads.ts';
import type { HostLogger } from '../plugins/plugins.ts';
import { ActionStage, describeAction } from '../agent/tools.ts';
import { checkCase, classify, evalDir, loadCases, suiteHash } from './cases.ts';
import { isRealModel, NO_PLAYBOOK } from '../learning/gate.ts';
import type { ActivePlaybook } from '../learning/playbook.ts';
import type { Status } from './cases.ts';

interface Outcome {
  id: string;
  status: Status;
  failures: string[];
  latencyMs: number;
  costUsd: number;
}

/** When a nudge case's contact went quiet (specs/025). Invented, and fixed. */
const NUDGE_SINCE = new Date('2026-01-15T10:00:00Z');

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

/** The subscriber a plugin read is given in a suite: no contact's. */
const EVAL_SUBSCRIBER = 'eval';

/** A plugin read's failure is the case's to show, not a log line's. */
const SILENT: HostLogger = { info: () => {}, warn: () => {}, error: () => {} };

export async function runEval(): Promise<void> {
  const env = loadEnv();
  const configDir = process.env.CONFIG_DIR ?? 'config';
  const suiteDir = evalDir();

  const tenant = loadTenantConfig(configDir);
  // Offered as in production, so a suite can assert a plugin tool is chosen.
  // Nothing staged here is performed (specs/036).
  const plugins = await loadPlugins(configDir);
  const cases = loadCases(suiteDir);

  // A playbook version rendered into the prompt, to be evaluated before it
  // goes live (specs/031 § A version goes live only after a real-model eval).
  const playbook = await playbookFor(env, tenant.rules.learning !== undefined);

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
    plugins,
    playbook: { current: () => playbook },
  });

  const playbookLabel = playbook ? `   playbook: ${playbook.id}` : '';
  console.log(
    `\n  model: ${env.AGENT_MODEL}   suite: ${suiteDir}   cases: ${cases.length}${playbookLabel}\n`,
  );

  const outcomes: Outcome[] = [];
  for (const testCase of cases) {
    // Nothing staged here is performed: the suite reads the choice, and no
    // ManyChat account is involved (specs/012).
    const stage = new ActionStage();
    const result = await runner.run({
      text: testCase.text,
      history: testCase.history,
      stage,
      contact: testCase.contact
        ? {
            sentFlows: new Set(),
            funnelStage: testCase.contact.funnel_stage,
            offering: testCase.contact.offering,
            intent: testCase.contact.intent,
            openingDue: testCase.contact.opening_due,
            advertOffering: testCase.contact.advert_offering,
          }
        : undefined,
      // A fixed time, so the trigger note is the same on every run.
      nudge: testCase.nudge ? { since: NUDGE_SINCE } : undefined,
      // Read as in production, so a suite can assert an answer grounded in
      // a plugin read, or one given without it (specs/039).
      pluginReads: plugins.hasReadTools
        ? new PluginReads({ subscriberId: EVAL_SUBSCRIBER, logger: SILENT })
        : undefined,
    });
    const actions = result.toolsOffered ? stage.staged.map(describeAction) : null;
    const failures = checkCase({
      testCase,
      reply: result.reply,
      catalog: tenant.catalog,
      latencyMs: result.latencyMs,
      latencyBudgetMs,
      actions,
      interventions: result.interventions,
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
    if (actions !== null && actions.length > 0)
      console.log(`        ${DIM}actions: ${actions.join(', ')}${RESET}`);
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
  await recordEval(env, {
    playbookHash: playbook?.contentHash ?? NO_PLAYBOOK,
    suiteHash: suiteHash(suiteDir),
    model: env.AGENT_MODEL,
    outcomes: Object.fromEntries(outcomes.map(outcome => [outcome.id, outcome.status])),
  });
  process.exit(failed === 0 ? 0 : 1);
}

/** The version `PLAYBOOK_VERSION` names, read from the database; none when it is unset. */
async function playbookFor(env: Env, learning: boolean): Promise<ActivePlaybook | undefined> {
  const ref = process.env.PLAYBOOK_VERSION;
  if (!ref) return undefined;
  if (!learning) throw new Error('PLAYBOOK_VERSION needs a "learning" block in rules.json');
  const { openDatabase } = await import('../learning/database.ts');
  const { LearningStore } = await import('../learning/store.ts');
  const version = await new LearningStore(await openDatabase(env)).findVersion(env.TENANT_ID, ref);
  if (!version) throw new Error(`PLAYBOOK_VERSION ${ref} names no playbook version`);
  return version;
}

/**
 * Writes the run's eval record, which `insights:activate` reads. Skipped for
 * the mock model, whose pass says nothing about a prompt; a record that cannot
 * be written is reported and changes no exit code.
 */
async function recordEval(
  env: Env,
  record: {
    playbookHash: string;
    suiteHash: string;
    model: string;
    outcomes: Record<string, Status>;
  },
): Promise<void> {
  if (!isRealModel(record.model)) return;
  try {
    const { openDatabase } = await import('../learning/database.ts');
    const { LearningStore } = await import('../learning/store.ts');
    await new LearningStore(await openDatabase(env)).recordEval(env.TENANT_ID, record);
    console.log(`  ${DIM}eval record written for the suite and playbook above${RESET}\n`);
  } catch (error) {
    console.log(
      `  ${YELLOW}no eval record written: ${error instanceof Error ? error.message : String(error)}${RESET}\n`,
    );
  }
}
