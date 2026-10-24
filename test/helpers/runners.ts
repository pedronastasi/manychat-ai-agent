import type { RunnerOptions } from '../../src/agent/runner.ts';
import { LangGraphRunner } from '../../src/agent/langgraph-runner.ts';

/**
 * The runner a runner-level test runs under. The AI SDK runner beside it was
 * removed (specs/050 § The AI SDK runner is removed); each test keeps the
 * runner's name in its title, and takes an AI SDK model, which the LangChain
 * runner wraps itself.
 */
export type RunnerClass = new (opts: RunnerOptions) => LangGraphRunner;

export const RUNNERS: { name: string; Runner: RunnerClass }[] = [
  { name: 'langchain', Runner: LangGraphRunner },
];
