import { describe, it, expect } from 'vitest';
import {
  evaluatedOf,
  exitCode,
  identityOf,
  reportJson,
  reportMarkdown,
  runSuite,
} from '../../src/evals/conversations/run.ts';
import type { Evaluated, RunReport } from '../../src/evals/conversations/run.ts';
import { gate, GateReport } from '../../src/evals/conversations/gate.ts';
import { BranchInventory } from '../../src/contracts/conversations.ts';
import type { ReviewRecord } from '../../src/contracts/conversations.ts';
import type { GroupCalibration } from '../../src/evals/judge.ts';
import type { Suite } from '../../src/evals/conversations/suite.ts';
import { runOptions, scenario, scriptedJudge } from '../helpers/conversations.ts';

/**
 * specs/043-complete-conversation-evals.md § Verification items 8 and 10:
 * the judge grades a run's criteria behind calibration and its failures
 * stand; with no judge they wait for a person; a review binds to the run it
 * was made against, and the gate refuses a stale run, an unresolved review
 * and incomplete coverage. The agent and judge models are faked at the
 * provider boundary (specs/004). Every message is invented (C1).
 */

const ZERO = '0'.repeat(64);
const REPLY = 'The Foundation Course is 450.00 USD.';
const CRITERION = 'Answers what the contact asked.';

const asks = scenario({
  steps: [
    {
      id: 'asks',
      input: { kind: 'message', text: 'how much is the foundation course?' },
      expect: { escalate: false, witnesses: [{ branch: 'answers', criteria: [0] }] },
      review: [CRITERION],
    },
  ],
  expect: { terminal: 'completed' },
});

const suite: Suite = {
  dir: 'test',
  scenarios: [asks],
  fixtures: { flows: {} },
  inventory: BranchInventory.parse({
    sources: [{ path: 'prompt.md', sha256: ZERO }],
    branches: [
      {
        id: 'answers',
        source: { file: 'prompt.md', clause: 'WHAT YOU DO' },
        description: 'The agent answers the question asked.',
        prerequisite: 'None.',
        condition: 'The contact asks a price.',
        outcome: 'The reply gives it.',
        scenarios: ['scenario'],
      },
    ],
  }),
  hashes: { scenarios: 's'.repeat(64), fixtures: null, branches: 'b'.repeat(64) },
};

const evaluated: Evaluated = {
  frameworkVersion: 'test',
  hashes: {
    config: 'c'.repeat(64),
    framework: 'f'.repeat(64),
    scenarios: 's'.repeat(64),
    fixtures: null,
    branches: 'b'.repeat(64),
    calibration: 'k'.repeat(64),
  },
  agent: { model: 'mock:demo', runner: 'langchain', temperature: 0.3 },
  judge: { model: 'mock:judge' },
  playbook: null,
};

const CALIBRATED = new Map<string, GroupCalibration>([
  ['free_text', { group: 'free_text', items: 2, agreement: 1, calibrated: true }],
]);
const pass = { verdict: 'pass', step: '', evidence: '', absent: '', reason: 'It answers.' };
const fail = {
  verdict: 'fail',
  step: 'asks',
  evidence: REPLY,
  absent: '',
  reason: 'It answers a different course.',
};

/** A run of the one-scenario suite, the agent answering `REPLY` unless told otherwise. */
async function run(opts: {
  judge?: ReturnType<typeof scriptedJudge> | undefined;
  groups?: Map<string, GroupCalibration>;
  reply?: string;
  mustContain?: string;
}): Promise<RunReport> {
  const target = opts.mustContain
    ? scenario({
        ...asks,
        steps: [
          {
            ...asks.steps[0]!,
            expect: { ...asks.steps[0]!.expect, must_contain: [opts.mustContain] },
          },
        ],
      })
    : asks;
  const { opts: options } = runOptions(() => [{ reply: { messages: [opts.reply ?? REPLY] } }]);
  return runSuite(
    { ...suite, scenarios: [target] },
    identityOf(evaluated, 'test', '2026-01-15T10:00:00.000Z'),
    {
      ...options,
      judge: opts.judge
        ? {
            judge: opts.judge,
            groups: opts.groups ?? CALIBRATED,
            agentPrompt: 'An invented prompt.',
          }
        : undefined,
    },
  );
}

const review = (report: RunReport, fields: Partial<ReviewRecord> = {}): ReviewRecord => ({
  run: report.runId,
  scenario: 'scenario',
  repetition: 1,
  criterion: 'asks.review[0]',
  verdict: 'pass',
  step: 'asks',
  evidence: REPLY,
  reviewer: 'reviewer-1',
  ...fields,
});

/** The report as the gate reads it: from the JSON written to disk. */
const written = (report: RunReport) => GateReport.parse(JSON.parse(reportJson(report)));
const current = { evaluated: evaluatedOf(evaluated), stale: [] };

