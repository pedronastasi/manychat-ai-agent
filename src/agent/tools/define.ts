import { tool } from '@langchain/core/tools';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import type { z } from 'zod';

/**
 * A tool the model may call: a LangChain.js tool (specs/053 § Tools are
 * LangChain tools, and the model sees the same bytes). Its `schema` is the Zod
 * object the model is shown, through `modelJsonSchema`.
 */
export type AgentTool = DynamicStructuredTool;

/** A turn's tools, by name, in the order the model is offered them. */
export type AgentTools = Record<string, AgentTool>;

/** What a tool's `execute` is given beside its input: the turn's signal. */
export interface ToolRun {
  abortSignal?: AbortSignal | undefined;
}

/**
 * Builds one tool with LangChain's `tool()`. The definition keeps the shape
 * every tool here was written in, `description`, `inputSchema` and `execute`,
 * so moving library changed no tool's body.
 */
export function agentTool<S extends z.ZodType<Record<string, unknown>>>(
  name: string,
  definition: {
    description: string;
    inputSchema: S;
    execute: (input: z.output<S>, run: ToolRun) => unknown;
  },
): AgentTool {
  return tool(
    (input: z.output<S>, config: { signal?: AbortSignal | undefined }) =>
      definition.execute(input, { abortSignal: config.signal }),
    { name, description: definition.description, schema: definition.inputSchema },
  ) as unknown as AgentTool;
}

/**
 * Performs a tool already validated against its schema, with the turn's
 * signal, and without opening a LangChain run: the turn's trace is the
 * service's own projection (specs/052), and `invoke` would add a run to it.
 */
export async function runTool(
  agentTool: AgentTool,
  input: unknown,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  return agentTool.func(input, undefined, signal ? { signal } : {});
}
