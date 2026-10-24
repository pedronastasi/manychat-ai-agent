import { beforeEach, describe, it, expect } from 'vitest';
import { ActionStage, buildTools } from '../../src/agent/tools.ts';
import type { ContactActions } from '../../src/agent/tools.ts';
import { buildSystemPrompt } from '../../src/agent/prompt.ts';
import { FUNNEL_STAGES, ToolsSchema } from '../../src/contracts/config.ts';
import type { Tools } from '../../src/contracts/config.ts';
import { loadTenantConfig } from '../../src/config/loader.ts';
import { RUNNERS } from '../helpers/runners.ts';
import type { RunnerClass } from '../helpers/runners.ts';
import { createMockModel } from '../../src/agent/mock-provider.ts';
import { asProspect } from '../helpers/intent.ts';

/**
 * Runs under the LangChain runner, the only one since the AI SDK runner was
 * removed (specs/050-langchain-runner-parity.md § Verification item 6).
 */
let Runner: RunnerClass;

/**
 * specs/045-switchable-offering.md § Verification items 1 to 4, against
 * the fictional demo tenant in test/fixtures/config with its offering field
 * marked switchable.
 */

const tenant = loadTenantConfig('test/fixtures/config');
const locked: Tools = tenant.tools!;
const switchable: Tools = ToolsSchema.parse({
  ...locked,
  fields: locked.fields.map(field => (field.offering ? { ...field, switchable: true } : field)),
});

const on = (funnelStage: string | undefined): ContactActions => ({
  sentFlows: new Set(),
  offering: 'foundation',
  funnelStage,
});

async function setCourse(tools: Tools, funnelStage: string | undefined) {
  const stage = new ActionStage();
  const built = buildTools(tools, stage, asProspect(on(funnelStage)));
  const execute = built!.set_field!.execute!;
  const result = (await execute({ field: 'course', value: 'advanced' } as never, {
    toolCallId: 'test',
    messages: [],
    context: {},
  })) as { staged: boolean };
  return { result, stage };
}

describe.each(RUNNERS)('under the $name runner (specs/050 V6)', ({ Runner: Each }) => {
  beforeEach(() => {
    Runner = Each;
  });

  describe('a switchable offering is accepted at every stage (specs/045 V1)', () => {
    it.each(FUNNEL_STAGES)('stages a switch at %s', async funnelStage => {
      const { result, stage } = await setCourse(switchable, funnelStage);
      expect(result).toMatchObject({ staged: true });
      expect(stage.staged).toContainEqual(
        expect.objectContaining({ tool: 'set_field', id: 'course', value: 'advanced' }),
      );
    });

    it.each(FUNNEL_STAGES.slice(FUNNEL_STAGES.indexOf('offered')))(
      'still refuses one at %s without the flag',
      async funnelStage => {
        expect((await setCourse(locked, funnelStage)).result).toEqual({ staged: false });
      },
    );
  });

  describe('the prompt does not escalate a switch (specs/045 V2)', () => {
    const prompt = (tools: Tools) =>
      buildSystemPrompt(tenant.persona, tenant.catalog, tenant.rules, tools).staticPrefix;

    it('says a switch is not a reason to escalate, with no lock', () => {
      const text = prompt(switchable);
      expect(text).toMatch(/may change at any stage/);
      expect(text).toMatch(/not a reason to escalate/);
      expect(text).not.toMatch(/From offered on it is locked/);
    });

    it('keeps the lock of specs/028 without the flag', () => {
      expect(prompt(locked)).toMatch(/From offered on it is locked/);
    });
  });

  describe('only the offering field may be switchable (specs/045 V3)', () => {
    it('refuses the flag on another field', () => {
      const parsed = ToolsSchema.safeParse({
        ...locked,
        fields: locked.fields.map(field =>
          field.offering ? field : { ...field, switchable: true },
        ),
      });
      expect(parsed.success).toBe(false);
    });
  });

  describe('the mock switches past the offer only when unlocked (specs/045 V4)', () => {
    const ask = async (tools: Tools) => {
      const runner = new Runner({
        model: createMockModel('demo'),
        modelSpec: 'mock:demo',
        config: () => ({ ...tenant, tools }),
        maxOutputTokens: 400,
        temperature: 0,
      });
      const stage = new ActionStage();
      const { reply } = await runner.run({
        text: "actually I'd rather do the advanced course instead",
        history: [],
        contact: asProspect(on('offered')),
        stage,
      });
      return { reply, staged: stage.staged };
    };

    it('records the switch and does not escalate when switchable', async () => {
      const result = await ask(switchable);
      expect(result.reply.escalate).toBe(false);
      expect(result.staged).toContainEqual(
        expect.objectContaining({ tool: 'set_field', id: 'course', value: 'advanced' }),
      );
    });

    it('escalates as explicit_request when locked', async () => {
      const result = await ask(locked);
      expect(result.reply.escalate).toBe(true);
      expect(result.reply.escalation_reason).toBe('explicit_request');
    });
  });
});
