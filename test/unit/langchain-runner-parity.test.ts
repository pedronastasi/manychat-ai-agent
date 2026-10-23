import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4CallOptions, LanguageModelV4Content } from '@ai-sdk/provider';
import { GraphRecursionError } from '@langchain/langgraph';
import {
  CHAT_MODEL_MAX_RETRIES,
  resolveChatModel,
  UnknownProviderError,
} from '../../src/agent/registry.ts';
import type { ChatModelSettings } from '../../src/agent/registry.ts';
import { LangGraphRunner, RECURSION_LIMIT } from '../../src/agent/langgraph-runner.ts';
import type { LangGraphRunnerOptions } from '../../src/agent/langgraph-runner.ts';
import { ActionStage, MAX_ACTIONS_PER_TURN, MAX_STEPS } from '../../src/agent/tools.ts';
import { loadTenantConfig } from '../../src/config/loader.ts';
import { EnvSchema, LANGCHAIN_OUTPUTS } from '../../src/contracts/config/env.ts';
import { createRunner } from '../../src/agent/select-runner.ts';
import { GenerateTextRunner } from '../../src/agent/runner.ts';
import { RUNNERS } from '../helpers/runners.ts';
import { asProspect } from '../helpers/intent.ts';

/**
 * specs/050-langchain-runner-parity.md § Verification items 1, 2, 3, 5, 6 and
 * 7. Providers are faked at their HTTP boundary (`fetch`) and the model at the
 * AI SDK's provider boundary (specs/004). Every reply and value is invented (C1).
 */

const tenant = loadTenantConfig('test/fixtures/config');

const REPLY = {
  messages: ['The Foundation Course runs on weekday evenings.'],
  escalate: false,
  escalation_reason: null,
  confidence: 0.9,
  closing_question: 'Would weekday evenings suit you?',
};

const SETTINGS: ChatModelSettings = { maxOutputTokens: 400, temperature: 0.3 };

const options = (model: LangGraphRunnerOptions['model']): LangGraphRunnerOptions => ({
  model,
  modelSpec: 'mock:demo',
  config: () => tenant,
  maxOutputTokens: 400,
  temperature: 0.3,
});

/** The three hosted providers, each with the key its wrapper reads and a reply in its wire shape. */
const PROVIDERS = [
  {
    spec: 'anthropic:claude-haiku-4-5',
    body: (text: string) => ({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0 },
    }),
  },
  {
    spec: 'openai:gpt-4.1-mini',
    body: (text: string) => ({
      id: 'resp_1',
      object: 'response',
      created_at: 0,
      status: 'completed',
      model: 'gpt-4.1-mini',
      output: [
        {
          type: 'message',
          id: 'msg_1',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text, annotations: [] }],
        },
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    }),
  },
  {
    spec: 'google:gemini-3.5-flash-lite',
    body: (text: string) => ({
      candidates: [
        { content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 },
      ],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 },
    }),
  },
];

/** Each request the faked provider received: its URL, parsed body and signal. */
interface Seen {
  url: string;
  body: Record<string, unknown>;
  signal: AbortSignal | undefined;
}

function fakeFetch(answer: (seen: Seen) => Promise<Response> | Response) {
  const seen: Seen[] = [];
  const fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const request = {
      url,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      signal: init?.signal ?? undefined,
    };
    seen.push(request);
    return Promise.resolve(answer(request));
  });
  vi.stubGlobal('fetch', fetch);
  return seen;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** Never answers; rejects when the request's own signal aborts, as a real fetch does. */
const hangs = (seen: Seen) =>
  new Promise<Response>((_resolve, reject) => {
    seen.signal?.addEventListener('abort', () =>
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    );
  });

