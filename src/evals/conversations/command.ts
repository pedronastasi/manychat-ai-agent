import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadEnv, loadTenantConfig } from '../../config/loader.ts';
import type { TenantConfig } from '../../config/loader.ts';
import type { Env } from '../../contracts/config.ts';
import { createRunner } from '../../agent/select-runner.ts';
import { loadPlugins } from '../../plugins/loader.ts';
import { evalDir } from '../cases.ts';
import { playbookFor } from '../runner.ts';
import { groupOf, sameModelWarning } from '../judge.ts';
import {
  configHash,
  evaluatedOf,
  exitCode,
  frameworkVersion,
  identityOf,
  runSuite,
  REPETITIONS,
  writeReport,
} from './run.ts';
import type { Evaluated } from './run.ts';
import { loadSuite, validateSuite } from './suite.ts';
import type { Suite } from './suite.ts';
import { BRANCHES_FILE, frameworkText, staleSources } from './coverage.ts';
import {
  calibrateConversations,
  CALIBRATION_FILE,
  ConversationJudge,
  criteriaOf,
  groupsOf,
  loadConversationCalibration,
} from './judge.ts';
import { gate, GateReport, loadReviews } from './gate.ts';
import { acceptsImages, resolveModel } from '../../agent/registry.ts';
import { detectFfmpeg, FfmpegVideoSplitter } from '../../media/ffmpeg.ts';

/** Where reports go unless `EVAL_ARTIFACTS_DIR` says otherwise. Gitignored. */
export const DEFAULT_ARTIFACTS_DIR = '.eval-artifacts';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Everything a run of this suite would evaluate, as it stands now. */
function evaluatedNow(opts: {
  env: Env;
  configDir: string;
  tenant: TenantConfig;
  suite: Suite;
  calibration: string | null;
  playbook: string | null;
}): Evaluated {
  const { env, configDir, tenant, suite } = opts;
  const sourceTenant = { ...tenant, configDir };
  return {
    frameworkVersion: frameworkVersion(),
    hashes: {
      config: configHash(configDir),
      framework: sha256(
        `${frameworkText('operating-rules', sourceTenant)}\0${frameworkText('tool-descriptions', sourceTenant)}`,
      ),
      ...suite.hashes,
      calibration: opts.calibration === null ? null : sha256(opts.calibration),
    },
    agent: {
      model: env.AGENT_MODEL,
      // The only runner since specs/050 § The AI SDK runner is removed.
      runner: 'langchain',
      temperature: env.AGENT_TEMPERATURE,
    },
    judge: env.EVAL_JUDGE_MODEL ? { model: env.EVAL_JUDGE_MODEL } : null,
    playbook: opts.playbook,
  };
}

/** The value after `flag` in `args`, if any. */
const valueOf = (args: string[], flag: string) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

/**
 * `agent eval conversations [--validate | --gate <report.json>]`: checks the
 * suite at `EVAL_DIR` against the tenant at `CONFIG_DIR` without a provider
 * call; without a flag runs every scenario twice and has the judge grade its
 * criteria; with `--gate` decides whether a finished run, with the reviews
 * recorded against it, is evidence a change may be published (specs/043 §
 * Offline validation and paid conversation runs are separate commands).
 * Resolves to the exit code.
 */
