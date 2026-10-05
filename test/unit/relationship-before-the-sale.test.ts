import { describe, it, expect, vi } from 'vitest';
import type { z } from 'zod';
import { ActionStage, buildTools } from '../../src/agent/tools.ts';
import type { ContactActions } from '../../src/agent/tools.ts';
import { FlowSends } from '../../src/agent/flows.ts';
import { openingNotice } from '../../src/agent/prompt.ts';
import { ToolsSchema } from '../../src/contracts/config.ts';
import type { Tools } from '../../src/contracts/config.ts';
import type { PerformableAction } from '../../src/contracts/agent.ts';
import { loadTenantConfig } from '../../src/config/loader.ts';

/**
 * specs/032-relationship-before-the-sale.md § Verification items 1, 2 (the
 * enum), 3 and 4, against the fictional demo tenant in test/fixtures/config
 * with an invented opening flow and two flows tied to stages.
 */

const fixture = loadTenantConfig('test/fixtures/config').tools!;
const OPENING_NS = 'content00000000000000_000201';
const raw = (): Record<string, unknown> & { flows: Record<string, unknown>[] } =>
  structuredClone({
    ...fixture,
    flows: [
      ...fixture.flows.map(flow =>
        flow.id === 'student_results'
          ? { ...flow, onStage: 'nurturing' }
          : flow.id === 'foundation_brochure'
            ? { ...flow, onStage: 'offered' }
            : flow,
      ),
      {
        id: 'welcome_note',
        flowNs: OPENING_NS,
        description: 'A short welcome voice note that asks whether the contact has studied before.',
        role: 'opening',
      },
    ],
  });
const tools: Tools = ToolsSchema.parse(raw());

const parse = (mutate: (input: ReturnType<typeof raw>) => void) => {
  const input = raw();
  mutate(input);
  return ToolsSchema.safeParse(input);
};
const messages = (result: ReturnType<typeof parse>) =>
  result.success ? [] : result.error.issues.map(issue => issue.message);

/** Calls a built tool's `execute` the way the SDK does. */
async function call(built: ReturnType<typeof buildTools>, name: string, input: object) {
  const execute = built![name]!.execute!;
  return (await execute(input as never, {
    toolCallId: 'test',
    messages: [],
    context: {},
  })) as Record<string, unknown>;
}

async function enumOf(schema: unknown, parameter: string): Promise<unknown[]> {
  const { asSchema } = await import('ai');
  const json = (await asSchema(schema as z.ZodType).jsonSchema) as {
    properties: Record<string, { enum?: unknown[] }>;
  };
  return json.properties[parameter]?.enum ?? [];
}

/** A contact at `stage`: a prospect, as one past new is by the rollout rule (specs/034). */
const at = (stage: string, extra: Partial<ContactActions> = {}): ContactActions => ({
  sentFlows: new Set(),
  funnelStage: stage,
  intent: 'prospect',
  ...extra,
});

/** A flow sender over a fake performer, recording every request (the ManyChat boundary). */
function sender() {
  const performed: PerformableAction[] = [];
  const flows = new FlowSends({
    performer: {
      performAction: (_subscriber: string, action: PerformableAction) => {
        performed.push(action);
        return Promise.resolve();
      },
    },
    subscriberId: 's1',
    logger: { warn: vi.fn() },
    tools,
  });
  return { flows, performed };
}

/* -------------------------------------------------------------------------- */
/* V1 — the opening and stage-tied flows are checked at load                  */
/* -------------------------------------------------------------------------- */

