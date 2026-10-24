import type { PromptedRunner, RunnerOptions } from './runner.ts';
import { LangGraphRunner } from './langgraph-runner.ts';
import { resolveChatModel } from './registry.ts';

/**
 * The runner, with its model resolved at startup so a bad `AGENT_MODEL` fails
 * the deploy (specs/050 § The AI SDK runner is removed).
 */
export function createRunner(
  opts: Omit<RunnerOptions, 'model'>,
): PromptedRunner<Omit<RunnerOptions, 'model'>> {
  return new LangGraphRunner({ ...opts, model: resolveChatModel(opts.modelSpec, opts) });
}
