import { describe, it, expect } from 'vitest';
import { checkConversation, checkStep, matches } from '../../src/evals/conversations/assert.ts';
import type { Delivery } from '../../src/evals/conversations/channel.ts';
import type {
  RepetitionRun,
  StepRecord,
  TraceAction,
} from '../../src/evals/conversations/harness.ts';
import { reportJson, reportMarkdown } from '../../src/evals/conversations/run.ts';
import type { RunReport } from '../../src/evals/conversations/run.ts';
import { ConversationExpect, Step } from '../../src/contracts/conversations.ts';
import { fixtureTenant } from '../helpers/conversations.ts';

/**
 * specs/043-complete-conversation-evals.md § Assertions cover steps,
 * transitions, and terminal outcomes, and § Reports identify the evaluated
 * version and the first deviation: the deterministic assertions as pure
 * functions over a recorded run, and the report rendered from one. Every
 * reply, action and id is invented (C1).
 */

const ctx = { catalog: fixtureTenant.catalog, tools: fixtureTenant.tools, latencyBudgetMs: 8000 };

const action = (fields: Partial<TraceAction> & Pick<TraceAction, 'tool' | 'id'>): TraceAction => ({
  status: 'performed',
  step: 'one',
  ...fields,
});

function record(fields: Partial<StepRecord> = {}): StepRecord {
  return {
    id: 'one',
    input: { kind: 'message', text: 'hi' },
    outcome: 'answered_inline',
    reply: {
      messages: ['The Foundation Course is 450.00 USD.'],
      escalate: false,
      escalation_reason: null,
      confidence: 0.9,
      closing_question: 'Which evenings suit you?',
    },
    messages: ['The Foundation Course is 450.00 USD.', 'Which evenings suit you?'],
    actions: [],
    state: { fields: { course: 'foundation' }, tags: [], offering: 'foundation' },
    latencyMs: 100,
    costUsd: 0.001,
    interventions: [],
    ...fields,
  };
}

const step = (expect: object, id = 'one') =>
  Step.parse({ id, input: { kind: 'message', text: 'hi' }, expect });

function run(fields: Partial<RepetitionRun> = {}): RepetitionRun {
  return {
    repetition: 1,
    steps: [record()],
    notReached: [],
    terminal: 'completed',
    deliveries: [],
    actions: [],
    ...fields,
  };
}

describe('an action matcher names a status, never just an id (specs/043 § Assertions)', () => {
  it('matches attempted on a performed or failed request, and never on a discarded one', () => {
    const matcher = { tool: 'send_flow' as const, id: 'x', status: 'attempted' as const };
    expect(matches(matcher, action({ tool: 'send_flow', id: 'x' }))).toBe(true);
    expect(matches(matcher, action({ tool: 'send_flow', id: 'x', status: 'failed' }))).toBe(true);
    expect(matches(matcher, action({ tool: 'send_flow', id: 'x', status: 'discarded' }))).toBe(
      false,
    );
  });

  it('holds value and origin when the matcher names them', () => {
    const flow = action({ tool: 'send_flow', id: 'x', origin: 'stage' });
    expect(
      matches({ tool: 'send_flow', id: 'x', status: 'performed', origin: 'opening' }, flow),
    ).toBe(false);
    const write = action({ tool: 'set_field', id: 'course', value: 'foundation' });
    expect(
      matches({ tool: 'set_field', id: 'course', value: 'advanced', status: 'performed' }, write),
    ).toBe(false);
  });
});