describe('opening and stage-tied flows are checked at load (specs/032 V1)', () => {
  it('loads the demo tenant with an opening flow, two tied flows and prepared', () => {
    expect(parse(() => undefined).success).toBe(true);
  });

  it('refuses two opening flows', () => {
    const result = parse(input => {
      input.flows.push({ ...input.flows.at(-1)!, id: 'second_welcome' });
    });
    expect(messages(result)).toContain('only one flow may have role "opening"');
  });

  it.each([
    ['a course', { course: 'foundation' }],
    ['repeatable', { repeatable: true }],
  ])('refuses an opening flow with %s', (_label, extra) => {
    const result = parse(input => Object.assign(input.flows.at(-1)!, extra));
    expect(messages(result)).toContain(
      'the "opening" flow may not have a "course" or be "repeatable"',
    );
  });

  // `role` is one value, so a flow cannot be both opening and payment link.
  it.each(['opening', 'payment_link'])('refuses an onStage on the %s flow', role => {
    const result = parse(input => {
      Object.assign(
        input.flows.find(flow => flow.role === role)!,
        { onStage: 'nurturing' },
      );
    });
    expect(messages(result)).toContain(
      'the "opening" and "payment_link" flows may not have an "onStage"',
    );
  });

  it('refuses two flows tied to one stage', () => {
    const result = parse(input => {
      Object.assign(
        input.flows.find(flow => flow.id === 'fitting_it_in')!,
        {
          onStage: 'nurturing',
        },
      );
    });
    expect(messages(result)).toContain('at most one flow per "onStage"');
  });

  it.each(['new', 'link_sent', 'enrolled'])('refuses onStage %s', stage => {
    const result = parse(input => {
      Object.assign(
        input.flows.find(flow => flow.id === 'fitting_it_in')!,
        { onStage: stage },
      );
    });
    expect(result.success).toBe(false);
  });

  it('refuses a funnel field without prepared', () => {
    const result = parse(input => {
      const fields = input.fields as { funnel?: boolean; values: string[] }[];
      fields.find(field => field.funnel)!.values = [
        'new',
        'qualifying',
        'nurturing',
        'offered',
        'link_sent',
      ];
    });
    expect(messages(result).join()).toMatch(/offered, prepared, link_sent/);
  });

  it('refuses a tied flow without a funnel field', () => {
    const result = parse(input => {
      input.fields = (input.fields as { funnel?: boolean }[]).filter(field => !field.funnel);
    });
    expect(messages(result)).toContain('a flow with "onStage" needs a field marked "funnel"');
  });
});

/* -------------------------------------------------------------------------- */
/* V2 (the tool) — the model never chooses the opening                        */
/* -------------------------------------------------------------------------- */

describe('the opening flow is the server’s (specs/032 V2)', () => {
  it('is absent from send_flow’s enum, on a first turn or any other', async () => {
    for (const contact of [at('new', { openingDue: true }), at('nurturing')]) {
      const built = buildTools(tools, new ActionStage(), contact);
      const ids = await enumOf(built!.send_flow!.inputSchema, 'flow');
      expect(ids).not.toContain('welcome_note');
      expect(ids).toContain('student_results');
    }
  });

  // On the prospect turn since specs/034, not the first turn.
  it('tells the model, on the prospect turn, that the flow goes before its reply', () => {
    const notice = openingNotice(tools.flows.find(flow => flow.role === 'opening')!);
    expect(notice).toContain('Recording prospect queued the flow welcome_note');
    expect(notice).toContain('sends it before your reply');
    expect(notice).toContain('Unless you escalate');
  });

  it('tells the model not to greet again or ask the flow’s question again', () => {
    const notice = openingNotice(tools.flows.find(flow => flow.role === 'opening')!);
    expect(notice).toContain('does not greet them');
    expect(notice).toContain('do not ask it again');
    expect(notice).toContain('Unless their message already answers it, send closing_question null');
    // The wording that made the reply repeat the flow's question (2026-10-04).
    expect(notice).not.toContain('close with the question');
  });
});

/* -------------------------------------------------------------------------- */
/* V3 — a stage move carries its flow                                         */
/* -------------------------------------------------------------------------- */

