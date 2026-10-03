import { afterAll, describe, it, expect } from 'vitest';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ActionStage,
  buildTools,
  contactActionsFrom,
  courseField,
  knownCourse,
} from '../../src/agent/tools.ts';
import type { ContactActions } from '../../src/agent/tools.ts';
import { buildSystemPrompt, courseNotice } from '../../src/agent/prompt.ts';
import { performedCourse } from '../../src/conversation/actions.ts';
import { capabilitiesFor, FUNNEL_STAGES } from '../../src/contracts/config.ts';
import type { Tools } from '../../src/contracts/config.ts';
import type { ActionRecord, StagedAction } from '../../src/contracts/agent.ts';
import { ManyChatInbound } from '../../src/contracts/manychat.ts';
import { ManyChatAdapter, renderManyChat } from '../../src/channels/manychat/adapter.ts';
import { ConfigError, loadTenantConfig } from '../../src/config/loader.ts';

/**
 * specs/028-multi-course-funnels.md § Verification items 1, 2, 3, 4 and 6,
 * against the fictional demo tenant in test/fixtures/config. Item 5 is in
 * test/integration/multi-course-funnels.test.ts, and item 7 in the golden set.
 */

const FIXTURE = 'test/fixtures/config';
const tenant = loadTenantConfig(FIXTURE);
const tools: Tools = tenant.tools!;

const on = (course: string | undefined, extra: Partial<ContactActions> = {}): ContactActions => ({
  sentFlows: new Set(),
  course,
  ...extra,
});

/** Calls a built tool's `execute` the way the SDK does. */
async function call(built: ReturnType<typeof buildTools>, name: string, input: object) {
  const execute = built![name]!.execute!;
  return (await execute(input as never, { toolCallId: 'test', messages: [], context: {} })) as {
    staged: boolean;
    flowsAvailable?: { flow: string; description: string }[];
  };
}

const sentFlows = (stage: ActionStage) =>
  stage.staged.flatMap(action => (action.tool === 'send_flow' ? [action.id] : []));

/* -------------------------------------------------------------------------- */
/* V1 — the course field and flow courses are checked against the catalog     */
/* -------------------------------------------------------------------------- */

describe('course config is checked at load (specs/028 V1)', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  type RawTools = {
    flows: Record<string, unknown>[];
    fields: (Record<string, unknown> & { id: string; values: string[] })[];
  };
  const fixtureTools = JSON.parse(readFileSync(join(FIXTURE, 'tools.json'), 'utf8')) as RawTools;
  const courseIndex = fixtureTools.fields.findIndex(field => field.course === true);

  /** Loads the fixture tenant with its tools.json edited by `edit`. */
  function loadWith(edit: (raw: RawTools) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'courses-'));
    dirs.push(dir);
    for (const file of ['prompt.md', 'catalog.json', 'rules.json']) {
      copyFileSync(join(FIXTURE, file), join(dir, file));
    }
    const raw = structuredClone(fixtureTools);
    edit(raw);
    writeFileSync(join(dir, 'tools.json'), JSON.stringify(raw));
    return () => loadTenantConfig(dir);
  }

  it('loads the demo tenant, whose course field lists the catalog ids', () => {
    expect(courseField(tools)?.values.sort()).toEqual(
      tenant.catalog.courses.map(course => course.id).sort(),
    );
  });

  it('accepts the catalog ids in any order', () => {
    const load = loadWith(raw => {
      raw.fields[courseIndex]!.values = [...raw.fields[courseIndex]!.values].reverse();
    });
    expect(load).not.toThrow();
  });

  it('refuses two course fields', () => {
    const load = loadWith(raw => {
      raw.fields.push({ ...raw.fields[courseIndex]!, id: 'second_course', field: 'second_course' });
    });
    expect(load).toThrow(ConfigError);
    expect(load).toThrow(/only one field may be marked "course"/);
  });

  it('refuses a course field whose values differ from the catalog course ids', () => {
    for (const values of [
      ['foundation', 'advanced'],
      ['foundation', 'advanced', 'evening'],
    ]) {
      const load = loadWith(raw => {
        raw.fields[courseIndex]!.values = values;
      });
      expect(load).toThrow(ConfigError);
      expect(load).toThrow(/must list exactly the catalog course ids/);
    }
  });

  it('refuses a flow whose course is not a catalog id', () => {
    const load = loadWith(raw => {
      raw.flows[0]!.course = 'evening';
    });
    expect(load).toThrow(ConfigError);
    expect(load).toThrow(/flow 'foundation_brochure' names course 'evening'/);
  });

  it('refuses one field marked both funnel and course', () => {
    const load = loadWith(raw => {
      raw.fields[0]!.course = true;
      raw.fields.splice(courseIndex, 1);
    });
    expect(load).toThrow(ConfigError);
    expect(load).toThrow(/may not be marked both "funnel" and "course"/);
  });

  it('refuses a flow with a course when no field is marked course', () => {
    const load = loadWith(raw => {
      raw.fields.splice(courseIndex, 1);
    });
    expect(load).toThrow(/has a course, but no field is marked "course"/);
  });

  it('refuses a payment-link flow with a course: one payment flow serves every course', () => {
    const load = loadWith(raw => {
      raw.flows[3]!.course = 'foundation';
    });
    expect(load).toThrow(/the "payment_link" flow may not have a "course"/);
  });
});

