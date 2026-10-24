import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RulesSchema } from '../../src/contracts/config.ts';
import { loadCases } from '../../src/evals/cases.ts';
import { loadSuite, resolveArtifact, validateSuite } from '../../src/evals/conversations/suite.ts';
import { fixtureTenant } from '../helpers/conversations.ts';

/**
 * specs/043-complete-conversation-evals.md § Verification item 1: a suite is
 * checked against its schema and against the tenant before any provider
 * call. Every scenario here is invented (C1).
 */

const steps = [{ id: 'one', input: { kind: 'message', text: 'hi' } }];
const base = {
  id: 'base',
  description: 'An invented conversation.',
  steps,
  expect: { terminal: 'completed' },
};

/** A suite directory holding `lines` and, optionally, a fixtures file. */
function suiteOf(lines: object[], fixtures?: object): string {
  const dir = mkdtempSync(join(tmpdir(), 'conversations-'));
  writeFileSync(
    join(dir, 'conversations.jsonl'),
    lines.map(line => JSON.stringify(line)).join('\n'),
  );
  if (fixtures) writeFileSync(join(dir, 'fixtures.json'), JSON.stringify(fixtures));
  return dir;
}

/** Every problem the suite has, from parsing and validation alike. */
function problems(
  lines: object[],
  opts: { fixtures?: object; plugins?: string[]; rules?: object } = {},
) {
  const { suite, errors } = loadSuite(suiteOf(lines, opts.fixtures));
  if (!suite) return errors;
  const tenant = opts.rules
    ? { ...fixtureTenant, rules: RulesSchema.parse({ ...fixtureTenant.rules, ...opts.rules }) }
    : fixtureTenant;
  return validateSuite(suite, tenant, { plugins: opts.plugins ?? [] });
}

describe('a suite is rejected before any provider call (specs/043 V1)', () => {
  it('accepts a well-formed scenario', () => {
    expect(problems([base])).toEqual([]);
  });

  it('rejects duplicate scenario and step ids', () => {
    expect(problems([base, base])).toContain('scenario base: duplicate scenario id');
    expect(problems([{ ...base, steps: [...steps, ...steps] }])).toContain(
      'scenario base step one: duplicate step id',
    );
  });

  it('rejects an empty script and an unknown key', () => {
    expect(problems([{ ...base, steps: [] }]).join('\n')).toMatch(/steps/);
    expect(problems([{ ...base, agent_reply: 'written by hand' }]).join('\n')).toMatch(
      /agent_reply/,
    );
  });

  it('rejects inconsistent initial state', () => {
    const seeded = {
      ...base,
      initial: {
        history: [
          { role: 'user', text: 'the foundation course' },
          { role: 'agent', text: 'Noted.' },
        ],
        actions: [{ tool: 'set_field', id: 'course', value: 'foundation' }],
        offering: 'advanced',
      },
    };
    expect(problems([seeded]).join('\n')).toMatch(
      /offering field was written foundation but the offering is advanced/,
    );
    const noAgentTurn = {
      ...seeded,
      initial: { ...seeded.initial, history: [], offering: undefined },
    };
    expect(problems([noAgentTurn]).join('\n')).toMatch(/need an agent turn/);
  });

  it('rejects an unconfigured tool id and a value its field does not have', () => {
    const expectAction = (match: object) => ({
      ...base,
      steps: [{ ...steps[0], expect: { actions: { required: [match] } } }],
    });
    expect(
      problems([expectAction({ tool: 'send_flow', id: 'no_such_flow', status: 'performed' })]),
    ).toContain('scenario base step one: send_flow no_such_flow is not configured in tools.json');
    expect(
      problems([
        expectAction({ tool: 'set_field', id: 'course', value: 'cooking', status: 'performed' }),
      ]),
    ).toContain('scenario base step one: cooking is not a value of field course');
    expect(
      problems([expectAction({ tool: 'set_field', id: 'course', status: 'maybe' })]).join('\n'),
    ).toMatch(/status/);
  });

  it('rejects a catalog selector that does not resolve', () => {
    const selector = (offering: string, field: string) => ({
      ...base,
      expect: { terminal: 'completed', artifacts: { required: [{ offering, field }] } },
    });
    expect(problems([selector('foundation', 'price')])).toEqual([]);
    expect(problems([selector('no-such-course', 'price')])).toContain(
      'scenario base expect: no-such-course.price does not resolve against the catalog',
    );
  });

  it('rejects references to steps, flows and handoffs that do not exist', () => {
    const errors = problems([
      {
        ...base,
        expect: {
          terminal: 'handoff',
          handoff: { step: 'missing' },
          order: [{ first: { step: 'ghost' }, then: { flow: 'no_such_flow' } }],
        },
      },
    ]);
    expect(errors).toContain(
      'scenario base expect: handoff step missing is not a step of the scenario',
    );
    expect(errors).toContain('scenario base expect: step ghost is not a step of the scenario');
    expect(errors).toContain(
      'scenario base expect: flow no_such_flow is not configured in tools.json',
    );
  });

  it('rejects a missing flow fixture once the suite has review criteria', () => {
    const reviewed = { ...base, review: ['The conversation stays warm.'] };
    expect(problems([base])).toEqual([]);
    const errors = problems([reviewed]);
    expect(errors).toContain(
      'fixtures.json: flow foundation_brochure has no fixture, and the suite has review criteria',
    );
    const all = Object.fromEntries(
      fixtureTenant.tools!.flows.map(flow => [flow.id, { summary: `What ${flow.id} shows.` }]),
    );
    expect(problems([reviewed], { fixtures: { flows: all } })).toEqual([]);
    expect(problems([base], { fixtures: { flows: { no_such_flow: { content: 'x' } } } })).toContain(
      'fixtures.json: flow no_such_flow is not configured',
    );
  });

  it('rejects a suite whose tenant loads plugins without fixture adapters', () => {
    expect(problems([base], { plugins: ['example-crm'] }).join('\n')).toMatch(
      /plugins example-crm are loaded/,
    );
  });

  it('keeps the opening trigger a trusted event, never contact text', () => {
    const rules = { openingTrigger: { keywords: ['START-DEMO'], message: 'Welcome.' } };
    const opening = (kind: string, text: string) => ({
      ...base,
      steps: [{ id: 'one', input: { kind, text } }],
    });
    expect(problems([opening('opening', 'START-DEMO')], { rules })).toEqual([]);
    expect(problems([opening('opening', 'hello')], { rules })).toContain(
      'scenario base step one: "hello" is not a configured opening trigger',
    );
    expect(problems([opening('message', 'start-demo')], { rules })).toContain(
      'scenario base step one: a message that is an opening trigger must use input.kind "opening"',
    );
  });

  it('reports a line that is not JSON by its line number', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conversations-'));
    writeFileSync(join(dir, 'conversations.jsonl'), `${JSON.stringify(base)}\n{not json`);
    expect(loadSuite(dir).errors).toEqual(['conversations.jsonl:2: not valid JSON']);
  });

  it('still loads the single-turn cases beside a conversation suite (specs/009)', () => {
    expect(loadSuite('evals/golden').errors).toEqual([]);
    expect(loadCases('evals/golden').length).toBeGreaterThan(0);
  });

  it('resolves a selector to the value the prompt renders', () => {
    expect(resolveArtifact({ offering: 'foundation', field: 'price' }, fixtureTenant.catalog)).toBe(
      '450.00 USD',
    );
  });
});

