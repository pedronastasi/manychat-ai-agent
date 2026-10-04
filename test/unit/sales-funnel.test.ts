import { afterAll, describe, it, expect } from 'vitest';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { z } from 'zod';
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import {
  ActionStage,
  buildTools,
  contactActionsFrom,
  NO_CONTACT_ACTIONS,
} from '../../src/agent/tools.ts';
import type { ContactActions } from '../../src/agent/tools.ts';
import { buildSystemPrompt, funnelNotice } from '../../src/agent/prompt.ts';
import { findUngroundedPrices } from '../../src/agent/guardrails.ts';
import { GenerateTextRunner } from '../../src/agent/runner.ts';
import { CatalogSchema, NO_TOOLS, ToolsSchema } from '../../src/contracts/config.ts';
import type { Tools } from '../../src/contracts/config.ts';
import { EscalationReason } from '../../src/contracts/agent.ts';
import type { ActionRecord } from '../../src/contracts/agent.ts';
import { ConfigError, loadTenantConfig } from '../../src/config/loader.ts';
import { mockModel } from '../helpers/model.ts';
import { createMockModel } from '../../src/agent/mock-provider.ts';

/**
 * specs/023-sales-funnel.md § Verification items 1, 2, 3 and 6, against the
 * fictional demo tenant in test/fixtures/config.
 */

const FIXTURE = 'test/fixtures/config';
const tenant = loadTenantConfig(FIXTURE);
const tools: Tools = tenant.tools!;

const parse = (schema: unknown, input: unknown) => (schema as z.ZodType).safeParse(input);

/** The values a built tool's parameter offers the model, as its JSON Schema renders them. */
async function enumOf(schema: unknown, parameter: string): Promise<unknown[]> {
  const { asSchema } = await import('ai');
  const json = (await asSchema(schema as z.ZodType).jsonSchema) as {
    properties: Record<string, { enum?: unknown[] }>;
  };
  return json.properties[parameter]?.enum ?? [];
}

const stagedAt = (stage: string): ContactActions => ({ sentFlows: new Set(), funnelStage: stage });

/** Calls a built tool's `execute` the way the SDK does. */
async function call(built: ReturnType<typeof buildTools>, name: string, input: object) {
  const execute = built![name]!.execute!;
  return (await execute(input as never, { toolCallId: 'test', messages: [], context: {} })) as {
    staged: boolean;
  };
}

/* -------------------------------------------------------------------------- */
/* V1 — the stage only moves forward; link_sent is the server's               */
/* -------------------------------------------------------------------------- */

describe('the funnel only moves forward (specs/023 V1)', () => {
  it('refuses a write to a stage earlier than the last performed one', async () => {
    const stage = new ActionStage();
    const built = buildTools(tools, stage, stagedAt('offered'));

    expect(await call(built, 'set_field', { field: 'funnel_stage', value: 'qualifying' })).toEqual({
      staged: false,
    });
    expect(stage.staged).toHaveLength(0);
  });

  it('accepts the same stage and a later one', async () => {
    const stage = new ActionStage();
    const built = buildTools(tools, stage, stagedAt('nurturing'));

    expect(await call(built, 'set_field', { field: 'funnel_stage', value: 'nurturing' })).toEqual({
      staged: true,
    });
    expect(await call(built, 'set_field', { field: 'funnel_stage', value: 'offered' })).toEqual({
      staged: true,
    });
  });

  it('refuses a walk back within one turn, before anything was performed', async () => {
    const stage = new ActionStage();
    const built = buildTools(tools, stage);

    await call(built, 'set_field', { field: 'funnel_stage', value: 'offered' });
    expect(await call(built, 'set_field', { field: 'funnel_stage', value: 'nurturing' })).toEqual({
      staged: false,
    });
  });

  it('leaves the other fields alone', async () => {
    const stage = new ActionStage();
    const built = buildTools(tools, stage, stagedAt('offered'));

    expect(await call(built, 'set_field', { field: 'prior_experience', value: 'none' })).toEqual({
      staged: true,
    });
  });

  it('keeps link_sent out of the model’s enum', async () => {
    const built = buildTools(tools, new ActionStage())!;
    const schema = built.set_field!.inputSchema;

    expect(await enumOf(schema, 'value')).not.toContain('link_sent');
    expect(await enumOf(schema, 'value')).toContain('offered');
    expect(parse(schema, { field: 'funnel_stage', value: 'link_sent' }).success).toBe(false);
    expect(built.set_field!.description).not.toContain('link_sent');
  });
});