describe('the judge grades a run behind calibration, and its failures stand (specs/043 V8)', () => {
  it('passes a scenario whose criterion it passes in both repetitions, and verifies the branch it witnesses', async () => {
    const judge = scriptedJudge([pass]);
    const report = await run({ judge });
    const [result] = report.scenarios;
    expect(result!.status).toBe('passed');
    expect(result!.criteria.map(entry => [entry.repetition, entry.outcome, entry.by])).toEqual([
      [1, 'pass', 'judge'],
      [2, 'pass', 'judge'],
    ]);
    expect(report.coverage.branches[0]!.status).toBe('verified');
    expect(report.totals.criteria).toEqual({ judgedPass: 2, judgedFail: 0, ungraded: 0 });
    expect(report.totals.judgeCostUsd).not.toBeNull();
    expect(judge.calls).toBe(6);
    expect(exitCode(report)).toBe(0);
  });

  it('fails a scenario on a judged failure, with the quote and the step it came from', async () => {
    const report = await run({ judge: scriptedJudge([fail]) });
    const [result] = report.scenarios;
    expect(result).toMatchObject({ status: 'failed', judgedFail: true, failures: 0 });
    expect(result!.criteria[0]!.evidence).toEqual({
      step: 'asks',
      quote: REPLY,
      absent: undefined,
    });
    expect(report.totals).toMatchObject({ failed: 0, judgedFail: 1 });
    expect(reportMarkdown(report)).toContain(`asks: "${REPLY}"`);
    expect(exitCode(report)).toBe(1);
  });

  it('never consults the judge once a deterministic assertion failed: the judge cannot override it', async () => {
    const judge = scriptedJudge([pass]);
    const report = await run({ judge, mustContain: 'INVENTED-MISSING-TEXT' });
    expect(report.scenarios[0]).toMatchObject({ status: 'failed', judgedFail: false });
    expect(report.scenarios[0]!.criteria.every(entry => entry.outcome === 'ungraded')).toBe(true);
    expect(judge.calls).toBe(0);
  });

  it('leaves criteria pending, and the gate incomplete, with an uncalibrated or unavailable judge', async () => {
    const uncalibrated = await run({
      judge: scriptedJudge([pass]),
      groups: new Map([
        ['free_text', { group: 'free_text', items: 1, agreement: 0, calibrated: false }],
      ]),
    });
    const unavailable = await run({ judge: scriptedJudge([new Error('invented outage')]) });
    const absent = await run({});
    for (const report of [uncalibrated, unavailable, absent]) {
      expect(report.scenarios[0]!.status).toBe('pending_review');
      expect(report.coverage.branches[0]!.status).toBe('unreviewed');
      expect(exitCode(report)).toBe(1);
    }
    expect(absent.totals.judgeCostUsd).toBeNull();
  });
});

describe('the gate applies reviews made against this run, and only it (specs/043 V10)', () => {
  it('passes once a person resolves every pending criterion in both repetitions', async () => {
    const report = await run({});
    const result = gate(
      written(report),
      [review(report), review(report, { repetition: 2 })],
      current,
    );
    expect(result).toMatchObject({ passed: true, reasons: [], reviews: { applied: 2 } });
    expect(result.coverage.branches[0]!.status).toBe('verified');
  });

  it('refuses an unresolved review: one repetition is not both', async () => {
    const report = await run({});
    const result = gate(written(report), [review(report)], current);
    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('scenario scenario is pending_review');
    expect(result.reasons).toContain('branch coverage is incomplete: 0 of 1 verified');
  });

  it('refuses a stale run, whatever its reviews say', async () => {
    const report = await run({});
    const edited = evaluatedOf({
      ...evaluated,
      hashes: { ...evaluated.hashes, config: 'd'.repeat(64) },
    });
    const result = gate(written(report), [review(report), review(report, { repetition: 2 })], {
      evaluated: edited,
      stale: [],
    });
    expect(result).toMatchObject({ passed: false, stale: true });
    expect(result.reasons[0]).toMatch(/^the run is stale/);
  });

  it('never applies an approval made against another run', async () => {
    const report = await run({});
    const result = gate(
      written(report),
      [
        review(report, { run: 'an-earlier-run' }),
        review(report, { run: 'an-earlier-run', repetition: 2 }),
      ],
      current,
    );
    expect(result.reviews).toMatchObject({ applied: 0, otherRuns: 2 });
    expect(result.passed).toBe(false);
  });

  it('refuses a review whose evidence is not copied from the step it names', async () => {
    const report = await run({});
    const result = gate(
      written(report),
      [
        review(report, { evidence: 'Words the agent never wrote.' }),
        review(report, { repetition: 2 }),
      ],
      current,
    );
    expect(result.reviews.invalid).toEqual([
      'scenario asks.review[0]: the evidence is not copied from step asks',
    ]);
    expect(result.passed).toBe(false);
  });

  it('records a disagreement with the judge and keeps the stricter verdict', async () => {
    const failed = await run({ judge: scriptedJudge([fail]) });
    const overruled = gate(
      written(failed),
      [review(failed), review(failed, { repetition: 2 })],
      current,
    );
    expect(overruled.passed).toBe(false);
    expect(overruled.disagreements).toHaveLength(2);
    expect(overruled.disagreements[0]).toMatchObject({ judge: 'fail', review: 'pass' });

    const passed = await run({ judge: scriptedJudge([pass]) });
    const caught = gate(written(passed), [review(passed, { verdict: 'fail' })], current);
    expect(caught.passed).toBe(false);
    expect(caught.scenarios).toEqual([{ id: 'scenario', status: 'failed' }]);
  });

  it('binds the run to everything it evaluated: any edit is a different run', () => {
    const base = evaluatedOf(evaluated);
    const edits: Evaluated[] = [
      { ...evaluated, hashes: { ...evaluated.hashes, calibration: null } },
      { ...evaluated, hashes: { ...evaluated.hashes, framework: 'g'.repeat(64) } },
      { ...evaluated, hashes: { ...evaluated.hashes, fixtures: 'x'.repeat(64) } },
      { ...evaluated, playbook: 'v2' },
      { ...evaluated, judge: { model: 'mock:other' } },
      { ...evaluated, agent: { ...evaluated.agent, temperature: 0 } },
    ];
    for (const edit of edits) expect(evaluatedOf(edit)).not.toBe(base);
    const identity = identityOf(evaluated, 'test', '2026-01-15T10:00:00.000Z');
    expect(identity.runId).toBe(`${base.slice(0, 12)}-20260115100000000`);
  });
});
