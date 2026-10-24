import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4CallOptions, LanguageModelV4Content } from '@ai-sdk/provider';
import { LangGraphRunner } from '../../src/agent/langgraph-runner.ts';
import { loadTenantConfig } from '../../src/config/loader.ts';
import type { TenantConfig } from '../../src/config/loader.ts';
import { Scenario } from '../../src/contracts/conversations.ts';
import type { RunOptions } from '../../src/evals/conversations/run.ts';
import { createTestDatabase } from './db.ts';
import { ConversationJudge } from '../../src/evals/conversations/judge.ts';

/**
 * A conversation run's fakes: a model at the provider boundary scripted turn
 * by turn, and the run options the CLI would build, against the fixture
 * tenant (specs/004, specs/043). Every reply here is invented (C1).
 */

export const fixtureTenant = loadTenantConfig('test/fixtures/config');

export interface TurnScript {
  /** Tool calls the model makes on the turn's first call, in order. */
  tools?: { name: string; input: object }[];
  /** The reply, or an error the provider throws instead. */
  reply?: Partial<{
    messages: string[];
    escalate: boolean;
    escalation_reason: string | null;
    confidence: number;
    closing_question: string | null;
  }>;
  error?: Error;
  /** How long the turn's first call takes, honouring the abort signal. */
  delayMs?: number;
}

const USAGE = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};

/**
 * A model that plays `turns` in order: a call without a tool result starts
 * the next turn; one with a tool result writes that turn's reply.
 */
export function scriptedTurns(turns: TurnScript[]) {
  const calls: LanguageModelV4CallOptions[] = [];
  /** The prompt of each turn's first call, by turn. */
  const firsts: LanguageModelV4CallOptions[] = [];
  let turn = -1;
  const model = new MockLanguageModelV4({
    doGenerate: async (options: LanguageModelV4CallOptions) => {
      calls.push(options);
      const afterTools = options.prompt.some(entry => entry.role === 'tool');
      if (!afterTools) {
        turn++;
        firsts.push(options);
      }
      const script = turns[turn] ?? turns.at(-1) ?? {};
      if (!afterTools && script.delayMs) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, script.delayMs);
          options.abortSignal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        });
      }
      if (script.error) throw script.error;
      let content: LanguageModelV4Content[];
      if (!afterTools && script.tools?.length) {
        content = script.tools.map((call, index) => ({
          type: 'tool-call' as const,
          toolCallId: `call-${turn}-${index}`,
          toolName: call.name,
          input: JSON.stringify(call.input),
        }));
      } else {
        content = [
          {
            type: 'text' as const,
            text: JSON.stringify({
              messages: ['Happy to help.'],
              escalate: false,
              escalation_reason: null,
              confidence: 0.9,
              closing_question: null,
              ...script.reply,
            }),
          },
        ];
      }
      const called = content.some(part => part.type === 'tool-call');
      return {
        content,
        finishReason: called
          ? { unified: 'tool-calls' as const, raw: 'tool_use' }
          : { unified: 'stop' as const, raw: 'end_turn' },
        usage: USAGE,
        warnings: [],
      };
    },
  });
  return { model, calls, firsts };
}

/** Every text the model was shown on a call, joined, for asserting what it saw. */
export function promptText(options: LanguageModelV4CallOptions | undefined): string {
  return JSON.stringify(options?.prompt ?? []);
}

/**
 * Run options for `script`, one fresh scripted model per repetition, on a
 * restored test database rather than a booted one.
 */
export function runOptions(
  script: (repetition: number) => TurnScript[],
  over: Partial<RunOptions> & { tenant?: TenantConfig } = {},
) {
  const tenant = over.tenant ?? fixtureTenant;
  const models: ReturnType<typeof scriptedTurns>[] = [];
  const opts: RunOptions = {
    runner: () => {
      const scripted = scriptedTurns(script(models.length + 1));
      models.push(scripted);
      return new LangGraphRunner({
        model: scripted.model,
        modelSpec: 'mock:demo',
        config: () => tenant,
        maxOutputTokens: 400,
        temperature: 0.3,
      });
    },
    rules: tenant.rules,
    tools: tenant.tools,
    catalog: tenant.catalog,
    raceDeadlineMs: 8000,
    modelAbortMs: 30_000,
    tokensEnforced: true,
    defaultChannel: 'whatsapp',
    latencyBudgetMs: 8000,
    database: () => createTestDatabase(),
    ...over,
  };
  return { opts, models };
}

/** A scenario from its fields, parsed as a suite line would be. */
export const scenario = (fields: Record<string, unknown>): Scenario =>
  Scenario.parse({ id: 'scenario', description: 'An invented conversation.', ...fields });

/** A message step. */
export const say = (id: string, text: string, expect: object = {}) => ({
  id,
  input: { kind: 'message', text },
  expect,
});

/**
 * A conversation judge answering `outputs` in turn, or throwing for an Error:
 * the judge model faked at the provider boundary (specs/004).
 */
export function scriptedJudge(outputs: (object | Error)[]) {
  let call = 0;
  const model = new MockLanguageModelV4({
    doGenerate: () => {
      const output = outputs[Math.min(call++, outputs.length - 1)];
      if (output instanceof Error) return Promise.reject(output);
      return Promise.resolve({
        content: [{ type: 'text' as const, text: JSON.stringify(output) }],
        finishReason: { unified: 'stop' as const, raw: 'end_turn' },
        usage: USAGE,
        warnings: [],
      });
    },
  });
  return new ConversationJudge({ model, modelSpec: 'mock:judge', timeoutMs: 1000 });
}
