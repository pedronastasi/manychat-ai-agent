import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Catalog, Tools } from '../../contracts/config.ts';
import type { ChannelFixtures, Scenario, TranscriptStep } from '../../contracts/conversations.ts';
import type { AgentRunner } from '../../agent/runner.ts';
import { groupOf } from '../judge.ts';
import type { GroupCalibration } from '../judge.ts';
import { failuresOf } from './assert.ts';
import type { Failure } from './assert.ts';
import { inputText, runRepetition } from './harness.ts';
import type { HarnessOptions, RepetitionRun } from './harness.ts';
import type { Suite } from './suite.ts';
import { coverageOf, TENANT_SOURCES } from './coverage.ts';
import type { Coverage, CriterionOutcome, OutcomeOf, StaleSource } from './coverage.ts';
import { criteriaOf, transcriptOf } from './judge.ts';
import type { ConversationJudge } from './judge.ts';

/**
 * Runs a validated suite: every scenario twice, from independent state, the
 * judge's verdicts on its criteria, and the record of what happened (specs/043
 * § Each scenario runs twice from independent state, § The judge sees the
 * conversation and quotes its evidence, § Reports identify the evaluated
 * version and the first deviation).
 */

/** A user-selected reproducibility check, not a measured reliability threshold. */
export const REPETITIONS = 2;

export type ScenarioStatus = 'passed' | 'failed' | 'pending_review';

export interface RepetitionResult {
  run: RepetitionRun;
  failures: Failure[];
}

/** One criterion in one repetition, and who decided it. */
export interface CriterionResult {
  /** `review[0]`, or `<step>.review[0]`. */
  key: string;
  text: string;
  step?: string | undefined;
  repetition: number;
  outcome: CriterionOutcome;
  /** The judge, a person at the gate, or nobody yet. */
  by: 'judge' | 'review' | 'none';
  /** A 2–1 judge vote: a person should look at it. */
  split?: boolean | undefined;
  evidence?: { step: string; quote: string; absent?: string | undefined } | undefined;
  reason?: string | undefined;
}

export interface ScenarioResult {
  id: string;
  /**
   * A complete conversation from a new contact, or a returning contact's,
   * seeded: seeded state never earns coverage (specs/043).
   */
  start: 'fresh' | 'seeded';
  status: ScenarioStatus;
  /** Failed by its criteria alone: every deterministic assertion held. */
  judgedFail: boolean;
  /** One repetition passed and the other failed. Never averaged into a pass. */
  unstable: boolean;
  /** Either repetition ended on an execution error. */
  executionError: boolean;
  /** Deterministic failures in both repetitions. No verdict overrides them. */
  failures: number;
  criteria: CriterionResult[];
  /** What the judge read, per repetition: what a review quotes from. */
  transcripts: TranscriptStep[][];
  repetitions: RepetitionResult[];
}

/** Everything a run evaluated, by hash: the identity a review binds to. */
export interface Evaluated {
  frameworkVersion: string;
  hashes: {
    config: string;
    /** The framework's rules and tool descriptions as this tenant renders them. */
    framework: string;
    scenarios: string;
    fixtures: string | null;
    branches: string | null;
    calibration: string | null;
  };
  agent: { model: string; runner: string; temperature: number | null };
  judge: { model: string } | null;
  playbook: string | null;
}

export interface RunIdentity extends Evaluated {
  suite: string;
  startedAt: string;
  /** This run, and only it: what a review record names. */
  runId: string;
  /** The hash of everything evaluated. A later run of an edited suite differs. */
  evaluated: string;
}

