import { runTool } from '../../src/agent/tools/define.ts';
import type { AgentTool } from '../../src/agent/tools/define.ts';

/**
 * Runs a built tool as the runner does once its input passed the schema, with
 * the turn's signal (specs/053 § Tools are LangChain tools). An absent tool
 * gives `undefined`, as calling an absent tool's `execute` with `?.` did.
 */
export async function execute(
  tool: AgentTool | undefined,
  input: unknown,
  options: { abortSignal?: AbortSignal | undefined } = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each test reads its own tool's result shape
): Promise<any> {
  if (!tool) return undefined;
  return runTool(tool, input, options.abortSignal);
}
