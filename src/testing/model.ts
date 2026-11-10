import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type {
  BaseChatModelCallOptions,
  BindToolsInput,
} from '@langchain/core/language_models/chat_models';
import { AIMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseMessage, UsageMetadata } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { modelRequestOf, textOf } from '../agent/model-request.ts';
import type { ModelRequest, ModelTool } from '../agent/model-request.ts';
import { transcriptionCostUsd } from '../agent/registry.ts';
import type { ChatModelHandle } from '../agent/registry.ts';
import { MediaFailure } from '../media/port.ts';
import type { Transcriber, Transcript } from '../media/port.ts';

/**
 * Fakes at the model boundary (specs/004): LangChain.js chat models that
 * record each call and answer as the test says (specs/053 § The mock and every
 * fake are LangChain chat models). A fake honours its contract: it reports
 * `usage_metadata`, returns tool calls as `tool_calls`, and its answer can wait
 * on the call's signal, so a C7 test sees the abort production sees.
 */

/** One call a fake received: what the provider would have been sent, and the turn's signal. */
export interface ModelCall extends ModelRequest {
  /** The call's LangChain.js messages, as the runner sent them. */
  messages: BaseMessage[];
  abortSignal: AbortSignal | undefined;
  /** How the reply was asked for as JSON (`replyFormat`), when it was. */
  responseFormat?: unknown;
}

/** Part of a fake's answer: text, or a tool call whose input is JSON text or an object. */
export type FakeContent =
  | { type: 'text'; text: string }
  | {
      type: 'tool-call';
      toolCallId: string;
      toolName: string;
      input: string | Record<string, unknown>;
    };

/**
 * A fake's token counts, nested as a provider reports them. Each count is
 * read on its own: one left out stays out, so a partial report can be tested.
 */
export interface FakeUsage {
  inputTokens?: { total?: number | undefined; cacheRead?: number | undefined } & Record<
    string,
    unknown
  >;
  outputTokens?: { total?: number | undefined } & Record<string, unknown>;
}

/** What a fake answers one call with. Other fields a test writes are ignored. */
export interface FakeAnswer {
  content: FakeContent[];
  usage?: FakeUsage | undefined;
  [field: string]: unknown;
}

function usageOf(usage: FakeUsage | undefined): UsageMetadata | undefined {
  const input = usage?.inputTokens?.total;
  const output = usage?.outputTokens?.total;
  const cacheRead = usage?.inputTokens?.cacheRead;
  if (input === undefined && output === undefined && cacheRead === undefined) return undefined;
  // A partial count: LangChain's type wants both totals, but readers take
  // each field as optional (specs/050 § Usage, cost and caching come out the same).
  return {
    ...(input !== undefined ? { input_tokens: input } : {}),
    ...(output !== undefined ? { output_tokens: output } : {}),
    ...(input !== undefined && output !== undefined ? { total_tokens: input + output } : {}),
    ...(cacheRead !== undefined ? { input_token_details: { cache_read: cacheRead } } : {}),
  } as UsageMetadata;
}

function messageOf(answer: FakeAnswer): AIMessage {
  const text = answer.content.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('');
  const toolCalls = answer.content.flatMap(part =>
    part.type === 'tool-call'
      ? [
          {
            id: part.toolCallId,
            name: part.toolName,
            args:
              typeof part.input === 'string'
                ? (JSON.parse(part.input) as Record<string, unknown>)
                : part.input,
            type: 'tool_call' as const,
          },
        ]
      : [],
  );
  const message = new AIMessage({ content: text, tool_calls: toolCalls });
  const usage = usageOf(answer.usage);
  // The default message structure types usage as absent, though every
  // provider wrapper sets it and LangChain reads it.
  if (usage) Object.assign(message, { usage_metadata: usage });
  return message;
}

interface FakeCallOptions extends BaseChatModelCallOptions {
  tools?: ReturnType<typeof convertToOpenAITool>[] | undefined;
  responseFormat?: unknown;
}

class FakeChatModel extends BaseChatModel<FakeCallOptions> {
  private readonly answer: (call: ModelCall) => FakeAnswer | Promise<FakeAnswer>;

  constructor(answer: (call: ModelCall) => FakeAnswer | Promise<FakeAnswer>) {
    super({});
    this.answer = answer;
  }

