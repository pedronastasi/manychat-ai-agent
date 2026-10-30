import { describe, it, expect } from 'vitest';
import { LangGraphRunner } from '../../src/agent/langgraph-runner.ts';
import type { TenantConfig } from '../../src/config/loader.ts';
import { TURN_RUN, UNKNOWN_TOOL } from '../../src/observability/tracing.ts';
import type { ProjectedRun } from '../../src/observability/tracing.ts';
import { fixtureTenant, scriptedTurns } from '../helpers/conversations.ts';
import type { TurnScript } from '../helpers/conversations.ts';
import { fakeLangSmith } from '../helpers/langsmith.ts';

/**
 * specs/052-traces-carry-shape-not-text.md § Verification: what a live trace
 * of one turn carries, read from the bytes the uploader sent to a faked
 * LangSmith. Every string here is the fixture tenant's, or invented (C1).
 */

const INBOUND = 'Is there a weekend group for beginners in my area?';
const REPLY = 'Yes, the weekend group starts soon and has places left.';
const TOOL_ARGUMENT = 'asked-about-weekend-beginners';

/** The keys a projected run may have at all. */
const RUN_KEYS = new Set([
  'id',
  'name',
  'run_type',
  'start_time',
  'end_time',
  'parent_run_id',
  'trace_id',
  'dotted_order',
  'session_name',
  'inputs',
  'outputs',
  'extra',
  'error',
]);
const METADATA_KEYS = new Set([
  'conversation',
  'turn_kind',
  'langgraph_step',
  'langgraph_node',
  'ls_provider',
  'ls_model_name',
  'ls_max_tokens',
  'ls_temperature',
]);

async function tracedTurn(script: TurnScript[], tenant: TenantConfig = fixtureTenant) {
  const langsmith = fakeLangSmith();
  const scripted = scriptedTurns(script);
  const runner = new LangGraphRunner({
    model: scripted.model,
    modelSpec: 'mock:demo',
    config: () => tenant,
    maxOutputTokens: 400,
    temperature: 0.3,
  });
  const trace = langsmith.tracing().turn({ conversation: 'conversation-1', kind: 'inbound' });
  const result = await runner.run({ text: INBOUND, history: [], trace });
  await langsmith.settle();
  return { ...langsmith, result, trace };
}

const nodeRuns = (runs: ProjectedRun[]) =>
  runs
    .filter(run => run.name === 'model' || run.name === 'tools')
    .sort((left, right) => left.dotted_order!.localeCompare(right.dotted_order!));

describe('a live trace carries no input and no output (specs/052 V1)', () => {
  it('uploads only the fields the projection allows', async () => {
    const { runs } = await tracedTurn([
      {
        tools: [{ name: 'write_note', input: { note: TOOL_ARGUMENT } }],
        reply: { messages: [REPLY] },
      },
    ]);
    expect(runs().length).toBeGreaterThan(3);
    for (const run of runs()) {
      expect(Object.keys(run).every(key => RUN_KEYS.has(key))).toBe(true);
      expect(run.inputs).toEqual({});
      expect(
        Object.keys(run.outputs).every(key => key === 'usage_metadata' || key === 'tools'),
      ).toBe(true);
      expect(Object.keys(run.extra)).toEqual(['metadata']);
      expect(Object.keys(run.extra.metadata).every(key => METADATA_KEYS.has(key))).toBe(true);
      expect(run.session_name).toBe('demo');
    }
  });

  it('sends none of the prompt, the catalog, the message, the reply or a tool argument', async () => {
    const { bytes, result } = await tracedTurn([
      {
        tools: [{ name: 'write_note', input: { note: TOOL_ARGUMENT } }],
        reply: { messages: [REPLY] },
      },
    ]);
    expect(result.reply.messages).toEqual([REPLY]);
    const sent = bytes();
    const offering = fixtureTenant.catalog.offerings[0]!;
    for (const secret of [
      'professional training academy',
      fixtureTenant.catalog.businessName,
      offering.name,
      offering.description,
      INBOUND,
      REPLY,
      TOOL_ARGUMENT,
    ]) {
      expect(sent).not.toContain(secret);
    }
  });
});