export interface RunReport extends RunIdentity {
  /** The judge's calibration on this run, per group the suite uses; null with no judge. */
  calibration: GroupCalibration[] | null;
  scenarios: ScenarioResult[];
  coverage: Coverage;
  totals: {
    passed: number;
    /** Failed on a deterministic assertion or an execution error. */
    failed: number;
    /** Failed only on a judged criterion. */
    judgedFail: number;
    pendingReview: number;
    unstable: number;
    executionErrors: number;
    criteria: { judgedPass: number; judgedFail: number; ungraded: number };
    agentCostUsd: number;
    /** Null with no judge: not run, which is not the same as free. */
    judgeCostUsd: number | null;
    totalCostUsd: number;
    judgeLatencyMs: number | null;
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
  /** What each customer-visible flow shows, for the transcript. */
  fixtures?: ChannelFixtures | undefined;
  /** The calibrated judge, when one is named. Absent, every criterion waits for a person. */
  judge?:
    | { judge: ConversationJudge; groups: Map<string, GroupCalibration>; agentPrompt: string }
    | undefined;
}

/** The hash a run's evaluated inputs come to; the gate recomputes it to find a stale run. */
export function evaluatedOf(evaluated: Evaluated): string {
  const { frameworkVersion, hashes, agent, judge, playbook } = evaluated;
  return createHash('sha256')
    .update(JSON.stringify({ frameworkVersion, hashes, agent, judge, playbook }))
    .digest('hex');
}

/** A run's identity: its evaluated hash, and an id no other run shares. */
export function identityOf(evaluated: Evaluated, suite: string, startedAt: string): RunIdentity {
  const hash = evaluatedOf(evaluated);
  return {
    suite,
    startedAt,
    runId: `${hash.slice(0, 12)}-${startedAt.replace(/[^0-9]/g, '')}`,
    evaluated: hash,
    ...evaluated,
  };
}

/**
 * A scenario's status from its parts. A deterministic failure or an
 * execution error decides it whatever the criteria say; then a failed
 * criterion; then any criterion still ungraded leaves it pending review.
 */
export function statusOf(
  result: Pick<ScenarioResult, 'failures' | 'executionError' | 'criteria'>,
): {
  status: ScenarioStatus;
  judgedFail: boolean;
} {
  if (result.failures > 0 || result.executionError) return { status: 'failed', judgedFail: false };
  if (result.criteria.some(criterion => criterion.outcome === 'fail')) {
    return { status: 'failed', judgedFail: true };
  }
  if (result.criteria.some(criterion => criterion.outcome === 'ungraded')) {
    return { status: 'pending_review', judgedFail: false };
  }
  return { status: 'passed', judgedFail: false };
}

/**
 * Every criterion of a scenario in each repetition. The judge is consulted
 * only when no deterministic assertion failed, as for a case (specs/016),
 * and only for a group that passed calibration; anything else waits for a
 * person. A step the script never reached has nothing to grade.
 */
async function gradeCriteria(
  scenario: Scenario,
  repetitions: readonly RepetitionResult[],
  transcripts: readonly TranscriptStep[][],
  judge: RunOptions['judge'],
): Promise<CriterionResult[]> {
  const failed = repetitions.some(entry => entry.failures.length > 0);
  const results: CriterionResult[] = [];
  for (const [index, { run }] of repetitions.entries()) {
    const transcript = transcripts[index] ?? [];
    for (const criterion of criteriaOf(scenario)) {
      const base = {
        key: criterion.key,
        text: criterion.text,
        step: criterion.step,
        repetition: run.repetition,
      };
      if (criterion.step && !run.steps.some(step => step.id === criterion.step)) {
        results.push({ ...base, outcome: 'not_reached', by: 'none' });
        continue;
      }
      if (failed || !judge?.groups.get(groupOf(criterion.text))?.calibrated) {
        results.push({ ...base, outcome: 'ungraded', by: 'none' });
        continue;
      }
      const grade = await judge.judge.grade({
        criterion: criterion.text,
        transcript,
        step: criterion.step,
        agentPrompt: judge.agentPrompt,
      });
      results.push({
        ...base,
        outcome: grade.outcome,
        by: grade.outcome === 'ungraded' ? 'none' : 'judge',
        split: grade.split || undefined,
        evidence: grade.step
          ? { step: grade.step, quote: grade.evidence ?? '', absent: grade.absent }
          : undefined,
        reason: grade.reason,
      });
    }
  }
  return results;
}

/** Two repetitions of a scenario, its criteria, and its status from all of them. */
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
  const failedRepetitions = repetitions.filter(entry => entry.failures.length > 0).length;
  const transcripts = repetitions.map(entry =>
    transcriptOf(entry.run, opts.fixtures ?? { flows: {} }),
  );
  const criteria = await gradeCriteria(scenario, repetitions, transcripts, opts.judge);
  const parts = {
    failures: repetitions.reduce((sum, entry) => sum + entry.failures.length, 0),
    executionError: repetitions.some(entry => entry.run.executionError !== undefined),
    criteria,
  };
  return {
    id: scenario.id,
    start: scenario.initial ? 'seeded' : 'fresh',
    ...statusOf(parts),
    unstable: failedRepetitions > 0 && failedRepetitions < REPETITIONS,
    ...parts,
    transcripts,
    repetitions,
  };
}