describe('a funnel write to a tied stage sends its flow (specs/032 V3)', () => {
  const moveTo = async (contact: ContactActions, value: string) => {
    const stage = new ActionStage();
    const { flows, performed } = sender();
    const built = buildTools(tools, stage, contact, undefined, { flows });
    const result = await call(built, 'set_field', { field: 'funnel_stage', value });
    return { stage, performed, result, built };
  };

  it('sends the tied flow during the call, names it, and records its origin', async () => {
    const { stage, performed, result } = await moveTo(at('qualifying'), 'nurturing');

    expect(result).toEqual({ staged: true, flowSent: 'student_results' });
    expect(performed.map(action => action.id)).toEqual(['student_results']);
    expect(stage.records('staged')).toEqual([
      { tool: 'set_field', id: 'funnel_stage', value: 'nurturing', status: 'staged' },
      { tool: 'send_flow', id: 'student_results', status: 'performed', origin: 'stage' },
    ]);
  });

  it('sends it once in a turn, however many times the stage is written', async () => {
    const { performed, built } = await moveTo(at('qualifying'), 'nurturing');
    expect(await call(built, 'set_field', { field: 'funnel_stage', value: 'nurturing' })).toEqual({
      staged: true,
    });
    expect(performed).toHaveLength(1);
  });

  it('sends nothing when the flow was already performed for the contact', async () => {
    const contact = at('qualifying', { sentFlows: new Set(['student_results']) });
    const { performed, result } = await moveTo(contact, 'nurturing');
    expect(result).toEqual({ staged: true });
    expect(performed).toHaveLength(0);
  });

  it('sends nothing when the write is not a move', async () => {
    const { performed, result } = await moveTo(at('nurturing'), 'nurturing');
    expect(result).toEqual({ staged: true });
    expect(performed).toHaveLength(0);
  });

  it('sends nothing when the tied flow belongs to another course', async () => {
    const { performed, result } = await moveTo(at('nurturing', { course: 'advanced' }), 'offered');
    expect(result).toEqual({ staged: true });
    expect(performed).toHaveLength(0);
  });

  it('sends the tied flow for the turn’s course', async () => {
    const { performed, result } = await moveTo(
      at('nurturing', { course: 'foundation' }),
      'offered',
    );
    expect(result).toEqual({ staged: true, flowSent: 'foundation_brochure' });
    expect(performed.map(action => action.id)).toEqual(['foundation_brochure']);
  });

  it('sends only the stage written, never one skipped', async () => {
    const { performed } = await moveTo(at('qualifying', { course: 'foundation' }), 'offered');
    expect(performed.map(action => action.id)).toEqual(['foundation_brochure']);
  });

  it('stages it on a nudge turn, which has no flow sender', async () => {
    const stage = new ActionStage();
    const built = buildTools(tools, stage, at('qualifying'), undefined, { nudgeTurn: true });
    const result = await call(built, 'set_field', { field: 'funnel_stage', value: 'nurturing' });

    expect(result).toEqual({ staged: true, flowStaged: 'student_results' });
    expect(stage.staged.map(action => action.id)).toEqual(['funnel_stage', 'student_results']);
  });

  /** A stage with seven actions already staged, so the funnel write is the eighth. */
  const nearlyFull = () => {
    const stage = new ActionStage();
    for (let index = 0; index < 7; index++) {
      stage.stage({ tool: 'add_tag', id: `tag_${index}`, tag: `tag-${index}` });
    }
    return stage;
  };

  it('says flowDropped, not flowRefused, when the write fills the cap', async () => {
    const stage = nearlyFull();
    const { flows, performed } = sender();
    const built = buildTools(tools, stage, at('qualifying'), undefined, { flows });
    const result = await call(built, 'set_field', { field: 'funnel_stage', value: 'nurturing' });

    expect(result).toEqual({
      staged: true,
      flowDropped: 'student_results',
      reason: 'over the per-turn limit',
    });
    expect(performed).toHaveLength(0);
  });

  it('says flowDropped on a nudge turn when the write fills the cap', async () => {
    const built = buildTools(tools, nearlyFull(), at('qualifying'), undefined, { nudgeTurn: true });
    const result = await call(built, 'set_field', { field: 'funnel_stage', value: 'nurturing' });
    expect(result).toEqual({
      staged: true,
      flowDropped: 'student_results',
      reason: 'over the per-turn limit',
    });
  });

  it('says flowRefused only when ManyChat refused the flow', async () => {
    const flows = new FlowSends({
      performer: { performAction: () => Promise.reject(new Error('flow not found')) },
      subscriberId: 's1',
      logger: { warn: vi.fn() },
      tools,
    });
    const built = buildTools(tools, new ActionStage(), at('qualifying'), undefined, { flows });
    const result = await call(built, 'set_field', { field: 'funnel_stage', value: 'nurturing' });
    expect(result).toEqual({ staged: true, flowRefused: 'student_results' });
  });

  it('marks tied flows in the send_flow listing', () => {
    const built = buildTools(tools, new ActionStage(), at('qualifying'));
    expect(built!.send_flow!.description).toContain(
      'student_results (sent by the system when you record nurturing)',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* V4 — the payment link waits for prepared, unless the contact asked         */
/* -------------------------------------------------------------------------- */

describe('the payment link waits for readiness (specs/032 V4)', () => {
  const link = async (contact: ContactActions, input: object = {}) => {
    const stage = new ActionStage();
    const { flows, performed } = sender();
    const built = buildTools(tools, stage, contact, undefined, { flows });
    const before = async (calls: [string, object][]) => {
      for (const [name, args] of calls) await call(built, name, args);
    };
    return { stage, performed, built, before, input };
  };

  it('is refused with not_prepared before prepared, with no request', async () => {
    const { built, performed } = await link(at('offered'));
    expect(await call(built, 'send_flow', { flow: 'enrolment_link' })).toEqual({
      sent: false,
      reason: 'not_prepared',
    });
    expect(performed).toHaveLength(0);
  });

  it('is refused when staged as well, on a nudge turn', async () => {
    const stage = new ActionStage();
    const built = buildTools(tools, stage, at('offered'), undefined, { nudgeTurn: true });
    expect(await call(built, 'send_flow', { flow: 'enrolment_link' })).toEqual({
      staged: false,
      reason: 'not_prepared',
    });
    expect(stage.staged).toHaveLength(0);
  });

  it('is accepted once prepared is performed', async () => {
    const { built, performed } = await link(at('prepared'));
    expect(await call(built, 'send_flow', { flow: 'enrolment_link' })).toEqual({ sent: true });
    expect(performed.map(action => action.id)).toEqual(['enrolment_link', 'funnel_stage']);
  });

  it('is accepted when prepared was staged earlier in the turn', async () => {
    const { built, before } = await link(at('offered'));
    await before([['set_field', { field: 'funnel_stage', value: 'prepared' }]]);
    expect(await call(built, 'send_flow', { flow: 'enrolment_link' })).toEqual({ sent: true });
  });

  it('is accepted before prepared with contactAsked, which is recorded', async () => {
    const { built, stage } = await link(at('nurturing'));
    expect(await call(built, 'send_flow', { flow: 'enrolment_link', contactAsked: true })).toEqual({
      sent: true,
    });
    expect(stage.records('staged')[0]).toEqual({
      tool: 'send_flow',
      id: 'enrolment_link',
      status: 'performed',
      contactAsked: true,
    });
  });

  it('records no contactAsked when the link was not gated', async () => {
    const { built, stage } = await link(at('prepared'));
    expect(await call(built, 'send_flow', { flow: 'enrolment_link', contactAsked: true })).toEqual({
      sent: true,
    });
    expect(stage.records('staged')[0]).toEqual({
      tool: 'send_flow',
      id: 'enrolment_link',
      status: 'performed',
    });
  });

  it('records no contactAsked on any other flow', async () => {
    const { built, stage } = await link(at('nurturing'));
    await call(built, 'send_flow', { flow: 'fitting_it_in', contactAsked: true });
    expect(stage.records('staged')).toEqual([
      { tool: 'send_flow', id: 'fitting_it_in', status: 'performed' },
    ]);
  });

  it('refuses a course or stage write beside a link waiting on the opening', async () => {
    const stage = new ActionStage();
    const { flows, performed } = sender();
    let openingSent = false;
    const beforeFlow = async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      openingSent = true;
    };
    const built = buildTools(tools, stage, at('new', { course: 'foundation' }), undefined, {
      flows,
      beforeFlow,
    });
    // One step: the SDK starts these together, so the writes run during the await.
    const [linked, course, funnel] = await Promise.all([
      call(built, 'send_flow', { flow: 'enrolment_link', contactAsked: true }),
      call(built, 'set_field', { field: 'course', value: 'advanced' }),
      call(built, 'set_field', { field: 'funnel_stage', value: 'offered' }),
    ]);

    expect(openingSent).toBe(true);
    expect(linked).toEqual({ sent: true });
    expect(course).toEqual({ staged: false });
    expect(funnel).toEqual({ staged: false });
    expect(stage.staged).toEqual([]);
    expect(performed.map(action => action.id)).toEqual(['enrolment_link', 'funnel_stage']);
  });

  it('tells the model when it may pass contactAsked', () => {
    const built = buildTools(tools, new ActionStage(), at('offered'));
    expect(built!.send_flow!.description).toContain('Pass contactAsked: true only when');
  });
});
