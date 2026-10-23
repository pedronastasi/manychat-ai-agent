import { GenerateTextRunner } from './runner.ts';
import type { AgentRunner, RunnerOptions } from './runner.ts';
import { LangGraphRunner } from './langgraph-runner.ts';
import { resolveChatModel, resolveModel } from './registry.ts';

/**
 * The runner `AGENT_RUNNER` names, with its model resolved at startup so a bad
 * `AGENT_MODEL` fails the deploy under either one (specs/050 § Two runners
 * ship side by side).
 */
export function createRunner(
  kind: 'ai-sdk' | 'langchain',
  opts: Omit<RunnerOptions, 'model'>,
): AgentRunner {
  if (kind === 'langchain') {
    return new LangGraphRunner({ ...opts, model: resolveChatModel(opts.modelSpec, opts) });
  }
  return new GenerateTextRunner({ ...opts, model: resolveModel(opts.modelSpec) });
}