/** Looks a criterion's outcome up in a run's results. */
export function outcomesOf(scenarios: readonly ScenarioResult[]): OutcomeOf {
  const outcomes = new Map<string, CriterionOutcome>();
  for (const scenario of scenarios) {
    for (const criterion of scenario.criteria) {
      outcomes.set(`${scenario.id}\0${criterion.repetition}\0${criterion.key}`, criterion.outcome);
    }
  }
  return (scenario, repetition, key) =>
    outcomes.get(`${scenario}\0${repetition}\0${key}`) ?? 'ungraded';
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

/** The totals a report shows, from its scenarios. */
export function totalsOf(
  scenarios: readonly ScenarioResult[],
  judge: { costUsd: number; latencyMs: number } | null,
): RunReport['totals'] {
  const criteria = scenarios.flatMap(result => result.criteria);
  const agentCostUsd = scenarios
    .flatMap(result => result.repetitions)
    .flatMap(entry => entry.run.steps)
    .reduce((sum, step) => sum + step.costUsd, 0);
  return {
    passed: scenarios.filter(result => result.status === 'passed').length,
    failed: scenarios.filter(result => result.status === 'failed' && !result.judgedFail).length,
    judgedFail: scenarios.filter(result => result.judgedFail).length,
    pendingReview: scenarios.filter(result => result.status === 'pending_review').length,
    unstable: scenarios.filter(result => result.unstable).length,
    executionErrors: scenarios.filter(result => result.executionError).length,
    criteria: {
      judgedPass: criteria.filter(entry => entry.outcome === 'pass').length,
      judgedFail: criteria.filter(entry => entry.outcome === 'fail').length,
      ungraded: criteria.filter(entry => entry.outcome === 'ungraded').length,
    },
    agentCostUsd,
    judgeCostUsd: judge ? judge.costUsd : null,
    totalCostUsd: agentCostUsd + (judge?.costUsd ?? 0),
    judgeLatencyMs: judge ? judge.latencyMs : null,
  };
}

export async function runSuite(
  suite: Suite,
  identity: RunIdentity,
  opts: RunOptions,
  onScenario?: (result: ScenarioResult) => void,
): Promise<RunReport> {
  const scenarios: ScenarioResult[] = [];
  for (const scenario of suite.scenarios) {
    const result = await runScenario(scenario, {
      ...opts,
      fixtures: opts.fixtures ?? suite.fixtures,
    });
    scenarios.push(result);
    onScenario?.(result);
  }
  const ctx = { catalog: opts.catalog, tools: opts.tools, latencyBudgetMs: opts.latencyBudgetMs };
  const coverage = coverageOf(
    suite.inventory,
    suite.scenarios,
    new Map(scenarios.map(result => [result.id, result.repetitions.map(entry => entry.run)])),
    opts.stale ?? [],
    ctx,
    outcomesOf(scenarios),
  );
  const judge = opts.judge?.judge;
  return {
    ...identity,
    calibration: opts.judge ? [...opts.judge.groups.values()] : null,
    scenarios,
    coverage,
    totals: totalsOf(
      scenarios,
      judge ? { costUsd: judge.costUsd, latencyMs: judge.latencyMs } : null,
    ),
  };
}

/**
 * A run is gate evidence only when every scenario passed and the inventory is
 * current and fully verified: a failure, a judged failure, an execution
 * error, a pending review, a stale source, a conflict or a branch short of
 * verified all exit nonzero (specs/043 § Offline validation and paid
 * conversation runs are separate commands).
 */
export function exitCode(report: Pick<RunReport, 'totals' | 'coverage'>): number {
  const { totals, coverage } = report;
  return totals.failed + totals.judgedFail + totals.pendingReview + totals.executionErrors > 0 ||
    !coverage.complete
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
 * subscriber, no credential. Contact messages are the script's own invented
 * text (C1, C5).
 */
export function reportJson(report: RunReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

const money = (usd: number | null) => (usd === null ? 'not applicable' : `$${usd.toFixed(4)}`);

/** A criterion's line: its verdict, who gave it, and the quoted evidence. */
export function criterionLine(criterion: CriterionResult): string {
  const evidence = criterion.evidence
    ? ` — ${criterion.evidence.step}: "${criterion.evidence.quote}"${criterion.evidence.absent ? ` (absent: ${criterion.evidence.absent})` : ''}`
    : '';
  const split = criterion.split ? ', split vote' : '';
  const reason = criterion.reason ? ` ${criterion.reason}` : '';
  return `- ${criterion.key} (${criterion.text}): ${criterion.outcome} by ${criterion.by}${split}${evidence}${reason}`;
}

/** The report as a readable transcript, one section per scenario and repetition. */
export function reportMarkdown(report: RunReport): string {
  const { totals } = report;
  const lines: string[] = [
    `# Conversation run: ${report.suite}`,
    '',
    `- Run: ${report.runId}`,
    `- Evaluated: ${report.evaluated}`,
    `- Started: ${report.startedAt}`,
    `- Framework: ${report.frameworkVersion}`,
    `- Agent: ${report.agent.model} (${report.agent.runner}, temperature ${report.agent.temperature ?? 'default'})`,
    `- Judge: ${report.judge?.model ?? 'none'}`,
    `- Playbook: ${report.playbook ?? 'none'}`,
    `- Config: ${report.hashes.config}`,
    `- Framework sources: ${report.hashes.framework}`,
    `- Scenarios: ${report.hashes.scenarios}`,
    `- Fixtures: ${report.hashes.fixtures ?? 'none'}`,
    `- Branches: ${report.hashes.branches ?? 'none'}`,
    `- Calibration: ${report.hashes.calibration ?? 'none'}`,
    '',
    `${totals.passed} passed, ${totals.failed} failed, ${totals.judgedFail} judged failed, ${totals.pendingReview} pending review, ${totals.unstable} unstable, ${totals.executionErrors} with execution errors.`,
    `Criteria: ${totals.criteria.judgedPass} passed, ${totals.criteria.judgedFail} failed, ${totals.criteria.ungraded} pending review.`,
    `Cost: agent ${money(totals.agentCostUsd)}, judge ${money(totals.judgeCostUsd)}, total ${money(totals.totalCostUsd)}.${totals.judgeLatencyMs === null ? '' : ` Judge time ${totals.judgeLatencyMs} ms.`}`,
    '',
  ];
  if (report.calibration) {
    lines.push('## Judge calibration', '');
    if (report.calibration.length === 0) lines.push('No criteria, so no group to calibrate.');
    for (const group of report.calibration) {
      lines.push(
        `- ${group.group}: ${group.calibrated ? 'calibrated' : `uncalibrated (${group.refused ?? ''})`}, ${group.items} items, agreement ${group.agreement.toFixed(2)}`,
      );
    }
    lines.push('');
  }
  lines.push(...coverageLines(report.coverage));
  for (const scenario of report.scenarios) {
    const flags = [
      scenario.unstable ? 'unstable' : '',
      scenario.executionError ? 'error' : '',
      scenario.judgedFail ? 'judged' : '',
    ]
      .filter(Boolean)
      .join(', ');
    lines.push(
      `## ${scenario.id}: ${scenario.status}${flags ? ` (${flags})` : ''}, ${scenario.start}`,
      '',
    );
    for (const { run, failures } of scenario.repetitions) {
      lines.push(`### Repetition ${run.repetition}: ${run.terminal}`, '');
      const transcript = scenario.transcripts[run.repetition - 1] ?? [];
      for (const step of run.steps) {
        const clock = step.clockMs > 0 ? `, clock +${Math.round(step.clockMs / 60_000)} min` : '';
        const latency = step.latencyMs === undefined ? '' : `, ${step.latencyMs} ms`;
        lines.push(`**${step.id}** (${step.outcome}${clock}${latency})`, '');
        lines.push(`> contact (${step.input.kind}): ${inputText(step.input)}`, '');
        for (const delivery of run.deliveries.filter(entry => entry.step === step.id)) {
          if (delivery.kind === 'flow') {
            const shown = transcript
              .find(entry => entry.step === step.id)
              ?.flows.find(flow => flow.startsWith(`flow ${delivery.id}`));
            lines.push(
              `- ${shown ?? `flow ${delivery.id}`}${delivery.origin ? ` (${delivery.origin})` : ''}`,
            );
          } else {
            for (const message of delivery.messages)
              lines.push(`- agent (${delivery.via}): ${message}`);
          }
        }
        if (step.reply.closing_question)
          lines.push(`- closing question: ${step.reply.closing_question}`);
        for (const change of transcript.find(entry => entry.step === step.id)?.changes ?? []) {
          lines.push(`- recorded: ${change}`);
        }
        if (step.interventions.length > 0) {
          lines.push(`- guardrail: ${step.interventions.join(', ')}`);
        }
        if (step.nudge) lines.push(`- nudge: ${step.nudge.outcome}`);
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
      const criteria = scenario.criteria.filter(entry => entry.repetition === run.repetition);
      if (criteria.length > 0) {
        lines.push('', 'Criteria:');
        for (const criterion of criteria) lines.push(criterionLine(criterion));
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
