import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Catalog, Tools } from '../../contracts/config.ts';
import type { Scenario } from '../../contracts/conversations.ts';
import type { AgentRunner } from '../../agent/runner.ts';
import { failuresOf } from './assert.ts';
import type { Failure } from './assert.ts';
import { inputText, runRepetition } from './harness.ts';
import type { HarnessOptions, RepetitionRun } from './harness.ts';
import type { Suite } from './suite.ts';
import { coverageOf, TENANT_SOURCES } from './coverage.ts';
import type { Coverage, StaleSource } from './coverage.ts';

/**
 * Runs a validated suite: every scenario twice, from independent state, and
 * the record of what happened (specs/043 § Each scenario runs twice from
 * independent state, § Reports identify the evaluated version and the first
 * deviation).
 */

/** A user-selected reproducibility check, not a measured reliability threshold. */
export const REPETITIONS = 2;

export type ScenarioStatus = 'passed' | 'failed' | 'pending_review';

export interface RepetitionResult {
  run: RepetitionRun;
  failures: Failure[];
}

export interface ScenarioResult {
  id: string;
  /**
   * A complete conversation from a new contact, or a returning contact's,
   * seeded: seeded state never earns coverage (specs/043).
   */
  start: 'fresh' | 'seeded';
  status: ScenarioStatus;
  /** One repetition passed and the other failed. Never averaged into a pass. */
  unstable: boolean;
  /** Either repetition ended on an execution error. */
  executionError: boolean;
  /** Whole-conversation and step criteria with no verdict yet: no judge grades them. */
  pendingCriteria: number;
  repetitions: RepetitionResult[];
}

export interface RunIdentity {
  suite: string;
  startedAt: string;
  frameworkVersion: string;
  hashes: { config: string; scenarios: string; fixtures: string | null; branches: string | null };
  agent: { model: string; runner: string; temperature: number | null };
  judge: null;
  playbook: string | null;
}

export interface RunReport extends RunIdentity {
  scenarios: ScenarioResult[];
  coverage: Coverage;
  totals: {
    passed: number;
    failed: number;
    pendingReview: number;
    unstable: number;
    executionErrors: number;
    agentCostUsd: number;
    /** No judge grades conversations yet; unknown is not zero. */
    judgeCostUsd: null;
  };
}

export interface RunOptions extends Omit<HarnessOptions, 'runner'> {
  /** A runner for each repetition, so no response is cached across them. */
  runner: () => AgentRunner;
  catalog: Catalog;
  tools?: Tools | undefined;
  latencyBudgetMs: number;
  /** Sources changed since the inventory was reconciled, found before the run. */
  stale?: StaleSource[] | undefined;
}

function criteriaOf(scenario: Scenario): number {
  return (
    (scenario.review?.length ?? 0) +
    scenario.steps.reduce((sum, step) => sum + (step.review?.length ?? 0), 0)
  );
}

/** Two repetitions of a scenario, and its status from both. */
export async function runScenario(scenario: Scenario, opts: RunOptions): Promise<ScenarioResult> {
  const repetitions: RepetitionResult[] = [];
  for (let repetition = 1; repetition <= REPETITIONS; repetition++) {
    const run = await runRepetition(scenario, repetition, { ...opts, runner: opts.runner() });
    const failures = failuresOf(scenario, run, {
      catalog: opts.catalog,
      tools: opts.tools,
      latencyBudgetMs: opts.latencyBudgetMs,
    });
    repetitions.push({ run, failures });
  }
  const failed = repetitions.filter(entry => entry.failures.length > 0).length;
  const pendingCriteria = criteriaOf(scenario);
  // A known failure decides the result; otherwise an unresolved criterion
  // leaves the scenario pending review (specs/043).
  const status: ScenarioStatus =
    failed > 0 ? 'failed' : pendingCriteria > 0 ? 'pending_review' : 'passed';
  return {
    id: scenario.id,
    start: scenario.initial ? 'seeded' : 'fresh',
    status,
    unstable: failed > 0 && failed < REPETITIONS,
    executionError: repetitions.some(entry => entry.run.executionError !== undefined),
    pendingCriteria,
    repetitions,
  };
}

