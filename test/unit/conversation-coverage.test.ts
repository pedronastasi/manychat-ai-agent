import { describe, it, expect } from 'vitest';
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  coverageOf,
  currentHash,
  staleSources,
  validateInventory,
} from '../../src/evals/conversations/coverage.ts';
import type { RepetitionRun, StepRecord } from '../../src/evals/conversations/harness.ts';
import { BranchInventory, Scenario } from '../../src/contracts/conversations.ts';
import type { ManifestSource } from '../../src/contracts/conversations.ts';
import { fixtureTenant } from '../helpers/conversations.ts';

/**
 * specs/043-complete-conversation-evals.md § Verification item 7: a branch
 * is covered only by a witness that ran and passed in both repetitions;
 * seeded, skipped, stale, conflicted and ungraded branches never turn green.
 * Every scenario, branch and reply is invented (C1).
 */

const ctx = { catalog: fixtureTenant.catalog, tools: fixtureTenant.tools, latencyBudgetMs: 8000 };
const tenant = { ...fixtureTenant, configDir: 'test/fixtures/config' };
const ZERO = '0'.repeat(64);

const source = (path: string): ManifestSource => {
  const entry = { path, sha256: ZERO };
  return { path, sha256: currentHash(entry, tenant)! };
};

const branch = (id: string, fields: object = {}) => ({
  id,
  source: { file: 'prompt.md', clause: 'WHAT YOU DO' },
  description: 'An invented branch.',
  prerequisite: 'None.',
  condition: 'The contact asks.',
  outcome: 'The agent answers.',
  scenarios: ['s'],
  ...fields,
});

const inventory = (...branches: object[]) =>
  BranchInventory.parse({ sources: [source('prompt.md')], branches });

/** A scenario, `s`, whose step `ask` witnesses `a` by its escalate assertion and `b` by its criterion. */
const quiz = Scenario.parse({
  id: 's',
  description: 'An invented conversation.',
  steps: [
    {
      id: 'ask',
      input: { kind: 'message', text: 'hi' },
      expect: {
        escalate: false,
        witnesses: [
          { branch: 'a', assertions: ['escalate'] },
          { branch: 'b', criteria: [0] },
        ],
      },
      review: ['Greets the contact.'],
    },
    { id: 'later', input: { kind: 'message', text: 'ok' } },
  ],
  expect: { terminal: 'completed' },
});

function record(fields: Partial<StepRecord> = {}): StepRecord {
  return {
    id: 'ask',
    input: { kind: 'message', text: 'hi' },
    outcome: 'answered_inline',
    reply: {
      messages: ['Hello.'],
      escalate: false,
      escalation_reason: null,
      confidence: 0.9,
      closing_question: null,
    },
    messages: ['Hello.'],
    replies: 1,
    clockMs: 0,
    actions: [],
    state: { fields: {}, tags: [], offering: null, pendingNudge: null },
    latencyMs: 100,
    costUsd: 0,
    interventions: [],
    ...fields,
  };
}

const run = (repetition: number, steps: StepRecord[]): RepetitionRun => ({
  repetition,
  steps,
  notReached: [],
  terminal: 'completed',
  deliveries: [],
  actions: [],
});

const escalated = record({
  reply: { ...record().reply, escalate: true, escalation_reason: 'low_confidence' },
});

function statusOf(id: string, runs: RepetitionRun[], inv = inventory(branch('a'), branch('b'))) {
  const coverage = coverageOf(inv, [quiz], new Map([['s', runs]]), [], ctx);
  return coverage.branches.find(entry => entry.id === id)!.status;
}

describe('coverage needs a passing witness in both repetitions (specs/043 V7)', () => {
  it('verifies a branch whose witness passed twice', () => {
    expect(statusOf('a', [run(1, [record()]), run(2, [record()])])).toBe('verified');
  });

  it('fails it when either repetition failed the cited assertion', () => {
    expect(statusOf('a', [run(1, [record()]), run(2, [escalated])])).toBe('failed');
  });

  it('leaves it not reached when a repetition skipped the step, or only one ran', () => {
    expect(statusOf('a', [run(1, [record()]), run(2, [])])).toBe('not_reached');
    expect(statusOf('a', [run(1, [record()])])).toBe('not_reached');
    expect(statusOf('a', [])).toBe('not_reached');
  });

  it('counts an execution error at the witness step as a failure', () => {
    const errored = record({ executionError: 'model error: APICallError' });
    expect(statusOf('a', [run(1, [record()]), run(2, [errored])])).toBe('failed');
  });

  it('leaves a branch proved only by an ungraded criterion unreviewed', () => {
    expect(statusOf('b', [run(1, [record()]), run(2, [record()])])).toBe('unreviewed');
  });

  it('never covers a branch only listed on a scenario or seeded in its initial state', () => {
    // `c` lists the scenario, and no step witnesses it.
    const inv = inventory(branch('a'), branch('b'), branch('c'));
    expect(statusOf('c', [run(1, [record()]), run(2, [record()])], inv)).toBe('not_reached');
  });

  it('marks a conflicted branch a blocker, whatever its witness did', () => {
    const inv = inventory(
      branch('a', {
        conflict: {
          sources: [{ file: 'prompt.md', clause: "WHAT YOU DON'T DO" }],
          note: 'One clause says to answer, another to hand off.',
        },
      }),
      branch('b'),
    );
    const coverage = coverageOf(
      inv,
      [quiz],
      new Map([['s', [run(1, [record()]), run(2, [record()])]]]),
      [],
      ctx,
    );
    const conflicted = coverage.branches.find(entry => entry.id === 'a')!;
    expect(conflicted.status).toBe('conflicted');
    expect(conflicted.conflict?.scenarios).toEqual(['s']);
    expect(coverage.complete).toBe(false);
  });

  it('marks a branch on a changed source stale, and the coverage incomplete', () => {
    const stale = [{ source: 'prompt.md', recorded: ZERO, current: 'f'.repeat(64) }];
    const inv = inventory(branch('a'));
    const coverage = coverageOf(
      inv,
      [quiz],
      new Map([['s', [run(1, [record()]), run(2, [record()])]]]),
      stale,
      ctx,
    );
    expect(coverage.branches[0]!.status).toBe('stale');
    expect(coverage.complete).toBe(false);
  });

  it('is complete only when every branch is verified and every source current', () => {
    const passed = [run(1, [record()]), run(2, [record()])];
    const only = coverageOf(inventory(branch('a')), [quiz], new Map([['s', passed]]), [], ctx);
    expect(only.complete).toBe(true);
    expect(only.counts).toMatchObject({ declared: 1, attempted: 1, verified: 1 });
    const both = coverageOf(
      inventory(branch('a'), branch('b')),
      [quiz],
      new Map([['s', passed]]),
      [],
      ctx,
    );
    expect(both.complete).toBe(false);
    expect(both.counts).toMatchObject({ declared: 2, attempted: 2, verified: 1, unreviewed: 1 });
  });

  it('is never complete without an inventory', () => {
    expect(coverageOf(undefined, [quiz], new Map(), [], ctx)).toMatchObject({
      inventory: false,
      complete: false,
    });
  });
});