  _llmType(): string {
    return 'fake';
  }

  override bindTools(tools: BindToolsInput[], kwargs?: Partial<FakeCallOptions>) {
    return this.withConfig({ ...kwargs, tools: tools.map(tool => convertToOpenAITool(tool)) });
  }

  async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
  ): Promise<ChatResult> {
    const tools: ModelTool[] | undefined = options.tools?.map(tool => ({
      type: 'function' as const,
      name: tool.function.name,
      description: tool.function.description,
      inputSchema: tool.function.parameters as ModelTool['inputSchema'],
    }));
    const call: ModelCall = {
      ...modelRequestOf(messages, tools && tools.length > 0 ? tools : undefined),
      messages,
      abortSignal: options.signal,
      ...(options.responseFormat !== undefined ? { responseFormat: options.responseFormat } : {}),
    };
    const message = messageOf(await this.answer(call));
    return { generations: [{ text: textOf(message.content), message }] };
  }
}

/**
 * A chat model answering each call with what `answer` returns, in the handle
 * the runner, the judges and the analyst take.
 */
export function fakeChatModel(
  answer: (call: ModelCall) => FakeAnswer | Promise<FakeAnswer>,
): ChatModelHandle {
  return {
    model: new FakeChatModel(answer),
    replyFormat: schema => ({ responseFormat: { type: 'json', schema } }),
    systemMessage: text => new SystemMessage(text),
  };
}

/** Rejects when `signal` aborts, as a provider call does. */
export function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' });
}

/**
 * A fake answering every call with `object` as its JSON reply, and the calls
 * it received. Token counts are reported as a provider reports them: a budget
 * cap that read none would never stop anything.
 */
export function mockModel(
  object: unknown,
  opts: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } = {},
) {
  const calls: ModelCall[] = [];
  const model = fakeChatModel(call => {
    calls.push(call);
    return {
      content: [{ type: 'text', text: JSON.stringify(object) }],
      usage: {
        inputTokens: { total: opts.inputTokens ?? 1000, cacheRead: opts.cacheReadTokens ?? 0 },
        outputTokens: { total: opts.outputTokens ?? 50 },
      },
    };
  });
  return { model, calls };
}

/** A model that never answers until aborted: for testing the race deadline. */
export function hangingModel(): ChatModelHandle {
  return fakeChatModel(
    call =>
      new Promise<FakeAnswer>((_resolve, reject) => {
        if (call.abortSignal?.aborted) reject(abortError());
        call.abortSignal?.addEventListener('abort', () => reject(abortError()));
      }),
  );
}

/** Opus at 8 kbit/s, the pessimistic size-based estimate the transcriber bills without a duration. */
const PESSIMISTIC_BYTES_PER_SECOND = 1000;

/**
 * A transcriber at the provider boundary (specs/020): it returns what the test
 * gives it, so it proves where a transcript goes, never that it is right. It
 * bills as the service's transcriber does, honours the abort, and fails as a
 * `MediaFailure`, which is what the service's transcriber throws.
 */
export function mockTranscriptionModel(
  opts: {
    text?: string;
    durationInSeconds?: number;
    delayMs?: number;
    error?: Error;
    modelSpec?: string;
  } = {},
) {
  const calls: { audio: Uint8Array; signal: AbortSignal }[] = [];
  const modelSpec = opts.modelSpec ?? 'openai:gpt-4o-mini-transcribe';
  const model: Transcriber = {
    async transcribe(audio: Uint8Array, signal: AbortSignal): Promise<Transcript> {
      calls.push({ audio, signal });
      try {
        if (opts.delayMs) {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, opts.delayMs);
            signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(abortError());
            });
          });
        }
        if (opts.error) throw opts.error;
      } catch (error) {
        throw new MediaFailure('transcription', error instanceof Error ? error.name : 'unknown', {
          cause: error,
        });
      }
      const text = opts.text ?? '';
      // An empty transcript is billed from the size (specs/053 § Transcription).
      const seconds =
        text === '' || opts.durationInSeconds === undefined
          ? audio.byteLength / PESSIMISTIC_BYTES_PER_SECOND
          : opts.durationInSeconds;
      return {
        text: text.trim(),
        model: modelSpec,
        costUsd: transcriptionCostUsd(modelSpec, seconds),
      };
    },
  };
  return { model, calls };
}
