import { asSchema } from 'ai';
import type { LanguageModel, ModelMessage, ToolSet } from 'ai';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage, MessageContent, UsageMetadata } from '@langchain/core/messages';
import { AgentReplyForModel } from '../contracts/agent.ts';
import { chatModelFromAiSdk } from './registry.ts';
import type { ChatModelHandle } from './registry.ts';
import { PromptedRunner } from './runner.ts';
import type { AgentUsage, Generated, PreparedTurn, RunnerOptions } from './runner.ts';
import { MAX_STEPS } from './tools.ts';

/**
 * The LangChain.js runner (ADR-0026, ADR-0027): the same prompt, tools and
 * guardrails as `GenerateTextRunner`, with the loop drawn as a LangGraph.js
 * graph of three nodes the service owns, never a prebuilt agent
 * (specs/050 § The graph has three nodes and a step counter).
 */

export type LangGraphRunnerOptions = Omit<RunnerOptions, 'model'> & {
  /** A chat model from `resolveChatModel`, or an AI SDK model (`mock:`, a test fake) to wrap. */
  model: ChatModelHandle | LanguageModel;
};

/**
 * Supersteps a turn can take: a model and a tools step for each step that may
 * call tools, then the reply, plus the one LangGraph counts for writing the
 * input. LangGraph counts supersteps, not model steps, and its own default is
 * 25 (specs/050 § Defaults that change behaviour). A full turn needs exactly
 * this many, so one more model step fails the turn closed.
 */
export const RECURSION_LIMIT = 2 * (MAX_STEPS - 1) + 2;

/**
 * The reply did not match the schema, or never came. Named as the AI SDK names
 * the same failure, so a turn records the same `modelError` under either runner.
 */
export class ReplyNotGeneratedError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = 'NoObjectGeneratedError';
  }
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error && reason.name === 'AbortError') return reason;
  return Object.assign(new Error('aborted'), { name: 'AbortError' });
}

/**
 * Settles when the signal fires, whatever the graph is waiting on. A provider
 * wrapper can wait out a rate limit's `Retry-After` without listening to the
 * signal (specs/050 § Defaults that change behaviour).
 */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(abortError(signal));
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => reject(abortError(signal));
    signal.addEventListener('abort', listener, { once: true });
  });
  return Promise.race([work, aborted]).finally(() => {
    if (listener) signal.removeEventListener('abort', listener);
  });
}

function base64(data: unknown): string {
  if (data instanceof Uint8Array) return Buffer.from(data).toString('base64');
  if (typeof data === 'string') return data;
  throw new Error('only inline images reach the model (specs/020)');
}

/** A turn's AI SDK messages as LangChain messages, part for part. */
export function toLangChainMessages(messages: ModelMessage[]): BaseMessage[] {
  return messages.map(message => {
    if (message.role === 'user') {
      if (typeof message.content === 'string') return new HumanMessage(message.content);
      return new HumanMessage({
        content: message.content.map(part => {
          if (part.type === 'text') return { type: 'text', text: part.text };
          if (part.type === 'file') {
            return {
              type: 'image_url',
              image_url: { url: `data:${part.mediaType};base64,${base64(part.data)}` },
            };
          }
          throw new Error(`unsupported user part: ${part.type}`);
        }),
      });
    }
    if (message.role === 'assistant') {
      if (typeof message.content === 'string') return new AIMessage(message.content);
      return new AIMessage({
        content: message.content.map(part => {
          if (part.type === 'text') return { type: 'text', text: part.text };
          throw new Error(`unsupported assistant part: ${part.type}`);
        }),
      });
    }
    throw new Error(`unsupported message role: ${message.role}`);
  });
}

function textOf(content: MessageContent): string {
  if (typeof content === 'string') return content;
  return content.flatMap(block => (block.type === 'text' ? [String(block.text)] : [])).join('');
}

/** The tools as the model sees them: the names, descriptions and schemas `buildTools` produces. */
async function toolDefinitions(tools: ToolSet) {
  return Promise.all(
    Object.entries(tools).map(async ([name, tool]) => ({
      type: 'function' as const,
      function: {
        name,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        parameters: await asSchema(tool.inputSchema).jsonSchema,
      },
    })),
  );
}

/** The standard usage field, which the default message structure types as absent. */
function usageOf(message: AIMessage): UsageMetadata | undefined {
  return (message as unknown as { usage_metadata?: UsageMetadata }).usage_metadata;
}

/**
 * Summed over the run as `generateText` sums its steps: a step without a count
 * adds nothing, and the count is unknown only when no step reports it
 * (specs/050 § Usage, cost and caching come out the same).
 */
function sumUsage(messages: AIMessage[]): Omit<AgentUsage, 'costUsd'> {
  const total = (read: (message: AIMessage) => number | undefined) => {
    let sum: number | undefined;
    for (const message of messages) {
      const value = read(message);
      if (value !== undefined) sum = (sum ?? 0) + value;
    }
    return sum;
  };
  return {
    inputTokens: total(message => usageOf(message)?.input_tokens),
    outputTokens: total(message => usageOf(message)?.output_tokens),
    cacheReadTokens: total(message => usageOf(message)?.input_token_details?.cache_read),
  };
}