describe('step assertions (specs/043 § Assertions cover steps, transitions, and terminal outcomes)', () => {
  it('checks the exact set of actions, both ways', () => {
    const recorded = record({
      actions: [action({ tool: 'set_field', id: 'course', value: 'foundation' })],
    });
    const exact = (list: object[]) =>
      checkStep(step({ actions: { exact: list } }), recorded, [], ctx);
    expect(exact([{ tool: 'set_field', id: 'course', status: 'performed' }])).toEqual([]);
    expect(exact([]).join()).toMatch(/expected exactly/);
    expect(
      exact([
        { tool: 'set_field', id: 'course', status: 'performed' },
        { tool: 'add_tag', id: 'interested_foundation', status: 'performed' },
      ]).join(),
    ).toMatch(/expected exactly/);
  });

  it('checks action order', () => {
    const recorded = record({
      actions: [
        action({ tool: 'set_field', id: 'intent', value: 'prospect' }),
        action({ tool: 'set_field', id: 'course', value: 'foundation' }),
      ],
    });
    const order = (ids: string[]) =>
      checkStep(
        step({
          actions: { order: ids.map(id => ({ tool: 'set_field', id, status: 'performed' })) },
        }),
        recorded,
        [],
        ctx,
      );
    expect(order(['intent', 'course'])).toEqual([]);
    expect(order(['course', 'intent']).join()).toMatch(/out of the declared order/);
  });

  it('checks the delivery order within the step', () => {
    const deliveries: Delivery[] = [
      { kind: 'flow', step: 'one', id: 'foundation_brochure' },
      { kind: 'reply', step: 'one', messages: ['That has the syllabus.'], via: 'inline' },
    ];
    const order = (entries: object[]) =>
      checkStep(step({ delivery: { order: entries } }), record(), deliveries, ctx);
    expect(order([{ flow: 'foundation_brochure' }, { reply: 'syllabus' }])).toEqual([]);
    expect(order([{ reply: 'syllabus' }, { flow: 'foundation_brochure' }]).join()).toMatch(
      /delivery out of the declared order/,
    );
  });

  it('checks the closing question as required, absent or exact', () => {
    const asked = record();
    const silent = record({ reply: { ...record().reply, closing_question: null } });
    const check = (expectation: unknown, recorded: StepRecord) =>
      checkStep(step({ closing_question: expectation }), recorded, [], ctx);
    expect(check('required', asked)).toEqual([]);
    expect(check('required', silent)).toEqual(['closing question required']);
    expect(check('absent', asked).join()).toMatch(/closing question present/);
    expect(check({ exact: 'Which evenings suit you?' }, asked)).toEqual([]);
    expect(check({ exact: 'Something else?' }, asked).join()).toMatch(/closing question expected/);
  });

  it('checks fields, tags and offering in the settled state', () => {
    const check = (state: object) => checkStep(step({ state }), record(), [], ctx);
    expect(check({ fields: { course: 'foundation' }, offering: 'foundation' })).toEqual([]);
    expect(check({ fields: { course: 'advanced' } })).toEqual([
      'field course expected advanced, got foundation',
    ]);
    expect(check({ tags: { present: ['interested_foundation'] } })).toEqual([
      'tag interested_foundation expected, absent',
    ]);
    expect(check({ offering: null })).toEqual(['offering expected null, got foundation']);
  });

  it('keeps the single-turn assertions of 009 on the delivered reply', () => {
    const failures = checkStep(
      step({ escalate: true, must_contain: ['link'], must_not_invent_prices: true }),
      record({ messages: ['It is 999.00 USD.'] }),
      [],
      ctx,
    );
    expect(failures).toEqual([
      'escalate expected true, got false',
      'ungrounded price(s): 999.00',
      'missing required text: link',
    ]);
  });
});