describe('media and silence steps are checked before any provider call (specs/043 V1)', () => {
  const at = (step: object) => problems([{ ...base, steps: [step] }]);

  it('rejects a media file that is missing or outside the suite', () => {
    const media = (file: string) => ({
      id: 'one',
      input: { kind: 'media', media: 'audio', file, content_type: 'audio/ogg' },
    });
    expect(at(media('voice.ogg'))).toEqual([
      'scenario base step one: media file voice.ogg does not exist',
    ]);
    expect(at(media('../voice.ogg'))).toEqual([
      'scenario base step one: media file ../voice.ogg is outside the suite',
    ]);
  });

  it('keeps nudge expectations to silence steps, and pending nudges to configured delays', () => {
    expect(
      at({ id: 'one', input: { kind: 'message', text: 'hi' }, expect: { nudge: 'sent' } }),
    ).toEqual(['scenario base step one: a nudge expectation needs a silence step']);
    expect(
      at({
        id: 'one',
        input: { kind: 'silence', advance_minutes: 120 },
        expect: { nudge: 'sent', state: { pending_nudge: 'next_week' } },
      }),
    ).toEqual(['scenario base step one: nudge delay next_week is not configured in tools.json']);
  });

  it('rejects a silence with no length or longer than a week', () => {
    expect(at({ id: 'one', input: { kind: 'silence', advance_minutes: 0 } })).not.toEqual([]);
    expect(at({ id: 'one', input: { kind: 'silence', advance_minutes: 20_000 } })).not.toEqual([]);
  });

  it('rejects a witness when the suite has no branch inventory', () => {
    expect(
      at({
        id: 'one',
        input: { kind: 'message', text: 'hi' },
        expect: { escalate: false, witnesses: [{ branch: 'a', assertions: ['escalate'] }] },
      }),
    ).toEqual(['a step names a witness, but the suite has no branches.json']);
  });
});