const TurnState = Annotation.Root({
  /** The tool steps: each model message with its calls, then their results. */
  steps: Annotation<BaseMessage[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  /** Model calls made so far, against `MAX_STEPS`. */
  calls: Annotation<number>({ reducer: (_left, right) => right, default: () => 0 }),
  answer: Annotation<AIMessage | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),
});

export class LangGraphRunner extends PromptedRunner<LangGraphRunnerOptions> {
  private readonly handle: ChatModelHandle;
  /** `RECURSION_LIMIT`; lowered only by the test that proves hitting it fails closed. */
  protected recursionLimit = RECURSION_LIMIT;

  constructor(opts: LangGraphRunnerOptions) {
    super(opts);
    const { model } = opts;
    this.handle =
      typeof model === 'object' && 'replyFormat' in model
        ? model
        : chatModelFromAiSdk(model, opts.modelSpec, opts);
  }

  protected async generate(turn: PreparedTurn): Promise<Generated> {
    const { handle } = this;
    const { signal } = turn;
    const schema = await asSchema(AgentReplyForModel).jsonSchema;
    const system = handle.systemMessage(turn.system);
    const history = toLangChainMessages(turn.messages);
    const responses: AIMessage[] = [];
    const tools = turn.tools;

    const call = async (
      runnable: { invoke: (input: BaseMessage[], options: object) => Promise<unknown> },
      messages: BaseMessage[],
    ) => {
      const response = (await runnable.invoke(messages, signal ? { signal } : {})) as AIMessage;
      responses.push(response);
      return response;
    };

    const graph = new StateGraph(TurnState)
      .addNode('model', async state => {
        if (!tools || !handle.model.bindTools) throw new Error('the model node needs tools');
        const bound = handle.model.bindTools(
          await toolDefinitions(tools),
          handle.replyFormat(schema),
        );
        const response = await call(bound, [system, ...history, ...state.steps]);
        return (response.tool_calls ?? []).length > 0
          ? { steps: [response], calls: state.calls + 1 }
          : { answer: response, calls: state.calls + 1 };
      })
      .addNode('tools', async state => {
        const response = state.steps.at(-1) as AIMessage;
        const results: ToolMessage[] = [];
        // One at a time, in the order the model made them (specs/012).
        for (const toolCall of response.tool_calls ?? []) {
          results.push(await this.perform(tools ?? {}, toolCall, signal));
        }
        return { steps: results };
      })
      .addNode('reply', async () => {
        // The reply step sees the staged note in place of its own tool calls,
        // as `GenerateTextRunner`'s last step does (specs/024).
        const notice = tools ? toLangChainMessages([turn.replyNotice()]) : [];
        const response = await call(handle.model.withConfig(handle.replyFormat(schema)), [
          system,
          ...history,
          ...notice,
        ]);
        return { answer: response };
      })
      .addConditionalEdges(START, () => (tools ? 'model' : 'reply'), ['model', 'reply'])
      .addConditionalEdges('model', state => (state.answer ? END : 'tools'), ['tools', END])
      .addConditionalEdges('tools', state => (state.calls >= MAX_STEPS - 1 ? 'reply' : 'model'), [
        'model',
        'reply',
      ])
      .addEdge('reply', END)
      // No checkpointer: history is read from `turns`, as it is today (specs/018).
      .compile();

    const state = await raceAbort(
      graph.invoke({}, { recursionLimit: this.recursionLimit, ...(signal ? { signal } : {}) }),
      signal,
    );
    const reply = state.answer;
    if (!reply) throw new ReplyNotGeneratedError('the graph ended without a reply');
    let output: unknown;
    try {
      output = AgentReplyForModel.parse(JSON.parse(textOf(reply.content)));
    } catch (cause) {
      throw new ReplyNotGeneratedError('the reply does not match the schema', { cause });
    }
    return { output, usage: sumUsage(responses) };
  }

  /**
   * One tool call, as `generateText` performs it: the input checked against the
   * tool's schema, then its `execute`. A tool that rejects its input or throws
   * answers with the error and the loop goes on; an unknown tool fails the turn.
   */
  private async perform(
    tools: ToolSet,
    toolCall: { id?: string | undefined; name: string; args: Record<string, unknown> },
    signal: AbortSignal | undefined,
  ): Promise<ToolMessage> {
    const tool = tools[toolCall.name];
    if (!tool?.execute)
      throw new Error(`the model called a tool it was not offered: ${toolCall.name}`);
    const id = toolCall.id ?? '';
    const answer = (content: string, status: 'success' | 'error') =>
      new ToolMessage({ tool_call_id: id, name: toolCall.name, content, status });
    const schema = asSchema(tool.inputSchema);
    const checked = schema.validate
      ? await schema.validate(toolCall.args)
      : { success: true as const, value: toolCall.args };
    if (!checked.success) return answer(checked.error.message, 'error');
    try {
      const result: unknown = await tool.execute(checked.value, {
        toolCallId: id,
        messages: [],
        context: undefined,
        ...(signal ? { abortSignal: signal } : {}),
      });
      return answer(JSON.stringify(result ?? null), 'success');
    } catch (error) {
      if (signal?.aborted) throw error;
      return answer(error instanceof Error ? error.message : String(error), 'error');
    }
  }
}
