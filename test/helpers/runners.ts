import { GenerateTextRunner } from '../../src/agent/runner.ts';
import type { RunnerOptions } from '../../src/agent/runner.ts';
import { LangGraphRunner } from '../../src/agent/langgraph-runner.ts';

/**
 * Both runners, for a test that must hold under either while both ship
 * (specs/050 § Two runners ship side by side). Each takes the same options,
 * the model included: the LangChain runner wraps an AI SDK model itself.
 */
export type RunnerClass = new (opts: RunnerOptions) => GenerateTextRunner | LangGraphRunner;

export const RUNNERS: { name: string; Runner: RunnerClass }[] = [
  { name: 'ai-sdk', Runner: GenerateTextRunner },
  { name: 'langchain', Runner: LangGraphRunner },
];
