import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ReviewRecord, TranscriptStep } from '../../contracts/conversations.ts';
import { settleCoverage } from './coverage.ts';
import type { BranchCoverage, Coverage, StaleSource } from './coverage.ts';
import { quotable } from './judge.ts';
import { outcomesOf, statusOf } from './run.ts';
import type { ScenarioResult } from './run.ts';

/**
 * The gate (specs/043 § Offline validation and paid conversation runs are
 * separate commands): a finished run, the reviews people recorded against it,
 * and whether together they are evidence a change may be published. It never
 * rewrites the run: what it decides is written beside it.
 */

export const REVIEWS_FILE = 'reviews.jsonl';

const Outcome = z.enum(['pass', 'fail', 'ungraded', 'not_reached']);

const CriterionShape = z.looseObject({
  key: z.string(),
  text: z.string(),
  step: z.string().optional(),
  repetition: z.number().int(),
  outcome: Outcome,
  by: z.enum(['judge', 'review', 'none']),
  evidence: z
    .looseObject({ step: z.string(), quote: z.string(), absent: z.string().optional() })
    .optional(),
});

const WitnessShape = z.looseObject({
  scenario: z.string(),
  step: z.string(),
  criteria: z.array(z.string()),
  assertions: z.array(z.enum(['passed', 'failed', 'unreviewed', 'not_reached'])),
  repetitions: z.array(z.enum(['passed', 'failed', 'unreviewed', 'not_reached'])),
});

/**
 * The part of a written report the gate reads. The report is a file on disk,
 * so it is checked like any other input before anything is decided on it (C3).
 */
export const GateReport = z.looseObject({
  runId: z.string().min(1),
  evaluated: z.string().regex(/^[0-9a-f]{64}$/),
  scenarios: z.array(
    z.looseObject({
      id: z.string(),
      failures: z.number().int().nonnegative(),
      executionError: z.boolean(),
      criteria: z.array(CriterionShape),
      transcripts: z.array(z.array(TranscriptStep)),
    }),
  ),
  coverage: z.looseObject({
    inventory: z.boolean(),
    stale: z.array(
      z.looseObject({ source: z.string(), recorded: z.string(), current: z.string().nullable() }),
    ),
    branches: z.array(
      z.looseObject({
        id: z.string(),
        source: z.string(),
        status: z.string(),
        attempted: z.boolean(),
        witnesses: z.array(WitnessShape),
        conflict: z.unknown().optional(),
      }),
    ),
  }),
});
export type GateReport = z.infer<typeof GateReport>;

/**
 * A person's verdict that differs from an earlier one on the same criterion,
 * kept for investigation: the judge's, or another person's.
 */
export interface Disagreement {
  scenario: string;
  repetition: number;
  criterion: string;
  /** Who gave the earlier verdict. */
  with: 'judge' | 'reviewer';
  earlier: 'pass' | 'fail';
  review: 'pass' | 'fail';
  reviewer: string;
}

export interface GateResult {
  run: string;
  passed: boolean;
  /** Why it did not pass, one line each. */
  reasons: string[];
  /** The run evaluated something that has since changed. */
  stale: boolean;
  reviews: { applied: number; otherRuns: number; invalid: string[] };
  disagreements: Disagreement[];
  scenarios: { id: string; status: ScenarioResult['status'] }[];
  coverage: Coverage;
}

