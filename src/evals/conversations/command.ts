import { loadEnv, loadTenantConfig } from '../../config/loader.ts';
import { createRunner } from '../../agent/select-runner.ts';
import { loadPlugins } from '../../plugins/loader.ts';
import { evalDir } from '../cases.ts';
import { playbookFor } from '../runner.ts';
import {
  configHash,
  exitCode,
  frameworkVersion,
  runSuite,
  REPETITIONS,
  writeReport,
} from './run.ts';
import { loadSuite, validateSuite } from './suite.ts';

/** Where reports go unless `EVAL_ARTIFACTS_DIR` says otherwise. Gitignored. */
export const DEFAULT_ARTIFACTS_DIR = '.eval-artifacts';

/**
 * `agent eval conversations [--validate]`: checks the suite at `EVAL_DIR`
 * against the tenant at `CONFIG_DIR` without a provider call, and without
 * `--validate` runs every scenario twice (specs/043 § Offline validation and
 * paid conversation runs are separate commands). Resolves to the exit code.
 */
export async function runConversations(args: string[]): Promise<number> {
  const validateOnly = args.includes('--validate');
  const env = loadEnv();
  const configDir = process.env.CONFIG_DIR ?? 'config';
  const suiteDir = evalDir();
  const tenant = loadTenantConfig(configDir);
  const plugins = await loadPlugins(configDir);

  const { suite, errors } = loadSuite(suiteDir);
  const problems = suite
    ? validateSuite(suite, tenant, { plugins: plugins.summary().map(entry => entry.plugin) })
    : errors;
  if (!suite || problems.length > 0) {
    console.error(`conversation suite ${suiteDir} is invalid:`);
    for (const problem of problems) console.error(`  ${problem}`);
    return 1;
  }
  const steps = suite.scenarios.reduce((sum, scenario) => sum + scenario.steps.length, 0);
  if (validateOnly) {
    console.log(
      `conversation suite ${suiteDir} is valid: ${suite.scenarios.length} scenarios, ${steps} steps`,
    );
    return 0;
  }

  const playbook = await playbookFor(env, tenant.rules.learning !== undefined);
  // Each step is one agent turn; the estimate says how many before any is paid for.
  console.log(
    `\n  model: ${env.AGENT_MODEL}   suite: ${suiteDir}   scenarios: ${suite.scenarios.length}   agent turns: up to ${steps * REPETITIONS} (${REPETITIONS} repetitions)\n`,
  );

  const report = await runSuite(
    suite,
    {
      suite: suiteDir,
      startedAt: new Date().toISOString(),
      frameworkVersion: frameworkVersion(),
      hashes: { config: configHash(configDir), ...suite.hashes },
      agent: {
        model: env.AGENT_MODEL,
        // The only runner since specs/050 § The AI SDK runner is removed.
        runner: 'langchain',
        temperature: env.AGENT_TEMPERATURE,
      },
      judge: null,
      playbook: playbook?.id ?? null,
    },
    {
      runner: () =>
        createRunner({
          modelSpec: env.AGENT_MODEL,
          config: () => tenant,
          maxOutputTokens: env.AGENT_MAX_OUTPUT_TOKENS,
          temperature: env.AGENT_TEMPERATURE,
          reasoningEffort: env.AGENT_REASONING_EFFORT,
          plugins,
          playbook: { current: () => playbook },
          defaultChannel: env.CHANNEL,
        }),
      rules: tenant.rules,
      tools: tenant.tools,
      catalog: tenant.catalog,
      raceDeadlineMs: env.RACE_DEADLINE_MS,
      modelAbortMs: env.MODEL_ABORT_MS,
      tokensEnforced: env.CONTACT_TOKENS_ENFORCED,
      defaultChannel: env.CHANNEL,
      latencyBudgetMs: Number(process.env.EVAL_MAX_LATENCY_MS ?? env.RACE_DEADLINE_MS),
    },
    result => {
      const flags = [result.unstable ? 'unstable' : '', result.executionError ? 'error' : '']
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
    },
  );

  const { totals } = report;
  const paths = writeReport(report, process.env.EVAL_ARTIFACTS_DIR ?? DEFAULT_ARTIFACTS_DIR);
  console.log(
    `\n  ${totals.passed} passed   ${totals.failed} failed   ${totals.pendingReview} pending review   ${totals.unstable} unstable   ${totals.executionErrors} execution errors   cost $${totals.agentCostUsd.toFixed(4)}`,
  );
  console.log(`  report: ${paths.markdown}\n`);
  return exitCode(report);
}
