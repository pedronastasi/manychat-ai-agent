import { beforeEach, describe, it, expect } from 'vitest';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4CallOptions, LanguageModelV4Content } from '@ai-sdk/provider';
import { ActionStage, buildTools, silentPaymentLink } from '../../src/agent/tools.ts';
import type { ContactActions } from '../../src/agent/tools.ts';
import { FlowSends } from '../../src/agent/flows.ts';
import { applyGuardrails } from '../../src/agent/guardrails.ts';
import { buildSystemPrompt, stagedNotice } from '../../src/agent/prompt.ts';
import { RUNNERS } from '../helpers/runners.ts';
import type { RunnerClass } from '../helpers/runners.ts';
import { ToolsSchema } from '../../src/contracts/config.ts';
import type { Tools } from '../../src/contracts/config.ts';
import type { PerformableAction } from '../../src/contracts/agent.ts';
import type { ActionPerformer } from '../../src/channels/manychat/client.ts';
import { ConfigError, loadTenantConfig } from '../../src/config/loader.ts';
import { asProspect } from '../helpers/intent.ts';

/**
 * Runs under both runners (specs/050-langchain-runner-parity.md § Verification
 * item 6): the LangChain runner is held to the same behaviour.
 */
let Runner: RunnerClass;

/**
 * specs/023-sales-funnel.md § A silent payment flow leaves the link to the
 * reply, Verification items 7, 8 and 9, against the fictional demo tenant in
 * test/fixtures/config with its payment-link flow marked silent.
 */

const FIXTURE = 'test/fixtures/config';
const tenant = loadTenantConfig(FIXTURE);
const PAYMENT = 'enrolment_link';
const FOUNDATION_URL = 'https://example.com/enrol/foundation';

const silentTools: Tools = {
  ...tenant.tools!,
  flows: tenant.tools!.flows.map(flow => (flow.id === PAYMENT ? { ...flow, silent: true } : flow)),
};
const silentTenant = { ...tenant, tools: silentTools };

const prepared = (offering?: string): ContactActions =>
  asProspect({
    sentFlows: new Set(),
    funnelStage: 'prepared',
    ...(offering ? { offering } : {}),
  });

const reply = (messages: string[], closing: string | null = null, escalate = false) => ({
  messages,
  escalate,
  escalation_reason: escalate ? 'out_of_scope' : null,
  confidence: 0.9,
  closing_question: closing,
});

/** ManyChat at the performer port: accepts every request and records it. */
class RecordingPerformer implements ActionPerformer {
  readonly requests: string[] = [];
  performAction(_subscriberId: string, action: PerformableAction): Promise<void> {
    this.requests.push(`${action.tool} ${action.id}`);
    return Promise.resolve();
  }
}

const toolCall = (toolName: string, input: object): LanguageModelV4Content => ({
  type: 'tool-call',
  toolCallId: `call-${toolName}`,
  toolName,
  input: JSON.stringify(input),
});