/* -------------------------------------------------------------------------- */
/* V2 — one funnel field, one payment-link flow, checked at load              */
/* -------------------------------------------------------------------------- */

describe('funnel and payment-link config is checked at load (specs/023 V2)', () => {
  const fixtureTools = JSON.parse(readFileSync(`${FIXTURE}/tools.json`, 'utf8')) as {
    flows: Record<string, unknown>[];
    fields: Record<string, unknown>[];
  };

  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  /** The demo tenant with its tools.json edited, as a load to assert on. */
  function loadWith(edit: (raw: typeof fixtureTools) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'funnel-'));
    dirs.push(dir);
    for (const file of ['prompt.md', 'catalog.json', 'rules.json']) {
      copyFileSync(join(FIXTURE, file), join(dir, file));
    }
    const raw = structuredClone(fixtureTools);
    edit(raw);
    writeFileSync(join(dir, 'tools.json'), JSON.stringify(raw));
    return () => loadTenantConfig(dir);
  }

  it('loads the demo tenant, which marks one of each', () => {
    expect(tools.fields.filter(field => field.funnel)).toHaveLength(1);
    expect(tools.flows.filter(flow => flow.role === 'payment_link')).toHaveLength(1);
  });

  it('refuses two funnel fields', () => {
    const load = loadWith(raw => {
      raw.fields.push({ ...raw.fields[0], id: 'second_funnel', field: 'second_funnel' });
    });
    expect(load).toThrow(ConfigError);
    expect(load).toThrow(/only one field may be marked "funnel"/);
  });

  it('refuses two payment-link flows', () => {
    const load = loadWith(raw => {
      raw.flows.push({ ...raw.flows[3], id: 'second_link', flowNs: 'content_second_link' });
    });
    expect(load).toThrow(ConfigError);
    expect(load).toThrow(/only one flow may have role "payment_link"/);
  });

  it('refuses a funnel field whose values are out of funnel order', () => {
    const load = loadWith(raw => {
      raw.fields[0]!.values = ['new', 'offered', 'qualifying', 'nurturing', 'link_sent'];
    });
    expect(load).toThrow(/values must be new, qualifying, nurturing, offered, prepared, link_sent/);
  });

  it('refuses a funnel field that lists enrolled, which only a person sets', () => {
    const load = loadWith(raw => {
      raw.fields[0]!.values = [
        'new',
        'qualifying',
        'nurturing',
        'offered',
        'link_sent',
        'enrolled',
      ];
    });
    expect(load).toThrow(ConfigError);
  });

  it('refuses a role other than payment_link', () => {
    expect(
      ToolsSchema.safeParse({ flows: [{ id: 'x', flowNs: 'ns', description: 'd', role: 'other' }] })
        .success,
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* V3 — a flow is sent once per contact unless repeatable                     */
/* -------------------------------------------------------------------------- */

describe('each flow is sent once per contact (specs/023 V3)', () => {
  const now = new Date('2026-10-02T12:00:00Z');
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const performed = (id: string): ActionRecord => ({ tool: 'send_flow', id, status: 'performed' });

  it('drops a performed flow from send_flow’s enum and keeps a repeatable one', async () => {
    const contact = contactActionsFrom(
      [
        {
          createdAt: now,
          actions: [performed('foundation_brochure'), performed('enrolment_link')],
        },
      ],
      tools,
      since,
    );
    const built = buildTools(tools, new ActionStage(), contact)!;
    const ids = await enumOf(built.send_flow!.inputSchema, 'flow');

    expect(ids).not.toContain('foundation_brochure');
    expect(ids).toContain('enrolment_link');
    expect(ids).toContain('student_results');
    expect(built.send_flow!.description).not.toContain('foundation_brochure');
  });

  it('counts only performed entries, and only inside the history window', () => {
    const contact = contactActionsFrom(
      [
        { createdAt: new Date(since.getTime() - 1), actions: [performed('student_results')] },
        {
          createdAt: now,
          actions: [
            { tool: 'send_flow', id: 'fitting_it_in', status: 'failed', error: 'refused' },
            { tool: 'send_flow', id: 'foundation_brochure', status: 'discarded' },
            { tool: 'send_flow', id: 'enrolment_link', status: 'staged', contactAsked: true },
          ],
        },
        { createdAt: now, actions: null },
      ],
      tools,
      since,
    );
    expect([...contact.sentFlows]).toEqual([]);
  });

  it('stops offering send_flow once every flow is sent', () => {
    const onlyContent: Tools = { ...NO_TOOLS, flows: tools.flows.slice(0, 1) };
    const contact: ContactActions = { sentFlows: new Set(['foundation_brochure']) };
    expect(buildTools(onlyContent, new ActionStage(), contact)).toBeUndefined();
  });

  it('reads the stage last performed, however old', () => {
    const stageWrite = (value: string, status: ActionRecord['status'] = 'performed') => ({
      tool: 'set_field' as const,
      id: 'funnel_stage',
      value,
      status,
    });
    const contact = contactActionsFrom(
      [
        { createdAt: new Date('2026-01-01'), actions: [stageWrite('qualifying')] },
        { createdAt: new Date('2026-01-02'), actions: [stageWrite('nurturing')] },
        { createdAt: now, actions: [stageWrite('offered', 'discarded')] },
      ],
      tools,
      since,
    );
    expect(contact.funnelStage).toBe('nurturing');
  });
});

/* -------------------------------------------------------------------------- */
/* The payment-link flow carries the server's link_sent write                 */
/* -------------------------------------------------------------------------- */

describe('the sale ends at the payment-link flow (specs/023)', () => {
  it('stages link_sent as a follow-on of the payment-link flow, outside the cap', async () => {
    const stage = new ActionStage();
    const built = buildTools(tools, stage);
    await call(built, 'send_flow', { flow: 'enrolment_link', contactAsked: true });

    expect(stage.staged).toEqual([
      {
        tool: 'send_flow',
        id: 'enrolment_link',
        flowNs: 'content00000000000000_000004',
        followOn: {
          tool: 'set_field',
          id: 'funnel_stage',
          field: 'funnel_stage',
          value: 'link_sent',
        },
        contactAsked: true,
      },
    ]);
    // One staged action, not two: the follow-on does not count against the cap.
    expect(stage.records('staged')).toEqual([
      { tool: 'send_flow', id: 'enrolment_link', status: 'staged', contactAsked: true },
    ]);
  });

  it('carries no follow-on on a content flow, or without a funnel field', async () => {
    const stage = new ActionStage();
    await call(buildTools(tools, stage), 'send_flow', { flow: 'student_results' });
    const noFunnel: Tools = { ...tools, fields: tools.fields.filter(field => !field.funnel) };
    await call(buildTools(noFunnel, stage), 'send_flow', {
      flow: 'enrolment_link',
      contactAsked: true,
    });

    expect(stage.staged.every(action => !('followOn' in action))).toBe(true);
  });

  it('adds payment_reported to the closed set of escalation reasons', () => {
    expect(EscalationReason.options).toContain('payment_reported');
  });
});

/* -------------------------------------------------------------------------- */
/* The funnel rules are system instructions; the stage travels with the turn  */
/* -------------------------------------------------------------------------- */

describe('the funnel rules are the system’s (specs/023 § The selling voice is the tenant’s)', () => {
  const { staticPrefix, catalogBlock } = buildSystemPrompt(
    tenant.persona,
    tenant.catalog,
    tenant.rules,
    tools,
  );

  it('names the stages, the payment-link flow and the closing ask when a funnel is marked', () => {
    expect(staticPrefix).toContain('SALES');
    expect(staticPrefix).toContain('The field funnel_stage records where the sale is');
    expect(staticPrefix).toContain('The payment link is the flow enrolment_link');
    expect(staticPrefix).toContain('Ask one question per turn');
    // The plain ask moves from offered to prepared (specs/032 § Readiness comes
    // between the offer and the link).
    expect(staticPrefix).toContain('From prepared, the closing question offers to send');
  });

  it('leaves the SALES rules out for a tenant without a funnel', () => {
    const noFunnel: Tools = { ...tools, fields: tools.fields.filter(field => !field.funnel) };
    const prompt = buildSystemPrompt('P.', tenant.catalog, tenant.rules, noFunnel).staticPrefix;
    expect(prompt).not.toContain('SALES');
  });

  it('carries the never-list, payment_reported and the narrowed price_negotiation for every tenant', () => {
    const prompt = buildSystemPrompt('P.', tenant.catalog, tenant.rules).staticPrefix;
    expect(prompt).toContain('only two places left');
    expect(prompt).toContain('Never promise a job');
    expect(prompt).toContain('Never claim to be human');
    expect(prompt).toContain('"payment_reported"');
    expect(prompt).toContain('present the PAYMENT OPTIONS that cover it');
  });

  it('renders paymentOptions into the catalog block', () => {
    expect(catalogBlock).toContain('PAYMENT OPTIONS');
    expect(catalogBlock).toContain('- deposit: A $120 deposit holds a place');
  });

  it('says the stage in the turn’s message, never in the cached prompt', async () => {
    const { model, calls } = mockModel({
      messages: ['Happy to help.'],
      escalate: false,
      escalation_reason: null,
      confidence: 0.9,
      closing_question: null,
    });
    const runner = new GenerateTextRunner({
      model,
      modelSpec: 'mock:demo',
      config: () => tenant,
      maxOutputTokens: 400,
      temperature: 0,
    });
    await runner.run({ text: 'hello', history: [], contact: stagedAt('offered') });

    const texts = (calls[0] as LanguageModelV4CallOptions).prompt.flatMap(entry =>
      entry.role === 'user'
        ? entry.content.flatMap(part => (part.type === 'text' ? [part.text] : []))
        : entry.role === 'system'
          ? [entry.content]
          : [],
    );
    expect(texts).toContain(funnelNotice('offered'));
    expect(staticPrefix).not.toContain('FUNNEL:');
    expect(funnelNotice(NO_CONTACT_ACTIONS.funnelStage)).toBe(
      "FUNNEL: This contact's stage is new.",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* V6 — the price check covers paymentOptions                                 */
/* -------------------------------------------------------------------------- */

describe('no price absent from the catalog, paymentOptions included (specs/023 V6)', () => {
  it('accepts a figure a payment option publishes and flags one it does not', () => {
    expect(findUngroundedPrices(['A $120 deposit holds your place.'], tenant.catalog)).toEqual([]);
    expect(findUngroundedPrices(['A $150 deposit holds your place.'], tenant.catalog)).toEqual([
      '150',
    ]);
  });

  it('defaults paymentOptions to none and refuses duplicate ids', () => {
    const base = { ...tenant.catalog, paymentOptions: undefined };
    expect(CatalogSchema.parse(base).paymentOptions).toEqual([]);
    const twice = { id: 'deposit', description: 'd' };
    expect(CatalogSchema.safeParse({ ...base, paymentOptions: [twice, twice] }).success).toBe(
      false,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The mock model honours the objection rows it stands in for                 */
/* -------------------------------------------------------------------------- */

describe('the mock presents payment options only when the catalog has them (specs/023)', () => {
  const ask = async (catalog: typeof tenant.catalog) => {
    const runner = new GenerateTextRunner({
      model: createMockModel('demo'),
      modelSpec: 'mock:demo',
      config: () => ({ ...tenant, catalog }),
      maxOutputTokens: 400,
      temperature: 0,
    });
    return (await runner.run({ text: 'can I pay in instalments?', history: [] })).reply;
  };

  it('answers from paymentOptions when the tenant publishes them', async () => {
    expect((await ask(tenant.catalog)).escalate).toBe(false);
  });

  it('escalates as price_negotiation when the tenant publishes none', async () => {
    const reply = await ask({ ...tenant.catalog, paymentOptions: [] });
    expect(reply.escalate).toBe(true);
    expect(reply.escalation_reason).toBe('price_negotiation');
  });
});