export async function runConversations(args: string[]): Promise<number> {
  const validateOnly = args.includes('--validate');
  const gatePath = args.includes('--gate') ? (valueOf(args, '--gate') ?? '') : undefined;
  const env = loadEnv();
  const configDir = process.env.CONFIG_DIR ?? 'config';
  const suiteDir = evalDir();
  const tenant = loadTenantConfig(configDir);
  const plugins = await loadPlugins(configDir);

  const { suite, errors } = loadSuite(suiteDir);
  const calibration = loadConversationCalibration(suiteDir);
  const problems = suite
    ? [
        ...validateSuite(suite, tenant, {
          plugins: plugins.summary().map(entry => entry.plugin),
          configDir,
        }),
        ...calibration.errors,
      ]
    : errors;
  if (!suite || problems.length > 0) {
    console.error(`conversation suite ${suiteDir} is invalid:`);
    for (const problem of problems) console.error(`  ${problem}`);
    return 1;
  }
  const steps = suite.scenarios.reduce((sum, scenario) => sum + scenario.steps.length, 0);
  // A changed source leaves the inventory stale until a person reconciles
  // it; an old script still passing does not cover a changed prompt.
  const stale = suite.inventory ? staleSources(suite.inventory, { ...tenant, configDir }) : [];
  if (validateOnly) {
    console.log(
      `conversation suite ${suiteDir} is valid: ${suite.scenarios.length} scenarios, ${steps} steps, ${suite.inventory?.branches.length ?? 0} branches, ${calibration.items.length} calibration conversations`,
    );
    if (!suite.inventory) {
      console.error(`  no ${BRANCHES_FILE}: branch coverage cannot be complete`);
      return 1;
    }
    for (const entry of stale) {
      console.error(
        `  stale: ${entry.source} was reconciled at ${entry.recorded}; it is now ${entry.current ?? 'missing'}`,
      );
    }
    const conflicted = suite.inventory.branches.filter(branch => branch.conflict);
    for (const branch of conflicted) {
      console.error(`  conflict: branch ${branch.id}: ${branch.conflict?.note}`);
    }
    return stale.length + conflicted.length > 0 ? 1 : 0;
  }

  const playbook = await playbookFor(env, tenant.rules.learning !== undefined);
  const evaluated = evaluatedNow({
    env,
    configDir,
    tenant,
    suite,
    calibration: calibration.raw,
    playbook: playbook?.id ?? null,
  });

  if (gatePath !== undefined) return runGate(gatePath, suiteDir, evaluatedOf(evaluated), stale);

  // What a run will call, before any of it is paid for.
  const criteria = suite.scenarios.reduce((sum, scenario) => sum + criteriaOf(scenario).length, 0);
  const groups = groupsOf(suite.scenarios);
  const calibrationItems = calibration.items.filter(item =>
    groups.includes(groupOf(item.criterion)),
  ).length;
  const judgeCalls = env.EVAL_JUDGE_MODEL ? (criteria * REPETITIONS + calibrationItems) * 3 : 0;
  console.log(
    `\n  model: ${env.AGENT_MODEL}   suite: ${suiteDir}   scenarios: ${suite.scenarios.length}   agent turns: up to ${steps * REPETITIONS} (${REPETITIONS} repetitions)   judge calls: up to ${judgeCalls}\n`,
  );

  const runner = () =>
    createRunner({
      modelSpec: env.AGENT_MODEL,
      config: () => tenant,
      maxOutputTokens: env.AGENT_MAX_OUTPUT_TOKENS,
      temperature: env.AGENT_TEMPERATURE,
      reasoningEffort: env.AGENT_REASONING_EFFORT,
      plugins,
      playbook: { current: () => playbook },
      defaultChannel: env.CHANNEL,
    });

  // The judge, when one is named: calibrated on conversations first, on every
  // run, and only the groups that pass grade anything (specs/016, 043).
  let judge;
  if (env.EVAL_JUDGE_MODEL) {
    const conversationJudge = new ConversationJudge({
      model: resolveModel(env.EVAL_JUDGE_MODEL, 'EVAL_JUDGE_MODEL'),
      modelSpec: env.EVAL_JUDGE_MODEL,
    });
    const warning = sameModelWarning(conversationJudge.modelSpec, env.AGENT_MODEL);
    if (warning) console.log(`  warning: ${warning}`);
    const agentPrompt = runner().systemPrompt();
    const calibrated = await calibrateConversations(
      conversationJudge,
      calibration.items,
      groups,
      agentPrompt,
    );
    console.log(`  judge: ${conversationJudge.modelSpec}   calibration (${CALIBRATION_FILE}):`);
    for (const group of calibrated.values()) {
      console.log(
        `    ${group.group.padEnd(22)} ${group.calibrated ? 'calibrated' : `uncalibrated (${group.refused ?? ''})`}   ${group.items} items`,
      );
    }
    judge = { judge: conversationJudge, groups: calibrated, agentPrompt };
  }

  const report = await runSuite(
    suite,
    identityOf(evaluated, suiteDir, new Date().toISOString()),
    {
      runner,
      rules: tenant.rules,
      tools: tenant.tools,
      catalog: tenant.catalog,
      raceDeadlineMs: env.RACE_DEADLINE_MS,
      modelAbortMs: env.MODEL_ABORT_MS,
      tokensEnforced: env.CONTACT_TOKENS_ENFORCED,
      defaultChannel: env.CHANNEL,
      suiteDir,
      // What this deployment could read; transcription answers from fixtures.
      media: {
        acceptsImages: acceptsImages(env.AGENT_MODEL),
        transcription: env.TRANSCRIPTION_MODEL !== undefined,
        splitter: (await detectFfmpeg()) ? new FfmpegVideoSplitter() : null,
      },
      stale,
      judge,
      latencyBudgetMs: Number(process.env.EVAL_MAX_LATENCY_MS ?? env.RACE_DEADLINE_MS),
    },
    result => {
      const flags = [
        result.unstable ? 'unstable' : '',
        result.executionError ? 'error' : '',
        result.judgedFail ? 'judged' : '',
      ]
        .filter(Boolean)
        .join(', ');
      console.log(`  ${result.status.padEnd(14)} ${result.id}${flags ? ` (${flags})` : ''}`);
      for (const { run, failures } of result.repetitions) {
        const first = failures[0];
        if (first) {
          const where = first.step ? `${first.step}: ` : '';
          console.log(`        repetition ${run.repetition}: ${where}${first.message}`);
        }
      }
      for (const criterion of result.criteria.filter(entry => entry.outcome === 'fail')) {
        console.log(
          `        repetition ${criterion.repetition}: ${criterion.key} judged fail${criterion.evidence ? ` at ${criterion.evidence.step}` : ''}`,
        );
      }
    },
  );

  const { totals, coverage } = report;
  const paths = writeReport(report, process.env.EVAL_ARTIFACTS_DIR ?? DEFAULT_ARTIFACTS_DIR);
  const judgeCost =
    totals.judgeCostUsd === null ? 'judge not run' : `judge $${totals.judgeCostUsd.toFixed(4)}`;
  console.log(
    `\n  ${totals.passed} passed   ${totals.failed} failed   ${totals.judgedFail} judged-fail   ${totals.pendingReview} pending review   ${totals.unstable} unstable   ${totals.executionErrors} execution errors   cost $${totals.agentCostUsd.toFixed(4)}   ${judgeCost}`,
  );
  console.log(
    coverage.inventory
      ? `  coverage: ${coverage.counts.verified} of ${coverage.counts.declared} branches verified, ${coverage.stale.length} stale sources, ${coverage.counts.conflicted} conflicted${coverage.complete ? '' : ' (incomplete)'}`
      : `  coverage: no ${BRANCHES_FILE} (incomplete)`,
  );
  console.log(`  run: ${report.runId}`);
  console.log(`  report: ${paths.markdown}\n`);
  return exitCode(report);
}