beforeEach(() => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
  vi.stubEnv('OPENAI_API_KEY', 'test-key');
  vi.stubEnv('GOOGLE_API_KEY', 'test-key');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('defaults that change behaviour are set (specs/050 V1)', () => {
  it.each(PROVIDERS)('$spec retries twice, as the AI SDK does, not six times', ({ spec }) => {
    const { model } = resolveChatModel(spec, SETTINGS);
    expect(CHAT_MODEL_MAX_RETRIES).toBe(2);
    expect((model as unknown as { caller: { maxRetries: number } }).caller.maxRetries).toBe(2);
  });

  it('builds each provider by its class, and refuses an unknown one at startup', () => {
    expect(resolveChatModel('anthropic:claude-haiku-4-5', SETTINGS).model._llmType()).toBe(
      'anthropic',
    );
    expect(resolveChatModel('openai:gpt-4.1-mini', SETTINGS).model._llmType()).toBe('openai');
    expect(resolveChatModel('google:gemini-3.5-flash-lite', SETTINGS).model._llmType()).toBe(
      'googlegenerativeai',
    );
    expect(() => resolveChatModel('cohere:command', SETTINGS)).toThrow(UnknownProviderError);
    expect(() => resolveChatModel('gemini-3.5-flash-lite', SETTINGS)).toThrow(UnknownProviderError);
  });

  it('sends max tokens, the reply schema and the cache breakpoint the Anthropic way', async () => {
    const seen = fakeFetch(() => json(PROVIDERS[0]!.body(JSON.stringify(REPLY))));
    const runner = new LangGraphRunner({
      ...options(resolveChatModel('anthropic:claude-haiku-4-5', SETTINGS)),
      modelSpec: 'anthropic:claude-haiku-4-5',
    });
    const result = await runner.run({
      text: 'When does it run?',
      history: [],
      builtInTools: false,
    });

    expect(result.reply.messages).toContain(REPLY.messages[0]);
    const [request] = seen;
    expect(request?.url).toMatch(/\/v1\/messages$/);
    expect(request?.body.max_tokens).toBe(400);
    expect(request?.body.temperature).toBe(0.3);
    const system = request?.body.system as { cache_control?: unknown }[];
    expect(system.at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
    expect(request?.body.output_config).toMatchObject({ format: { type: 'json_schema' } });
  });

  it('sends max tokens and a strict reply schema through the Responses API on OpenAI', async () => {
    const seen = fakeFetch(() => json(PROVIDERS[1]!.body(JSON.stringify(REPLY))));
    const runner = new LangGraphRunner({
      ...options(resolveChatModel('openai:gpt-4.1-mini', SETTINGS)),
      modelSpec: 'openai:gpt-4.1-mini',
    });
    const result = await runner.run({
      text: 'When does it run?',
      history: [],
      builtInTools: false,
    });

    expect(result.reply.messages).toContain(REPLY.messages[0]);
    const [request] = seen;
    expect(request?.url).toMatch(/\/responses$/);
    expect(request?.body.max_output_tokens).toBe(400);
    expect(request?.body.text).toMatchObject({ format: { type: 'json_schema', strict: true } });
  });

  it('sends max tokens and the reply schema on Gemini', async () => {
    const seen = fakeFetch(() => json(PROVIDERS[2]!.body(JSON.stringify(REPLY))));
    const runner = new LangGraphRunner({
      ...options(resolveChatModel('google:gemini-3.5-flash-lite', SETTINGS)),
      modelSpec: 'google:gemini-3.5-flash-lite',
    });
    const result = await runner.run({
      text: 'When does it run?',
      history: [],
      builtInTools: false,
    });

    expect(result.reply.messages).toContain(REPLY.messages[0]);
    const config = seen[0]?.body.generationConfig as Record<string, unknown>;
    expect(config.maxOutputTokens).toBe(400);
    expect(config.responseSchema).toBeDefined();
  });

  it('sends no temperature to a reasoning model', () => {
    const { model } = resolveChatModel('openai:gpt-5', SETTINGS);
    expect((model as unknown as { temperature?: number }).temperature).toBeUndefined();
  });

  it('limits the graph to the supersteps four model steps take', () => {
    expect(MAX_STEPS).toBe(4);
    expect(RECURSION_LIMIT).toBe(8);
  });
});

describe('a rate limit cannot hold the turn past the abort (specs/050 V2)', () => {
  it('settles within 100 ms of the abort while LangChain waits out Retry-After: 30', async () => {
    fakeFetch(() =>
      json({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 429, {
        'retry-after': '30',
      }),
    );
    const runner = new LangGraphRunner({
      ...options(resolveChatModel('anthropic:claude-haiku-4-5', SETTINGS)),
      modelSpec: 'anthropic:claude-haiku-4-5',
    });
    const controller = new AbortController();
    const turn = runner.run({
      text: 'When does it run?',
      history: [],
      builtInTools: false,
      signal: controller.signal,
    });
    const settled = turn.then(
      () => Date.now(),
      () => Date.now(),
    );
    await new Promise(resolve => setTimeout(resolve, 50));
    const abortedAt = Date.now();
    controller.abort();

    expect((await settled) - abortedAt).toBeLessThan(100);
    await expect(turn).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('an aborted turn cancels the provider request (specs/050 V3)', () => {
  it.each(PROVIDERS)('aborts $spec request in flight', async ({ spec }) => {
    const seen = fakeFetch(hangs);
    const runner = new LangGraphRunner({
      ...options(resolveChatModel(spec, SETTINGS)),
      modelSpec: spec,
    });
    const controller = new AbortController();
    const turn = runner.run({
      text: 'When does it run?',
      history: [],
      builtInTools: false,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    controller.abort();

    await expect(turn).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen[0]?.signal?.aborted).toBe(true);
  });
});

describe('boot refuses what sends prompts out of the process (specs/050 V5)', () => {
  const base = {
    AGENT_MODEL: 'anthropic:claude-haiku-4-5',
    PUBLIC_BASE_URL: 'https://agent.example.com',
    MANYCHAT_SHARED_SECRET: 'a'.repeat(32),
    DATABASE_URL: 'pglite',
  };

  it.each(LANGCHAIN_OUTPUTS)('refuses %s="true"', name => {
    const parsed = EnvSchema.safeParse({ ...base, [name]: 'true' });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map(issue => issue.path.join('.'))).toContain(name);
  });

  it('boots with them unset or false, and defaults to the AI SDK runner', () => {
    const parsed = EnvSchema.safeParse({ ...base, LANGSMITH_TRACING: 'false' });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.AGENT_RUNNER).toBe('ai-sdk');
  });

  it('builds the runner AGENT_RUNNER names', () => {
    const shared = {
      modelSpec: 'mock:demo',
      config: () => tenant,
      maxOutputTokens: 400,
      temperature: 0.3,
    };
    expect(createRunner('langchain', shared)).toBeInstanceOf(LangGraphRunner);
    expect(createRunner('ai-sdk', shared)).toBeInstanceOf(GenerateTextRunner);
  });

  it('accepts the two runners and refuses anything else', () => {
    expect(EnvSchema.safeParse({ ...base, AGENT_RUNNER: 'langchain' }).success).toBe(true);
    expect(EnvSchema.safeParse({ ...base, AGENT_RUNNER: 'langgraph' }).success).toBe(false);
  });
});

const toolCall = (toolName: string, input: object, id: string): LanguageModelV4Content => ({
  type: 'tool-call',
  toolCallId: `call-${id}`,
  toolName,
  input: JSON.stringify(input),
});

/** A model at the provider boundary answering each step from `script`, honouring the abort. */
function scriptedModel(
  script: (step: number) => LanguageModelV4Content[],
  opts: { hangFrom?: number; usage?: boolean } = {},
) {
  const calls: LanguageModelV4CallOptions[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (call: LanguageModelV4CallOptions) => {
      const step = calls.length;
      calls.push(call);
      if (opts.hangFrom !== undefined && step >= opts.hangFrom) {
        await new Promise((_resolve, reject) => {
          call.abortSignal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        });
      }
      const content = script(step);
      return {
        content,
        finishReason: content.some(part => part.type === 'tool-call')
          ? { unified: 'tool-calls' as const, raw: 'tool_use' }
          : { unified: 'stop' as const, raw: 'end_turn' },
        usage:
          opts.usage === false
            ? {
                inputTokens: {
                  total: undefined,
                  noCache: undefined,
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: { total: undefined, text: undefined, reasoning: undefined },
              }
            : {
                inputTokens: { total: 100 + step, noCache: 90, cacheRead: 10, cacheWrite: 0 },
                outputTokens: { total: 20, text: 20, reasoning: 0 },
              },
        warnings: [],
      };
    },
  });
  return { model, calls };
}

const answer: LanguageModelV4Content = { type: 'text', text: JSON.stringify(REPLY) };

/** Nine distinct writes in one step: one past the cap. */
const NINE_WRITES = [
  toolCall('set_field', { field: 'prior_experience', value: 'none' }, '1'),
  toolCall('set_field', { field: 'preferred_schedule', value: 'weekends' }, '2'),
  toolCall('add_tag', { tag: 'interested_foundation' }, '3'),
  toolCall('send_flow', { flow: 'student_results' }, '4'),
  toolCall('set_field', { field: 'prior_experience', value: 'some' }, '5'),
  toolCall('remove_tag', { tag: 'interested_foundation' }, '6'),
  toolCall('send_flow', { flow: 'fitting_it_in' }, '7'),
  toolCall('set_field', { field: 'preferred_schedule', value: 'weekday_evenings' }, '8'),
  toolCall('set_field', { field: 'course', value: 'foundation' }, '9'),
];

describe.each(RUNNERS)('the loop under the $name runner (specs/050 V6)', ({ Runner }) => {
  const runnerFor = (model: MockLanguageModelV4) => new Runner({ ...options(model), model });

  it('stages one step’s calls in the order the model made them, and drops the one past the cap', async () => {
    const { model } = scriptedModel(step => (step === 0 ? NINE_WRITES : [answer]));
    const stage = new ActionStage();
    await runnerFor(model).run({ text: 'hi', history: [], stage, contact: asProspect() });

    expect(MAX_ACTIONS_PER_TURN).toBe(8);
    expect(stage.staged).toHaveLength(8);
    expect(stage.dropped).toHaveLength(1);
    expect(stage.dropped[0]).toMatchObject({ tool: 'set_field' });
    expect(stage.staged.map(action => action.tool)).toEqual([
      'set_field',
      'set_field',
      'add_tag',
      'send_flow',
      'set_field',
      'remove_tag',
      'send_flow',
      'set_field',
    ]);
  });

  it('offers no tools on the last step, which sees the staged note', async () => {
    const { model, calls } = scriptedModel(step =>
      step < MAX_STEPS - 1
        ? [toolCall('add_tag', { tag: 'interested_foundation' }, `${step}`)]
        : [answer],
    );
    const result = await runnerFor(model).run({
      text: 'hi',
      history: [],
      contact: asProspect(),
    });

    expect(result.reply.messages).toContain(REPLY.messages[0]);
    expect(calls).toHaveLength(MAX_STEPS);
    expect(calls.slice(0, -1).every(call => (call.tools ?? []).length > 0)).toBe(true);
    expect(calls.at(-1)?.tools).toBeUndefined();
    const last = calls.at(-1)?.prompt.at(-1);
    expect(JSON.stringify(last)).toContain('ACTIONS:');
  });

  it('keeps what was staged when the turn is aborted, for the caller to record as discarded', async () => {
    const { model } = scriptedModel(
      step =>
        step === 0 ? [toolCall('add_tag', { tag: 'interested_foundation' }, '1')] : [answer],
      { hangFrom: 1 },
    );
    const stage = new ActionStage();
    const controller = new AbortController();
    const turn = runnerFor(model).run({
      text: 'hi',
      history: [],
      stage,
      contact: asProspect(),
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(stage.staged).toHaveLength(1));
    controller.abort();

    await expect(turn).rejects.toMatchObject({ name: 'AbortError' });
    expect(stage.records('discarded')).toEqual([expect.objectContaining({ status: 'discarded' })]);
  });

  it('sums usage over every step', async () => {
    const { model } = scriptedModel(step =>
      step === 0 ? [toolCall('add_tag', { tag: 'interested_foundation' }, '1')] : [answer],
    );
    const result = await runnerFor(model).run({ text: 'hi', history: [], contact: asProspect() });

    expect(result.usage).toMatchObject({ inputTokens: 201, outputTokens: 40, cacheReadTokens: 20 });
  });
});

describe('the graph fails closed (specs/050 V6)', () => {
  it('turns GraphRecursionError into the handoff, never a raised limit', async () => {
    class Tight extends LangGraphRunner {
      protected override recursionLimit = 2;
    }
    const { model } = scriptedModel(step =>
      step === 0 ? [toolCall('add_tag', { tag: 'interested_foundation' }, '1')] : [answer],
    );
    const result = await new Tight(options(model)).run({
      text: 'hi',
      history: [],
      contact: asProspect(),
    });

    expect(new GraphRecursionError('x').name).toBe('GraphRecursionError');
    expect(result.modelError).toBe('GraphRecursionError');
    expect(result.reply.escalate).toBe(true);
    expect(result.reply.escalation_reason).toBe('low_confidence');
    expect(result.escalatedBy).toBe('error');
  });

  it('names a reply that does not match the schema as the AI SDK runner does', async () => {
    const { model } = scriptedModel(() => [{ type: 'text', text: '{"messages":[]}' }]);
    const result = await new LangGraphRunner(options(model)).run({
      text: 'hi',
      history: [],
      builtInTools: false,
    });

    expect(result.modelError).toBe('NoObjectGeneratedError');
    expect(result.reply.escalate).toBe(true);
  });
});

describe('usage comes out the same (specs/050 V7)', () => {
  it('gives the same AgentUsage under both runners for the same faked turn', async () => {
    const usages = [];
    for (const { Runner } of RUNNERS) {
      const { model } = scriptedModel(step =>
        step === 0 ? [toolCall('add_tag', { tag: 'interested_foundation' }, '1')] : [answer],
      );
      const result = await new Runner(options(model) as never).run({
        text: 'hi',
        history: [],
        contact: asProspect(),
      });
      usages.push(result.usage);
    }
    expect(usages[1]).toEqual(usages[0]);
  });

  it('leaves a count unknown, never zero, when a step reports none', async () => {
    const { model } = scriptedModel(() => [answer], { usage: false });
    const result = await new LangGraphRunner(options(model)).run({
      text: 'hi',
      history: [],
      builtInTools: false,
    });

    expect(result.usage.inputTokens).toBeUndefined();
    expect(result.usage.outputTokens).toBeUndefined();
  });
});
