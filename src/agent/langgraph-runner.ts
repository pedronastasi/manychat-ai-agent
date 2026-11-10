import { runTool } from './tools/define.ts';
import type { AgentTool, AgentTools } from './tools/define.ts';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { HumanMessage, ToolMessage } from '@langchain/core/messages';
import type {
  BaseMessage,
  MessageContent,
  UsageMetadata,
  AIMessage,
} from '@langchain/core/messages';
import type { z } from 'zod';
import { AgentReplyForModel, AgentReplyFromModel } from '../contracts/agent.ts';
import { invalidToolInputText, modelJsonSchema, unknownToolText } from './model-schema.ts';
import type { ChatModelHandle } from './registry.ts';
import { PromptedRunner } from './runner.ts';
import type { AgentUsage, Generated, PreparedTurn, RunnerOptions } from './runner.ts';
import { MAX_STEPS } from './tools.ts';

/**
 * The LangChain.js runner (ADR-0026, ADR-0027): the prompt, tools and
 * guardrails `PromptedRunner` owns, with the loop drawn as a LangGraph.js
 * graph of three nodes the service owns, never a prebuilt agent
 * (specs/050 § The graph has three nodes and a step counter).
 */

export type LangGraphRunnerOptions = RunnerOptions;

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
 * the same failure, so `modelError` reads as it did before the AI SDK runner
 * was removed.
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

function textOf(content: MessageContent): string {
  if (typeof content === 'string') return content;
  return content.flatMap(block => (block.type === 'text' ? [String(block.text)] : [])).join('');
}

/** The reply's text read against the schema: anything else is a failed generation (C3). */
function parseReply(reply: AIMessage): unknown {
  try {
    return AgentReplyFromModel.parse(JSON.parse(textOf(reply.content)));
  } catch (cause) {
    throw new ReplyNotGeneratedError('the reply does not match the schema', { cause });
  }
}

/**
 * Why the reply is asked for again. It names no marker and quotes nothing from
 * the draft, so the rewrite has nothing to copy (specs/001).
 */
export const REWRITE_NOTE =
  'Your draft of this reply put your working notes in a message the contact reads. ' +
  'Write the reply again. Messages hold only what you say to the contact; anything ' +
  'you need to weigh goes in notes.';

/** The tools as the model sees them: the names, descriptions and schemas `buildTools` produces. */
function toolDefinitions(tools: AgentTools) {
  return Object.entries(tools).map(([name, tool]) => ({
    type: 'function' as const,
    function: {
      name,
      description: tool.description,
      parameters: modelJsonSchema(inputSchemaOf(tool)),
    },
  }));
}

/** A tool's input schema. Every tool here is built with a Zod schema (specs/012, specs/036). */
function inputSchemaOf(tool: AgentTool): z.ZodType {
  return tool.schema;
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
    this.handle = opts.model;
  }

  protected async generate(turn: PreparedTurn): Promise<Generated> {
    const { handle } = this;
    const { signal } = turn;
    const schema = modelJsonSchema(AgentReplyForModel);
    const system = handle.systemMessage(turn.system);
    const history = turn.messages;
    const responses: AIMessage[] = [];
    const tools = turn.tools;

    // A model call joins the node it runs in, so a traced turn's runs nest
    // under its root run (specs/052 § One traced turn is one root run).
    const call = async (
      runnable: { invoke: (input: BaseMessage[], options: object) => Promise<unknown> },
      messages: BaseMessage[],
      config: LangGraphRunnableConfig,
    ) => {
      const response = (await runnable.invoke(messages, {
        ...(signal ? { signal } : {}),
        ...(config.callbacks ? { callbacks: config.callbacks } : {}),
      })) as AIMessage;
      responses.push(response);
      return response;
    };

    const graph = new StateGraph(TurnState)
      .addNode('model', async (state, config) => {
        if (!tools || !handle.model.bindTools) throw new Error('the model node needs tools');
        const bound = handle.model.bindTools(toolDefinitions(tools), handle.replyFormat(schema));
        const response = await call(bound, [system, ...history, ...state.steps], config);
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
      .addNode('reply', async (_state, config) => {
        // The reply step sees the staged note in place of its own tool calls,
        // as the AI SDK runner's last step did (specs/024).
        const notice = tools ? [turn.replyNotice()] : [];
        const response = await call(
          handle.model.withConfig(handle.replyFormat(schema)),
          [system, ...history, ...notice],
          config,
        );
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
      graph.invoke(
        {},
        {
          recursionLimit: this.recursionLimit,
          ...(signal ? { signal } : {}),
          ...(turn.callbacks ? { callbacks: turn.callbacks } : {}),
        },
      ),
      signal,
    );
    const reply = state.answer;
    if (!reply) throw new ReplyNotGeneratedError('the graph ended without a reply');
    return { output: parseReply(reply), usage: sumUsage(responses) };
  }

  protected async rewrite(turn: PreparedTurn): Promise<Generated> {
    const { handle } = this;
    const { signal } = turn;
    const schema = modelJsonSchema(AgentReplyForModel);
    // The staged note, as the reply node sees it, so the rewrite knows what
    // already went out and does not offer it again.
    const notice = turn.tools ? [turn.replyNotice()] : [];
    const response = (await raceAbort(
      handle.model
        .withConfig(handle.replyFormat(schema))
        .invoke(
          [
            handle.systemMessage(turn.system),
            ...turn.messages,
            ...notice,
            new HumanMessage(REWRITE_NOTE),
          ],
          {
            ...(signal ? { signal } : {}),
            ...(turn.callbacks ? { callbacks: turn.callbacks } : {}),
          },
        ),
      signal,
    )) as AIMessage;
    return { output: parseReply(response), usage: sumUsage([response]) };
  }

  /**
   * One tool call, as `generateText` performed it: the input checked against
   * the tool's schema, then the tool run. An unknown tool, input that fails the
   * schema and a tool that throws each answer the model with the error, in the
   * text the AI SDK's error classes printed, now written here, and the loop
   * goes on (specs/050 § The runner changes no behaviour a spec here fixes,
   * specs/053 § Tools are LangChain tools, and the model sees the same bytes).
   */
  private async perform(
    tools: AgentTools,
    toolCall: { id?: string | undefined; name: string; args: Record<string, unknown> },
    signal: AbortSignal | undefined,
  ): Promise<ToolMessage> {
    const id = toolCall.id ?? '';
    const answer = (content: string, status: 'success' | 'error') =>
      new ToolMessage({ tool_call_id: id, name: toolCall.name, content, status });
    const tool = tools[toolCall.name];
    if (!tool) {
      return answer(unknownToolText(toolCall.name, Object.keys(tools)), 'error');
    }
    const schema = inputSchemaOf(tool);
    const checked = await schema.safeParseAsync(toolCall.args);
    if (!checked.success) {
      return answer(invalidToolInputText(toolCall.name, toolCall.args, checked.error), 'error');
    }
    try {
      const result: unknown = await runTool(tool, checked.data, signal);
      return answer(JSON.stringify(result ?? null), 'success');
    } catch (error) {
      if (signal?.aborted) throw error;
      return answer(String(error), 'error');
    }
  }
}