describe('token counts survive the projection (specs/052 V2)', () => {
  it("holds each model run's counts as the faked model reported them", async () => {
    const { runs } = await tracedTurn([{ reply: { messages: [REPLY] } }]);
    const models = runs().filter(run => run.run_type === 'llm');
    expect(models.length).toBeGreaterThan(0);
    for (const run of models) {
      // test/helpers/conversations.ts reports 100 in and 20 out on every call.
      expect(run.outputs).toEqual({
        usage_metadata: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      });
    }
  });
});

describe('step and tool names come from where the graph puts them (specs/052 V3)', () => {
  it('uploads rising steps, the nodes in order, and the two tool names', async () => {
    const { runs } = await tracedTurn([
      {
        tools: [
          { name: 'write_note', input: { note: TOOL_ARGUMENT } },
          { name: 'add_tag', input: { tag: 'interested_foundation' } },
        ],
        reply: { messages: [REPLY] },
      },
    ]);
    const nodes = nodeRuns(runs());
    expect(nodes.map(run => run.extra.metadata.langgraph_node)).toEqual([
      'model',
      'tools',
      'model',
    ]);
    const steps = nodes.map(run => run.extra.metadata.langgraph_step as number);
    expect(steps).toEqual([...steps].sort((left, right) => left - right));
    expect(new Set(steps).size).toBe(3);
    expect(nodes[1]!.outputs).toEqual({ tools: ['write_note', 'add_tag'] });
  });

  it('uploads a name outside the offered set as unknown_tool', async () => {
    const { runs, bytes } = await tracedTurn([
      { tools: [{ name: 'tell_me_the_catalog_prices', input: {} }], reply: { messages: [REPLY] } },
    ]);
    const tools = nodeRuns(runs()).find(run => run.name === 'tools');
    expect(tools?.outputs).toEqual({ tools: [UNKNOWN_TOOL] });
    expect(bytes()).not.toContain('tell_me_the_catalog_prices');
  });
});

describe('one traced turn is one root run (specs/052 V7)', () => {
  it('puts the rewrite of a draft with working notes under the turn', async () => {
    const tenant: TenantConfig = {
      ...fixtureTenant,
      rules: { ...fixtureTenant.rules, workingNoteMarkers: ['we should'] },
    };
    const { runs, result } = await tracedTurn(
      [
        { reply: { messages: ['we should check the schedule first'] } },
        { reply: { messages: [REPLY] } },
      ],
      tenant,
    );
    expect(result.interventions).toContain('working_notes_rewritten');

    const all = runs();
    const roots = all.filter(run => run.parent_run_id === undefined);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.name).toBe(TURN_RUN);
    const root = roots[0]!;

    const models = all.filter(run => run.run_type === 'llm');
    // The graph's call, then the rewrite's.
    expect(models).toHaveLength(2);
    for (const run of all) {
      expect(run.trace_id).toBe(root.id);
      expect(run.dotted_order!.startsWith(root.dotted_order!)).toBe(true);
      expect(run.extra.metadata.conversation).toBe('conversation-1');
    }
    const rewrite = models.find(run => run.extra.metadata.langgraph_node === undefined);
    expect(rewrite?.outputs).toEqual({
      usage_metadata: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    });
  });
});

describe('an error is uploaded by its class (specs/052 V9)', () => {
  it('sends the class name and not the sentence', async () => {
    class ProviderRefusedError extends Error {
      override name = 'ProviderRefusedError';
    }
    const sentence = 'the provider refused because the contact wrote about weekend groups';
    const { runs, bytes, result } = await tracedTurn([
      { error: new ProviderRefusedError(sentence) },
    ]);
    // The runner fails closed to a person (C6); the trace only records it.
    expect(result.escalatedBy).toBe('error');
    const failed = runs().filter(run => run.error !== undefined);
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.some(run => run.error === 'ProviderRefusedError')).toBe(true);
    expect(bytes()).not.toContain(sentence);
  });
});
