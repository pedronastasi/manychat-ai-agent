import { generateObject, type LanguageModel, type ModelMessage } from 'ai';
import { AgentReplyForModel, type AgentReply } from '../contracts/agent.ts';
import type { Catalog, Rules } from '../contracts/config.ts';
import { buildSystemPrompt, fenceUserText } from './prompt.ts';
import { applyGuardrails, escalationReply } from './guardrails.ts';
import { estimateCostUsd } from './registry.ts';

export interface AgentUsage {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  cacheReadTokens: number | undefined;
  costUsd: number;
}

export interface AgentResult {
  reply: AgentReply;
  usage: AgentUsage;
  interventions: string[];
  latencyMs: number;
}

export interface AgentTurnInput {
  text: string;
  history: { role: 'user' | 'agent'; text: string }[];
  signal?: AbortSignal | undefined;
}

/**
 * The port every caller depends on. v1 implements it with a single
 * `generateObject` call; a tool-using implementation can replace it later
 * without touching callers (ADR-0007).
 */
export interface AgentRunner {
  run(input: AgentTurnInput): Promise<AgentResult>;
}

export interface RunnerOptions {
  model: LanguageModel;
  modelSpec: string;
  persona: string;
  catalog: Catalog;
  rules: Rules;
  maxOutputTokens: number;
  temperature: number;
  /**
   * Records prompts and completions in telemetry spans. Off by default: spans
   * would otherwise carry the contact's message text verbatim, which is exactly
   * what Constitution C5 forbids. Enable only against a trusted collector.
   */
  recordPromptsInTraces?: boolean;
}

export function createAgentRunner(opts: RunnerOptions): AgentRunner {
  const { staticPrefix, catalogBlock } = buildSystemPrompt(opts.persona, opts.catalog, opts.rules);

  return {
    async run({ text, history, signal }: AgentTurnInput): Promise<AgentResult> {
      const started = Date.now();

      const messages: ModelMessage[] = [
        ...history.map((h): ModelMessage =>
          h.role === 'user'
            ? { role: 'user', content: fenceUserText(h.text) }
            : { role: 'assistant', content: h.text },
        ),
        { role: 'user', content: fenceUserText(text) },
      ];

      let result: Awaited<ReturnType<typeof generateObject<typeof AgentReplyForModel>>>;
      try {
        result = await generateObject({
          model: opts.model,
          schema: AgentReplyForModel,
          // Static instructions first, then the catalog. Both are invariant across
          // requests, which is what makes the prefix cacheable (see prompt.ts).
          system: `${staticPrefix}\n\n${catalogBlock}`,
          messages,
          maxOutputTokens: opts.maxOutputTokens,
          temperature: opts.temperature,
          // Emits OpenTelemetry spans when the operator registers a telemetry
          // integration; a no-op otherwise, so it costs nothing by default.
          telemetry: {
            functionId: 'agent-turn',
            recordInputs: opts.recordPromptsInTraces ?? false,
            recordOutputs: opts.recordPromptsInTraces ?? false,
          },
          ...(signal ? { abortSignal: signal } : {}),
          providerOptions: {
            // Caches the system block on Anthropic. Ignored by providers that
            // cache automatically, so it is safe to send unconditionally.
            anthropic: { cacheControl: { type: 'ephemeral' } },
          },
        });
      } catch (error) {
        // generateObject validates against the schema and throws when the model
        // does not comply, so this is the common failure, not an exotic one.
        // An abort (race deadline) is rethrown so the caller can tell "too slow"
        // apart from "model misbehaved"; everything else fails closed to a human
        // (Constitution C6).
        if (error instanceof Error && error.name === 'AbortError') throw error;
        if (signal?.aborted) throw error;
        return {
          reply: escalationReply('low_confidence'),
          interventions: [`model_error: ${error instanceof Error ? error.name : 'unknown'}`],
          latencyMs: Date.now() - started,
          usage: {
            inputTokens: undefined,
            outputTokens: undefined,
            cacheReadTokens: undefined,
            costUsd: 0,
          },
        };
      }

      const usage = {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheReadTokens: result.usage.inputTokenDetails.cacheReadTokens,
      };

      const guarded = applyGuardrails(result.object, opts.rules);

      return {
        reply: guarded.reply,
        interventions: guarded.interventions,
        latencyMs: Date.now() - started,
        usage: { ...usage, costUsd: estimateCostUsd(opts.modelSpec, usage) },
      };
    },
  };
}