describe('whole-conversation assertions (specs/043 § Assertions cover steps, transitions, and terminal outcomes)', () => {
  const linkRun = run({
    deliveries: [
      { kind: 'reply', step: 'one', messages: ['It is 450.00 USD.'], via: 'inline' },
      { kind: 'flow', step: 'two', id: 'enrolment_link' },
      { kind: 'reply', step: 'two', messages: ['That is the link.'], via: 'inline' },
    ],
    steps: [
      record(),
      record({
        id: 'two',
        actions: [action({ tool: 'send_flow', id: 'enrolment_link', step: 'two' })],
      }),
    ],
    actions: [action({ tool: 'send_flow', id: 'enrolment_link', step: 'two' })],
  });
  const check = (expect: object, target = linkRun) =>
    checkConversation(ConversationExpect.parse({ terminal: 'completed', ...expect }), target, ctx);

  it('checks the terminal kind and the handoff step and reason', () => {
    expect(check({ terminal: 'handoff' })).toEqual(['terminal expected handoff, got completed']);
    const handedOff = run({
      terminal: 'handoff',
      steps: [
        record({
          reply: {
            ...record().reply,
            escalate: true,
            escalation_reason: 'low_confidence',
          },
        }),
      ],
    });
    expect(
      check(
        { terminal: 'handoff', handoff: { step: 'two', reason: 'explicit_request' } },
        handedOff,
      ),
    ).toEqual([
      'handoff expected at two, happened at one',
      'handoff reason expected explicit_request, got low_confidence',
    ]);
  });

  it('checks artifacts against the catalogue, without a price copied into the script', () => {
    expect(
      check({ artifacts: { required: [{ offering: 'foundation', field: 'price' }] } }),
    ).toEqual([]);
    expect(
      check({ artifacts: { forbidden: [{ offering: 'foundation', field: 'price' }] } }).join(),
    ).toMatch(/forbidden foundation.price delivered: 450.00 USD/);
    expect(
      check({ artifacts: { required: [{ offering: 'advanced', field: 'price' }] } }).join(),
    ).toMatch(/never delivered/);
  });

  it('checks counts, order and what may never follow an event', () => {
    const link = { tool: 'send_flow', id: 'enrolment_link', status: 'performed' };
    expect(check({ actions: { counts: [{ match: link, count: 2 }] } })).toEqual([
      'send_flow enrolment_link (performed) expected 2 times, got 1',
    ]);
    expect(
      check({ order: [{ first: { step: 'one' }, then: { flow: 'enrolment_link' } }] }),
    ).toEqual([]);
    expect(
      check({ order: [{ first: { flow: 'enrolment_link' }, then: { step: 'one' } }] }).join(),
    ).toMatch(/happened before/);
    expect(
      check({ order: [{ first: { flow: 'foundation_brochure' }, then: { step: 'one' } }] }).join(),
    ).toMatch(/never happened/);
    expect(
      check({
        never_after: [
          {
            ref: { artifact: { offering: 'foundation', field: 'price' } },
            after: { action: link },
          },
        ],
      }),
    ).toEqual([]);
    expect(
      check({ never_after: [{ ref: { step: 'two' }, after: { step: 'one' } }] }).join(),
    ).toMatch(/happened after/);
  });

  it('checks the final state', () => {
    expect(check({ state: { offering: 'advanced' } })).toEqual([
      'offering expected advanced, got foundation',
    ]);
  });
});

describe('the report names the evaluated version and the first deviation (specs/043 § Reports)', () => {
  const report: RunReport = {
    suite: 'evals/test',
    startedAt: '2026-01-15T10:00:00.000Z',
    frameworkVersion: '0.0.0-test',
    hashes: { config: 'c'.repeat(64), scenarios: 's'.repeat(64), fixtures: null },
    agent: { model: 'mock:demo', runner: 'ai-sdk', temperature: 0.3 },
    judge: null,
    playbook: null,
    scenarios: [
      {
        id: 'flaky',
        status: 'failed',
        unstable: true,
        executionError: false,
        pendingCriteria: 1,
        repetitions: [
          { run: run(), failures: [] },
          {
            run: run({ repetition: 2, notReached: ['three'], terminal: 'handoff' }),
            failures: [
              { step: 'one', message: 'missing required text: link', downstream: false },
              { message: 'terminal expected completed, got handoff', downstream: true },
            ],
          },
        ],
      },
    ],
    totals: {
      passed: 0,
      failed: 1,
      pendingReview: 0,
      unstable: 1,
      executionErrors: 0,
      agentCostUsd: 0.002,
      judgeCostUsd: null,
    },
  };

  it('prints the identity, each transcript, and which failure came first', () => {
    const markdown = reportMarkdown(report);
    expect(markdown).toContain('- Framework: 0.0.0-test');
    expect(markdown).toContain(`- Config: ${'c'.repeat(64)}`);
    expect(markdown).toContain('## flaky: failed (unstable)');
    expect(markdown).toContain('1 criteria pending review.');
    expect(markdown).toContain('- FIRST: one: missing required text: link');
    expect(markdown).toContain('- (downstream) terminal expected completed, got handoff');
    expect(markdown).toContain('Not reached: three');
    expect(markdown).toContain('judge cost not applicable');
  });

  it('keeps an unknown judge cost unknown, never zero', () => {
    expect(JSON.parse(reportJson(report))).toMatchObject({ totals: { judgeCostUsd: null } });
  });
});