/** The installed framework's version, from its own package.json. */
export function frameworkVersion(): string {
  const file = fileURLToPath(new URL('../../../package.json', import.meta.url));
  try {
    return (JSON.parse(readFileSync(file, 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Identifies the tenant config a run was made against, file by file. */
export function configHash(configDir: string): string {
  const hash = createHash('sha256');
  for (const name of TENANT_SOURCES) {
    const file = join(configDir, name);
    hash.update(`${name}\0`);
    hash.update(existsSync(file) ? readFileSync(file) : '(absent)');
  }
  return hash.digest('hex');
}

export async function runSuite(
  suite: Suite,
  identity: RunIdentity,
  opts: RunOptions,
  onScenario?: (result: ScenarioResult) => void,
): Promise<RunReport> {
  const scenarios: ScenarioResult[] = [];
  for (const scenario of suite.scenarios) {
    const result = await runScenario(scenario, opts);
    scenarios.push(result);
    onScenario?.(result);
  }
  const agentCostUsd = scenarios
    .flatMap(result => result.repetitions)
    .flatMap(entry => entry.run.steps)
    .reduce((sum, step) => sum + step.costUsd, 0);
  const ctx = { catalog: opts.catalog, tools: opts.tools, latencyBudgetMs: opts.latencyBudgetMs };
  const coverage = coverageOf(
    suite.inventory,
    suite.scenarios,
    new Map(scenarios.map(result => [result.id, result.repetitions.map(entry => entry.run)])),
    opts.stale ?? [],
    ctx,
  );
  return {
    ...identity,
    scenarios,
    coverage,
    totals: {
      passed: scenarios.filter(result => result.status === 'passed').length,
      failed: scenarios.filter(result => result.status === 'failed').length,
      pendingReview: scenarios.filter(result => result.status === 'pending_review').length,
      unstable: scenarios.filter(result => result.unstable).length,
      executionErrors: scenarios.filter(result => result.executionError).length,
      agentCostUsd,
      judgeCostUsd: null,
    },
  };
}

/**
 * A run is gate evidence only when every scenario passed and the inventory is
 * current and fully verified: a failure, an execution error, a pending review,
 * a stale source, a conflict or a branch short of verified all exit nonzero
 * (specs/043 § Offline validation and paid conversation runs are separate
 * commands).
 */
export function exitCode(report: RunReport): number {
  const { totals, coverage } = report;
  return totals.failed + totals.pendingReview + totals.executionErrors > 0 || !coverage.complete
    ? 1
    : 0;
}

/** The coverage section of the transcript; each figure names its denominator. */
export function coverageLines(coverage: Coverage): string[] {
  if (!coverage.inventory) {
    return ['## Branch coverage', '', 'No branches.json: coverage cannot be complete.', ''];
  }
  const { counts } = coverage;
  const of = (count: number) => `${count} of ${counts.declared} declared`;
  const lines = [
    '## Branch coverage',
    '',
    `${coverage.complete ? 'Complete' : 'Incomplete'}: ${of(counts.verified)} verified; ${of(counts.attempted)} attempted; ${counts.failed} failed, ${counts.unreviewed} unreviewed, ${counts.not_reached} not reached, ${counts.stale} stale, ${counts.conflicted} conflicted.`,
    '',
  ];
  for (const stale of coverage.stale) {
    lines.push(
      `- stale source ${stale.source}: reconciled at ${stale.recorded}, now ${stale.current ?? 'missing'}`,
    );
  }
  for (const branch of coverage.branches) {
    const where = branch.witnesses
      .map(witness => `${witness.scenario}/${witness.step} [${witness.repetitions.join(', ')}]`)
      .join('; ');
    lines.push(`- ${branch.id}: ${branch.status}${where ? ` (${where})` : ''}`);
    if (branch.conflict) {
      const sources = branch.conflict.sources.map(ref => `${ref.file} ${ref.clause}`).join(', ');
      lines.push(
        `  conflict with ${sources}: ${branch.conflict.note}; affects ${branch.conflict.scenarios.join(', ')}`,
      );
    }
  }
  lines.push('');
  return lines;
}

/**
 * The report as JSON, with nothing in it a run must not carry: no contact
 * token, no note text (action records hold a note's length only), no real
 * subscriber. Contact messages are the script's own invented text (C1, C5).
 */
export function reportJson(report: RunReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** The report as a readable transcript, one section per scenario and repetition. */
export function reportMarkdown(report: RunReport): string {
  const lines: string[] = [
    `# Conversation run: ${report.suite}`,
    '',
    `- Started: ${report.startedAt}`,
    `- Framework: ${report.frameworkVersion}`,
    `- Agent: ${report.agent.model} (${report.agent.runner})`,
    `- Judge: none`,
    `- Playbook: ${report.playbook ?? 'none'}`,
    `- Config: ${report.hashes.config}`,
    `- Scenarios: ${report.hashes.scenarios}`,
    `- Fixtures: ${report.hashes.fixtures ?? 'none'}`,
    `- Branches: ${report.hashes.branches ?? 'none'}`,
    '',
    `${report.totals.passed} passed, ${report.totals.failed} failed, ${report.totals.pendingReview} pending review, ${report.totals.unstable} unstable, ${report.totals.executionErrors} with execution errors. Agent cost $${report.totals.agentCostUsd.toFixed(4)}; judge cost not applicable.`,
    '',
  ];
  lines.push(...coverageLines(report.coverage));
  for (const scenario of report.scenarios) {
    const flags = [scenario.unstable ? 'unstable' : '', scenario.executionError ? 'error' : '']
      .filter(Boolean)
      .join(', ');
    lines.push(
      `## ${scenario.id}: ${scenario.status}${flags ? ` (${flags})` : ''}, ${scenario.start}`,
      '',
    );
    if (scenario.pendingCriteria > 0) {
      lines.push(`${scenario.pendingCriteria} criteria pending review.`, '');
    }
    for (const { run, failures } of scenario.repetitions) {
      lines.push(`### Repetition ${run.repetition}: ${run.terminal}`, '');
      for (const step of run.steps) {
        const clock = step.clockMs > 0 ? `, clock +${Math.round(step.clockMs / 60_000)} min` : '';
        lines.push(`**${step.id}** (${step.outcome}${clock})`, '');
        lines.push(`> contact (${step.input.kind}): ${inputText(step.input)}`, '');
        for (const delivery of run.deliveries.filter(entry => entry.step === step.id)) {
          if (delivery.kind === 'flow') {
            lines.push(`- flow ${delivery.id}${delivery.origin ? ` (${delivery.origin})` : ''}`);
          } else {
            for (const message of delivery.messages)
              lines.push(`- agent (${delivery.via}): ${message}`);
          }
        }
        if (step.reply.closing_question)
          lines.push(`- closing question: ${step.reply.closing_question}`);
        for (const action of step.actions) {
          lines.push(
            `- action ${action.tool} ${action.id}${action.value ? `=${action.value}` : ''}: ${action.status}`,
          );
        }
        if (step.nudge) lines.push(`- nudge: ${step.nudge.outcome}`);
        if (step.state.pendingNudge) lines.push(`- pending nudge: ${step.state.pendingNudge}`);
        if (step.executionError) lines.push(`- execution error: ${step.executionError}`);
        lines.push('');
      }
      if (run.notReached.length > 0) lines.push(`Not reached: ${run.notReached.join(', ')}`, '');
      if (failures.length === 0) lines.push('No failures.', '');
      for (const failure of failures) {
        const where = failure.step ? `${failure.step}: ` : '';
        lines.push(
          `- ${failure.downstream ? '(downstream) ' : 'FIRST: '}${where}${failure.message}`,
        );
      }
      lines.push('');
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Writes both forms into the artifact directory and returns their paths. */
export function writeReport(report: RunReport, dir: string): { json: string; markdown: string } {
  mkdirSync(dir, { recursive: true });
  const stamp = report.startedAt.replace(/[:.]/g, '-');
  const json = join(dir, `conversations-${stamp}.json`);
  const markdown = join(dir, `conversations-${stamp}.md`);
  writeFileSync(json, reportJson(report));
  writeFileSync(markdown, reportMarkdown(report));
  return { json, markdown };
}