/** A model at the provider boundary that sends the payment flow, then answers with `final`. */
function sendsPaymentThen(final: object) {
  const calls: LanguageModelV4CallOptions[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options: LanguageModelV4CallOptions) => {
      const step = calls.length;
      calls.push(options);
      const content: LanguageModelV4Content[] =
        step === 0
          ? [toolCall('send_flow', { flow: PAYMENT })]
          : [{ type: 'text', text: JSON.stringify(final) }];
      return {
        content,
        finishReason:
          step === 0
            ? { unified: 'tool-calls' as const, raw: 'tool_use' }
            : { unified: 'stop' as const, raw: 'end_turn' },
        usage: {
          inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 20, text: 20, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  return { model, calls };
}

async function paymentTurn(config: typeof tenant, final: object, contact: ContactActions) {
  const { model } = sendsPaymentThen(final);
  const performer = new RecordingPerformer();
  const runner = new Runner({
    model,
    modelSpec: 'mock:demo',
    config: () => config,
    maxOutputTokens: 400,
    temperature: 0,
  });
  const result = await runner.run({
    text: 'yes please',
    history: [],
    contact,
    flows: new FlowSends({ performer, subscriberId: 's1', logger: { warn: () => {} } }),
  });
  return { result, performer };
}

/* -------------------------------------------------------------------------- */
/* V7 — a reply after a silent payment flow always carries the link           */
/* -------------------------------------------------------------------------- */

describe.each(RUNNERS)('under the $name runner (specs/050 V6)', ({ Runner: Each }) => {
  beforeEach(() => {
    Runner = Each;
  });

  describe('a silent payment flow leaves the link to the reply (specs/023 V7)', () => {
    it('adds the offering’s link to a reply that left it out', async () => {
      const { result, performer } = await paymentTurn(
        silentTenant,
        reply(['All set, I am here if you need anything.']),
        prepared('foundation'),
      );

      expect(performer.requests).toContain(`send_flow ${PAYMENT}`);
      expect(result.reply.messages).toEqual([
        `All set, I am here if you need anything.\n${FOUNDATION_URL}`,
      ]);
      expect(result.interventions).toContain('payment_link_added');
    });

    it('leaves a reply that carries the link as it is', async () => {
      const written = reply([`Here is where you enrol:\n${FOUNDATION_URL}`]);
      const { result } = await paymentTurn(silentTenant, written, prepared('foundation'));

      expect(result.reply.messages).toEqual(written.messages);
      expect(result.interventions).not.toContain('payment_link_added');
    });

    it('uses the offering the turn recorded over the contact’s', () => {
      const stage = new ActionStage();
      stage.stage({
        tool: 'set_field',
        id: 'course',
        field: 'course',
        value: 'advanced',
        offering: true,
      });
      stage.stage({ tool: 'send_flow', id: PAYMENT, flowNs: 'content00000000000000_000004' });

      expect(
        silentPaymentLink(silentTools, tenant.catalog, stage, { offering: 'foundation' }),
      ).toBe('https://example.com/enrol/advanced');
    });

    it('asks nothing of a turn that did not send the payment flow', () => {
      expect(
        silentPaymentLink(silentTools, tenant.catalog, new ActionStage(), {
          offering: 'foundation',
        }),
      ).toBeUndefined();
    });

    it('asks nothing of a payment flow that is not silent', async () => {
      const { result } = await paymentTurn(
        tenant,
        reply(['All set, I am here if you need anything.']),
        prepared('foundation'),
      );

      expect(result.reply.messages).toEqual(['All set, I am here if you need anything.']);
      expect(result.interventions).not.toContain('payment_link_added');
    });

    it('hands the turn to a person when no offering is known to link to', async () => {
      const { result } = await paymentTurn(
        silentTenant,
        reply(['All set, I am here if you need anything.']),
        prepared(),
      );

      expect(result.reply.escalate).toBe(true);
      expect(result.reply.messages).toEqual([tenant.rules.messages.escalation]);
      expect(result.interventions).toContain('payment_link_unknown');
    });
  });

  describe('where the added link goes (specs/023 V7)', () => {
    const guard = (raw: object, earlier: string[] = []) =>
      applyGuardrails(raw, tenant.rules, earlier, { paymentLink: FOUNDATION_URL });

    it('ends the body, ahead of the closing question', () => {
      const { reply: out } = guard(
        reply(['Ready when you are.'], 'Anything else I can help with?'),
      );
      expect(out.messages).toEqual([
        `Ready when you are.\n${FOUNDATION_URL}`,
        'Anything else I can help with?',
      ]);
    });

    it('goes ahead of a question the body ends on', () => {
      const { reply: out } = guard(reply(['Ready when you are.', 'Anything else?']));
      expect(out.messages).toEqual([`Ready when you are.\n${FOUNDATION_URL}`, 'Anything else?']);
    });

    it('does not count another offering’s link that starts with this one', () => {
      const { reply: out, interventions } = guard(
        reply([`Enrol here:\n${FOUNDATION_URL}-plus`, `Or at ${FOUNDATION_URL}/extra`]),
      );
      expect(interventions).toContain('payment_link_added');
      expect(out.messages.at(-1)).toBe(`Or at ${FOUNDATION_URL}/extra\n${FOUNDATION_URL}`);
    });

    it('counts the link with a trailing slash or before punctuation', () => {
      for (const written of [`${FOUNDATION_URL}/`, `Enrol at ${FOUNDATION_URL}.`]) {
        expect(guard(reply([written])).interventions).not.toContain('payment_link_added');
      }
    });

    it('counts the link written with its percent-encoding undone', () => {
      const link = 'https://example.com/enrol/course-%E2%9C%93/';
      const { reply: out, interventions } = applyGuardrails(
        reply(['Enrol here:\nhttps://example.com/enrol/course-✓']),
        tenant.rules,
        [],
        { paymentLink: link },
      );
      expect(out.messages).toEqual(['Enrol here:\nhttps://example.com/enrol/course-✓']);
      expect(interventions).not.toContain('payment_link_added');
    });

    it('survives a repetition replaced by the closer', () => {
      const rules = {
        ...tenant.rules,
        messages: { ...tenant.rules.messages, closer: 'Talk soon!' },
      };
      const { reply: out } = applyGuardrails(reply(['Thanks!']), rules, ['Thanks!'], {
        paymentLink: FOUNDATION_URL,
      });
      expect(out.messages).toEqual([`Talk soon!\n${FOUNDATION_URL}`]);
    });

    it('is not added to an escalation', () => {
      const { reply: out } = guard(reply(['Let me pass you to the team.'], null, true));
      expect(out.messages).toEqual(['Let me pass you to the team.']);
    });
  });

  /* -------------------------------------------------------------------------- */
  /* V8 — the model is told the flow sends nothing and the link is its to write */
  /* -------------------------------------------------------------------------- */

  describe('the model is told the link is its to write (specs/023 V8)', () => {
    const prompt = (tools: Tools) =>
      buildSystemPrompt(tenant.persona, tenant.catalog, tenant.rules, tools).staticPrefix;

    it('says so in the sales rules, and only for a silent flow', () => {
      expect(prompt(silentTools)).toContain(
        `The payment link is recorded by the flow ${PAYMENT}, which is silent`,
      );
      expect(prompt(tenant.tools!)).toContain(`The payment link is the flow ${PAYMENT}.`);
      expect(prompt(tenant.tools!)).not.toContain('silent');
    });

    it('marks the flow silent where the model chooses it', () => {
      const built = buildTools(silentTools, new ActionStage(), prepared('foundation'))!;
      expect(built.send_flow!.description).toContain(
        `- ${PAYMENT} (silent: sends the contact nothing): `,
      );
    });

    it('says in the flow’s result that the link is the reply’s', async () => {
      const performer = new RecordingPerformer();
      const flows = new FlowSends({ performer, subscriberId: 's1', logger: { warn: () => {} } });
      const built = buildTools(silentTools, new ActionStage(), prepared('foundation'), undefined, {
        flows,
      })!;
      const result = await built.send_flow!.execute!({ flow: PAYMENT } as never, {
        toolCallId: 'test',
        messages: [],
        context: {},
      });
      expect(result).toEqual({
        sent: true,
        silent: expect.stringContaining('link of the contact’s offering from the CATALOG'),
      });
    });

    it('tells the reply step it was recorded, not received, and to write the link', () => {
      const sent = [
        {
          action: {
            tool: 'send_flow' as const,
            id: PAYMENT,
            flowNs: 'content00000000000000_000004',
          },
          records: [{ status: 'performed' }],
        },
      ];
      const notice = stagedNotice(
        { staged: [], dropped: [], sent },
        undefined,
        undefined,
        [],
        silentTools.flows,
      );
      expect(notice).toContain('RECORDED:');
      expect(notice).toContain('put the link of the contact’s offering from the CATALOG');
      expect(notice).not.toContain('SENT:');
    });
  });

  /* -------------------------------------------------------------------------- */
  /* V9 — a silent payment flow needs a link to put in the reply                */
  /* -------------------------------------------------------------------------- */

  describe('a silent payment flow is checked at load (specs/023 V9)', () => {
    /** The fixture tenant in a temporary directory, with its files edited. */
    const loadWith = (edit: {
      tools?: (raw: Tools) => object;
      catalog?: (raw: never) => object;
    }) => {
      const dir = mkdtempSync(join(tmpdir(), 'silent-payment-'));
      for (const file of ['prompt.md', 'catalog.json', 'rules.json', 'tools.json']) {
        copyFileSync(join(FIXTURE, file), join(dir, file));
      }
      const read = (file: string) => JSON.parse(readFileSync(join(dir, file), 'utf8')) as never;
      if (edit.tools) {
        writeFileSync(join(dir, 'tools.json'), JSON.stringify(edit.tools(read('tools.json'))));
      }
      if (edit.catalog) {
        writeFileSync(
          join(dir, 'catalog.json'),
          JSON.stringify(edit.catalog(read('catalog.json'))),
        );
      }
      return () => loadTenantConfig(dir);
    };
    const silenced = (raw: Tools) => ({
      ...raw,
      flows: raw.flows.map(flow => (flow.id === PAYMENT ? { ...flow, silent: true } : flow)),
    });

    it('loads when every offering has a link', () => {
      expect(
        loadWith({ tools: silenced })().tools!.flows.find(flow => flow.id === PAYMENT)!.silent,
      ).toBe(true);
    });

    it('refuses several offerings with no field to tell them apart', () => {
      const load = loadWith({
        tools: (raw: Tools) => {
          const silent = silenced(raw);
          return {
            ...silent,
            flows: silent.flows.filter(flow => flow.offering === undefined),
            fields: silent.fields.filter(field => !field.offering),
          };
        },
      });
      expect(load).toThrow(/with several offerings a field must be marked "offering"/);
    });

    it('refuses an offering without a link', () => {
      const load = loadWith({
        tools: silenced,
        catalog: (raw: { offerings: { id: string; url: string | null }[] }) => ({
          ...raw,
          offerings: raw.offerings.map(offering =>
            offering.id === 'advanced' ? { ...offering, url: null } : offering,
          ),
        }),
      });
      expect(load).toThrow(ConfigError);
      expect(load).toThrow(/offering 'advanced' needs a url/);
    });

    it('refuses a silent flow that waits to settle, or a silent opening', () => {
      const flow = {
        id: 'tracking',
        flowNs: 'content00000000000000_000009',
        description: 'Tracks.',
      };
      expect(
        ToolsSchema.safeParse({ flows: [{ ...flow, silent: true, settleSeconds: 5 }] }).success,
      ).toBe(false);
      expect(
        ToolsSchema.safeParse({ flows: [{ ...flow, silent: true, role: 'opening' }] }).success,
      ).toBe(false);
      expect(ToolsSchema.safeParse({ flows: [{ ...flow, silent: true }] }).success).toBe(true);
    });
  });
});