describe('the source manifest notices a changed source (specs/043 V7)', () => {
  it('finds nothing stale against the sources as they are', () => {
    expect(staleSources(inventory(branch('a')), tenant)).toEqual([]);
  });

  it('names a tenant file that changed or went missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tenant-'));
    cpSync('test/fixtures/config', dir, { recursive: true });
    writeFileSync(join(dir, 'prompt.md'), 'An invented prompt.\n');
    const inv = BranchInventory.parse({
      sources: [source('prompt.md'), { path: 'gone.md', sha256: ZERO }],
      branches: [branch('a')],
    });
    const stale = staleSources(inv, { ...tenant, configDir: dir });
    expect(stale.map(entry => [entry.source, entry.current === null])).toEqual([
      ['prompt.md', false],
      ['gone.md', true],
    ]);
  });

  it('hashes the framework apart from the tenant: a persona change leaves it current', () => {
    const rules = { framework: 'operating-rules' as const, sha256: ZERO };
    const tools = { framework: 'tool-descriptions' as const, sha256: ZERO };
    const before = [currentHash(rules, tenant), currentHash(tools, tenant)];
    const renamed = { ...tenant, persona: 'An invented persona.' };
    expect([currentHash(rules, renamed), currentHash(tools, renamed)]).toEqual(before);
    expect(before.every(hash => /^[0-9a-f]{64}$/.test(hash!))).toBe(true);
  });
});

describe('the inventory is checked against the suite before any run (specs/043 V1, V7)', () => {
  it('accepts an inventory that holds', () => {
    expect(validateInventory(inventory(branch('a'), branch('b')), [quiz], tenant)).toEqual([]);
  });

  it('rejects unknown sources, scenarios, branches, assertions and criteria', () => {
    const bad = Scenario.parse({
      ...quiz,
      steps: [
        {
          id: 'ask',
          input: { kind: 'message', text: 'hi' },
          expect: {
            witnesses: [
              { branch: 'a', assertions: ['state'] },
              { branch: 'b', criteria: [3] },
              { branch: 'nowhere', assertions: ['escalate'] },
            ],
          },
        },
      ],
    });
    const inv = BranchInventory.parse({
      sources: [source('prompt.md'), { path: '../outside.md', sha256: ZERO }],
      branches: [
        branch('a', { source: { file: 'framework:operating-rules', clause: 'OPERATING RULES' } }),
        branch('b', { scenarios: ['other'] }),
        branch('b'),
      ],
    });
    expect(validateInventory(inv, [bad], tenant)).toEqual([
      'branches.json: source ../outside.md is outside CONFIG_DIR',
      'branches.json: branch a: source framework:operating-rules is not in the manifest',
      'branches.json: branch b: scenario other is not in the suite',
      'branches.json: branch b: duplicate branch id',
      'scenario s step ask witness a: the step declares no state assertion',
      'scenario s step ask witness b: the step has no review criterion 3',
      'scenario s step ask witness nowhere: no such branch in branches.json',
    ]);
  });

  it('refuses a witness that names nothing it proves', () => {
    const parsed = Scenario.safeParse({
      ...quiz,
      steps: [
        {
          id: 'ask',
          input: { kind: 'message', text: 'hi' },
          expect: { witnesses: [{ branch: 'a' }] },
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });
});

describe('the transcript reports coverage with its denominator (specs/043 § Branch coverage)', () => {
  it('names each status and the branch witnesses', async () => {
    const { coverageLines } = await import('../../src/evals/conversations/run.ts');
    const passed = [run(1, [record()]), run(2, [record()])];
    const coverage = coverageOf(
      inventory(branch('a'), branch('b')),
      [quiz],
      new Map([['s', passed]]),
      [],
      ctx,
    );
    const text = coverageLines(coverage).join('\n');
    expect(text).toContain('Incomplete: 1 of 2 declared verified; 2 of 2 declared attempted');
    expect(text).toContain('- a: verified (s/ask [passed, passed])');
    expect(text).toContain('- b: unreviewed (s/ask [unreviewed, unreviewed])');
    expect(coverageLines(coverageOf(undefined, [], new Map(), [], ctx)).join('\n')).toContain(
      'No branches.json',
    );
  });
});