/** The suite's review records. Absent is none. A line that does not parse is an error. */
export function loadReviews(dir: string): { reviews: ReviewRecord[]; errors: string[] } {
  const file = join(dir, REVIEWS_FILE);
  if (!existsSync(file)) return { reviews: [], errors: [] };
  const reviews: ReviewRecord[] = [];
  const errors: string[] = [];
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, index) => {
      if (!line.trim()) return;
      try {
        const parsed = ReviewRecord.safeParse(JSON.parse(line));
        if (parsed.success) reviews.push(parsed.data);
        else
          errors.push(
            `${REVIEWS_FILE}:${index + 1}: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
          );
      } catch {
        errors.push(`${REVIEWS_FILE}:${index + 1}: not valid JSON`);
      }
    });
  return { reviews, errors };
}

/** Why a review cannot be applied to this run, or undefined when it can. */
function invalidReview(review: ReviewRecord, report: GateReport): string | undefined {
  const scenario = report.scenarios.find(entry => entry.id === review.scenario);
  if (!scenario) return `scenario ${review.scenario} is not in the run`;
  const criterion = scenario.criteria.find(
    entry => entry.key === review.criterion && entry.repetition === review.repetition,
  );
  if (!criterion) {
    return `${review.scenario} has no criterion ${review.criterion} in repetition ${review.repetition}`;
  }
  if (criterion.outcome === 'not_reached') return `${review.criterion} was not reached`;
  const step = scenario.transcripts[review.repetition - 1]?.find(
    entry => entry.step === review.step,
  );
  if (!step) return `step ${review.step} is not in repetition ${review.repetition}`;
  if (!quotable(step).includes(review.evidence)) {
    return `the evidence is not copied from step ${review.step}`;
  }
  return undefined;
}

/**
 * Applies the reviews made against this run and decides. A review resolves an
 * ungraded criterion. Beside a judge's verdict it is a recorded disagreement,
 * and the stricter verdict stands: it never erases a failure. A run that
 * evaluated something since changed is stale, and no review makes it pass.
 */
export function gate(
  report: GateReport,
  reviews: readonly ReviewRecord[],
  current: { evaluated: string; stale: readonly StaleSource[] },
  /** Review lines that did not parse: each might be a person's failure. */
  unreadable: readonly string[] = [],
): GateResult {
  const reasons: string[] = [];
  const stale = report.evaluated !== current.evaluated;
  if (stale) {
    reasons.push(
      `the run is stale: it evaluated ${report.evaluated}, and the prompt, config, scenarios, fixtures, calibration, playbook or models now come to ${current.evaluated}; run again`,
    );
  }

  const invalid: string[] = [...unreadable];
  const disagreements: Disagreement[] = [];
  const mine = reviews.filter(review => review.run === report.runId);
  const scenarios = report.scenarios.map(scenario => ({
    ...scenario,
    criteria: scenario.criteria.map(criterion => ({ ...criterion })),
  }));
  let applied = 0;
  for (const review of mine) {
    const problem = invalidReview(review, report);
    if (problem) {
      invalid.push(`${review.scenario} ${review.criterion}: ${problem}`);
      continue;
    }
    const criterion = scenarios
      .find(entry => entry.id === review.scenario)!
      .criteria.find(
        entry => entry.key === review.criterion && entry.repetition === review.repetition,
      )!;
    applied++;
    // Who decided it before any review: the judge, or nobody.
    const judged = report.scenarios
      .find(entry => entry.id === review.scenario)!
      .criteria.some(
        entry =>
          entry.key === review.criterion &&
          entry.repetition === review.repetition &&
          entry.by === 'judge',
      );
    if (criterion.outcome === 'ungraded') {
      criterion.outcome = review.verdict;
      criterion.by = 'review';
      criterion.evidence = { step: review.step, quote: review.evidence };
      continue;
    }
    if (criterion.outcome !== review.verdict && criterion.outcome !== 'not_reached') {
      disagreements.push({
        scenario: review.scenario,
        repetition: review.repetition,
        criterion: review.criterion,
        with: judged ? 'judge' : 'reviewer',
        earlier: criterion.outcome,
        review: review.verdict,
        reviewer: review.reviewer,
      });
      // The stricter stands: a person's failure is a failure, and a pass
      // does not erase an earlier failure, the judge's or another person's.
      if (review.verdict === 'fail') {
        criterion.outcome = 'fail';
        criterion.by = 'review';
        criterion.evidence = { step: review.step, quote: review.evidence };
      }
    }
  }

  const settled = scenarios.map(scenario => ({ id: scenario.id, ...statusOf(scenario) }));
  for (const scenario of settled) {
    if (scenario.status !== 'passed') reasons.push(`scenario ${scenario.id} is ${scenario.status}`);
  }
  const coverage = report.coverage.inventory
    ? settleCoverage(
        report.coverage.branches as unknown as BranchCoverage[],
        report.coverage.stale,
        outcomesOf(scenarios as unknown as ScenarioResult[]),
      )
    : { ...(report.coverage as unknown as Coverage), complete: false };
  if (!coverage.inventory) reasons.push('the suite has no branches.json');
  else if (!coverage.complete) {
    reasons.push(
      `branch coverage is incomplete: ${coverage.counts.verified} of ${coverage.counts.declared} verified`,
    );
  }
  if (current.stale.length > 0) {
    reasons.push(`the inventory is stale: ${current.stale.map(entry => entry.source).join(', ')}`);
  }
  if (invalid.length > 0) reasons.push(`${invalid.length} reviews could not be applied`);

  return {
    run: report.runId,
    passed: reasons.length === 0,
    reasons,
    stale,
    reviews: { applied, otherRuns: reviews.length - mine.length, invalid },
    disagreements,
    scenarios: settled.map(({ id, status }) => ({ id, status })),
    coverage,
  };
}