/**
 * Decides on a finished run with the reviews recorded against it, and writes
 * the decision beside the report without touching the report itself.
 */
function runGate(
  path: string,
  suiteDir: string,
  evaluated: string,
  stale: ReturnType<typeof staleSources>,
): number {
  if (!path || !existsSync(path)) {
    console.error(`--gate needs a report written by a conversation run; ${path || 'none'} given`);
    return 1;
  }
  let report;
  try {
    report = GateReport.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    console.error(`${path} is not a conversation run report`);
    return 1;
  }
  const { reviews, errors } = loadReviews(suiteDir);
  // A line that does not parse is in the decision, not only on stderr.
  const result = gate(report, reviews, { evaluated, stale }, errors);
  const out = path.replace(/\.json$/, '') + '.gate.json';
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    `\n  run ${result.run}: ${result.passed ? 'passes the gate' : 'does not pass the gate'}`,
  );
  console.log(
    `  reviews: ${result.reviews.applied} applied, ${result.reviews.otherRuns} for other runs, ${result.reviews.invalid.length} invalid; ${result.disagreements.length} disagreements with the judge`,
  );
  for (const reason of result.reasons) console.log(`  - ${reason}`);
  for (const problem of result.reviews.invalid) console.log(`  - invalid review: ${problem}`);
  console.log(`  decision: ${out}\n`);
  return result.passed ? 0 : 1;
}
