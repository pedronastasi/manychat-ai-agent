import { LangGraphRunner } from '../../src/agent/langgraph-runner.ts';
import type { LangGraphRunnerOptions } from '../../src/agent/langgraph-runner.ts';

/**
 * The runner a runner-level test runs under. The AI SDK runner beside it was
 * removed (specs/050 § The AI SDK runner is removed); each test keeps the
 * runner's name in its title, and takes the `mock:` chat model or an AI SDK
 * fake, which the LangChain runner wraps itself until specs/053's step 3.
 */
export type RunnerClass = new (opts: LangGraphRunnerOptions) => LangGraphRunner;

export const RUNNERS: { name: string; Runner: RunnerClass }[] = [
  { name: 'langchain', Runner: LangGraphRunner },
];