/* -------------------------------------------------------------------------- */
/* V2 — send_flow accepts the turn's course's flows and the shared ones       */
/* -------------------------------------------------------------------------- */

describe('send_flow accepts only the turn course’s flows (specs/028 V2)', () => {
  it('refuses another course’s flow', async () => {
    const stage = new ActionStage();
    const built = buildTools(tools, stage, on('foundation'));
    expect(await call(built, 'send_flow', { flow: 'advanced_brochure' })).toEqual({
      staged: false,
    });
    expect(await call(built, 'send_flow', { flow: 'foundation_brochure' })).toEqual({
      staged: true,
    });
    expect(sentFlows(stage)).toEqual(['foundation_brochure']);
  });

  it('accepts a flow without a course on a turn with no known course, and no course flow', async () => {
    const stage = new ActionStage();
    const built = buildTools(tools, stage, on(undefined));
    expect(await call(built, 'send_flow', { flow: 'student_results' })).toEqual({ staged: true });
    expect(await call(built, 'send_flow', { flow: 'enrolment_link' })).toEqual({ staged: true });
    for (const flow of ['foundation_brochure', 'advanced_brochure', 'intensive_brochure']) {
      expect(await call(built, 'send_flow', { flow })).toEqual({ staged: false });
    }
  });

  it('accepts the new course’s flow after set_field on the course field earlier in the turn', async () => {
    const stage = new ActionStage();
    const built = buildTools(tools, stage, on(undefined));
    expect(await call(built, 'send_flow', { flow: 'advanced_brochure' })).toEqual({
      staged: false,
    });

    const set = await call(built, 'set_field', { field: 'course', value: 'advanced' });
    // The result says what the write made available.
    expect(set).toEqual({
      staged: true,
      flowsAvailable: [
        {
          flow: 'advanced_brochure',
          description: tools.flows.find(flow => flow.id === 'advanced_brochure')!.description,
        },
      ],
    });
    expect(await call(built, 'send_flow', { flow: 'advanced_brochure' })).toEqual({
      staged: true,
    });
    // And the course it moved away from is now the other course.
    expect(await call(built, 'send_flow', { flow: 'foundation_brochure' })).toEqual({
      staged: false,
    });
  });

  it('describes only the flows it can accept now, each with its course', () => {
    const description = buildTools(tools, new ActionStage(), on('advanced'))!.send_flow!
      .description!;
    expect(description).toContain('- advanced_brochure (course advanced):');
    expect(description).toContain('- student_results:');
    expect(description).not.toContain('foundation_brochure');
    expect(description).not.toContain('intensive_brochure');
  });

  it('marks a staged write to the course field, and only that one', async () => {
    const stage = new ActionStage();
    const built = buildTools(tools, stage, on(undefined));
    await call(built, 'set_field', { field: 'course', value: 'foundation' });
    await call(built, 'set_field', { field: 'prior_experience', value: 'none' });
    expect(stage.staged).toEqual([
      { tool: 'set_field', id: 'course', field: 'course', value: 'foundation', course: true },
      { tool: 'set_field', id: 'prior_experience', field: 'prior_experience', value: 'none' },
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* V3 — the course is locked from offered                                     */
/* -------------------------------------------------------------------------- */

describe('the course is locked from the offer (specs/028 V3)', () => {
  const lockedFrom = FUNNEL_STAGES.indexOf('offered');

  it.each(FUNNEL_STAGES.slice(lockedFrom))('refuses a course write at %s', async funnelStage => {
    const stage = new ActionStage();
    const built = buildTools(tools, stage, on('foundation', { funnelStage }));
    expect(await call(built, 'set_field', { field: 'course', value: 'advanced' })).toEqual({
      staged: false,
    });
    expect(stage.staged).toHaveLength(0);
  });

  it.each(FUNNEL_STAGES.slice(0, lockedFrom))('accepts a course write at %s', async funnelStage => {
    const stage = new ActionStage();
    const built = buildTools(tools, stage, on('foundation', { funnelStage }));
    expect(await call(built, 'set_field', { field: 'course', value: 'advanced' })).toMatchObject({
      staged: true,
    });
  });

  it('accepts one with no stage recorded yet', async () => {
    const built = buildTools(tools, new ActionStage(), on(undefined));
    expect(await call(built, 'set_field', { field: 'course', value: 'advanced' })).toMatchObject({
      staged: true,
    });
  });

  it('refuses one after offered was staged earlier in the same turn', async () => {
    const stage = new ActionStage();
    const built = buildTools(tools, stage, on('foundation', { funnelStage: 'nurturing' }));
    await call(built, 'set_field', { field: 'funnel_stage', value: 'offered' });
    expect(await call(built, 'set_field', { field: 'course', value: 'advanced' })).toEqual({
      staged: false,
    });
  });

  it('tells the model to escalate a switch after the offer as explicit_request', () => {
    const { staticPrefix } = buildSystemPrompt(tenant.persona, tenant.catalog, tenant.rules, tools);
    expect(staticPrefix).toContain('COURSES');
    expect(staticPrefix).toMatch(/locked: a\s+contact who asks to switch course is escalated/);
    expect(staticPrefix).toContain('"explicit_request"');
  });
});

/* -------------------------------------------------------------------------- */
/* V4 — the inbound course                                                    */
/* -------------------------------------------------------------------------- */

describe('the inbound course is a catalog id or absent (specs/028 V4)', () => {
  const adapter = new ManyChatAdapter({
    sendText: async () => {},
    writeToken: async () => {},
    performAction: async () => {},
  });
  const parse = (course: unknown) =>
    adapter.parse(
      { subscriber_id: '1', text: 'hi', ...(course === undefined ? {} : { course }) },
      { tenantId: 'demo', channel: 'whatsapp' },
    );

  it('accepts the key in the strict inbound schema', () => {
    expect(ManyChatInbound.safeParse({ subscriber_id: '1', text: 'hi', course: 'x' }).success).toBe(
      true,
    );
  });

  it('keeps a catalog id', () => {
    expect(knownCourse(parse('advanced').course, tools)).toBe('advanced');
    expect(knownCourse(parse(' weekend-intensive ').course, tools)).toBe('weekend-intensive');
  });

  it.each([
    ['empty', ''],
    ['unrendered', '{{course}}'],
    ['unknown', 'evening'],
    ['null', null],
    ['missing', undefined],
  ])('treats an %s value as absent, never as a course', (_label, value) => {
    expect(knownCourse(parse(value).course, tools)).toBeUndefined();
  });

  it('knows no course on a tenant without a course field', () => {
    const plain: Tools = { ...tools, fields: tools.fields.filter(field => !field.course) };
    expect(knownCourse('advanced', plain)).toBeUndefined();
  });

  it('asks ManyChat to fill the course into the callback, from the course field', () => {
    const rendered = renderManyChat(
      {
        messages: ['Hi'],
        escalate: false,
        escalation_reason: null,
        confidence: 0.9,
        closing_question: null,
      },
      {
        capabilities: capabilitiesFor('whatsapp'),
        callbackUrl: 'https://example.com/message',
        courseField: 'course',
      },
    );
    expect(rendered.content.external_message_callback?.payload).toMatchObject({
      course: '{{course}}',
    });
  });
});

/* -------------------------------------------------------------------------- */
/* V6 — sent once means once per contact, whatever the course                 */
/* -------------------------------------------------------------------------- */

describe('a course change does not bring a sent flow back (specs/028 V6)', () => {
  const performed = (id: string): ActionRecord => ({ tool: 'send_flow', id, status: 'performed' });

  it('offers the new course’s flows but not a shared flow sent before the change', async () => {
    // On foundation, the contact was sent its brochure and a shared flow.
    const contact = contactActionsFrom(
      [
        {
          createdAt: new Date(),
          actions: [performed('foundation_brochure'), performed('student_results')],
        },
      ],
      tools,
      new Date(0),
    );
    const stage = new ActionStage();
    const built = buildTools(tools, stage, { ...contact, course: 'advanced' });
    const description = built!.send_flow!.description!;

    expect(description).not.toContain('student_results');
    expect(description).toContain('advanced_brochure');
    expect(await call(built, 'send_flow', { flow: 'advanced_brochure' })).toEqual({
      staged: true,
    });

    // Moving back does not restore what was received on the first course.
    const back = buildTools(tools, new ActionStage(), { ...contact, course: 'foundation' });
    expect(back!.send_flow!.description).not.toContain('foundation_brochure');
  });
});

/* -------------------------------------------------------------------------- */
/* The course reaches the model and the conversation row                      */
/* -------------------------------------------------------------------------- */

describe('the course note and the performed course (specs/028)', () => {
  it('notes the course, its absence, and a change the request made', () => {
    expect(courseNotice(undefined)).toBe('COURSE: No course is recorded for this contact yet.');
    expect(courseNotice('advanced')).toBe("COURSE: This contact's course is advanced.");
    expect(courseNotice('advanced', 'foundation')).toMatch(
      /changed from foundation to advanced.*Confirm which course they want/,
    );
  });

  it('reads the last course write ManyChat accepted', () => {
    const write = (value: string): StagedAction => ({
      tool: 'set_field',
      id: 'course',
      field: 'course',
      value,
      course: true,
    });
    const other: StagedAction = { tool: 'set_field', id: 'x', field: 'x', value: 'y' };
    const record = (status: ActionRecord['status']): ActionRecord[] => [
      { tool: 'set_field', id: 'course', status },
    ];
    expect(
      performedCourse(
        [write('foundation'), other, write('advanced')],
        [record('performed'), record('performed'), record('failed')],
      ),
    ).toBe('foundation');
    expect(performedCourse([other], [record('performed')])).toBeUndefined();
  });
});
