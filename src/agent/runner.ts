import { generateObject, type LanguageModel, type ModelMessage } from 'ai';
import { AgentReplyForModel, type AgentReply } from '../contracts/agent.ts';
import type { TenantConfig } from '../config/loader.ts';
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
  /**
   * The error name when the call failed and `reply` is the fail-closed
   * fallback, absent when the model actually answered.
   *
   * Without it a failed call is indistinguishable from a model that chose to
   * escalate: both carry `escalate: true` and the same tenant message, so the
   * turn was recorded as `escalated_model` and the only clue left was that
   * usage came back undefined.
   */
  modelError?: string;
  latencyMs: number;
  /**
   * The `provider:model` spec that produced this turn. Recorded per turn
   * because the active model is a runtime string (ADR-0002) — without it,
   * spend cannot be attributed after a model switch.
   */
  model: string;
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
  /**
   * Read per turn rather than captured, so a SIGHUP reload reaches the prompt.
   * Passing the values directly froze the persona and catalog for the life of
   * the process: `rules` reloaded because turn.ts re-reads them, but the system
   * prompt did not, so prompt edits silently needed a restart (specs/003).
   */
  config: () => TenantConfig;
  maxOutputTokens: number;
  temperature: number;
  /** Reasoning models only; omitted from the request when unset. */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | undefined;
  /**
   * Records prompts and completions in telemetry spans. Off by default: spans
   * would otherwise carry the contact's message text verbatim, which is exactly
   * what Constitution C5 forbids. Enable only against a trusted collector.
   */
  recordPromptsInTraces?: boolean;
}

export class GenerateObjectRunner implements AgentRunner {
  private readonly opts: RunnerOptions;
  private cached: { config: TenantConfig; staticPrefix: string; catalogBlock: string } | undefined;

  constructor(opts: RunnerOptions) {
    this.opts = opts;
  }

  /**
   * Rebuilds only when ConfigStore swaps in a new object, so the prefix stays
   * byte-identical between reloads and remains cacheable (see prompt.ts). A
   * failed reload keeps the previous object, so it correctly rebuilds nothing.
   */
  private current() {
    const config = this.opts.config();
    if (this.cached?.config !== config) {
      this.cached = { config, ...buildSystemPrompt(config.persona, config.catalog, config.rules) };
    }
    return this.cached;
  }

  async run({ text, history, signal }: AgentTurnInput): Promise<AgentResult> {
    const started = Date.now();
    // Resolved once per turn: a reload landing mid-turn must not produce a
    // reply built from one config and guarded by another.
    const { config, staticPrefix, catalogBlock } = this.current();

    const messages: ModelMessage[] = [
      ...history.map((turn): ModelMessage =>
        turn.role === 'user'
          ? { role: 'user', content: fenceUserText(turn.text) }
          : { role: 'assistant', content: turn.text },
      ),
      { role: 'user', content: fenceUserText(text) },
    ];

    let result: Awaited<ReturnType<typeof generateObject<typeof AgentReplyForModel>>>;
    try {
      result = await generateObject({
        model: this.opts.model,
        schema: AgentReplyForModel,
        // Static instructions first, then the catalog. Both are invariant across
        // requests, which is what makes the prefix cacheable (see prompt.ts).
        system: `${staticPrefix}\n\n${catalogBlock}`,
        messages,
        maxOutputTokens: this.opts.maxOutputTokens,
        temperature: this.opts.temperature,
        // Emits OpenTelemetry spans when the operator registers a telemetry
        // integration; a no-op otherwise, so it costs nothing by default.
        telemetry: {
          functionId: 'agent-turn',
          recordInputs: this.opts.recordPromptsInTraces ?? false,
          recordOutputs: this.opts.recordPromptsInTraces ?? false,
        },
        ...(signal ? { abortSignal: signal } : {}),
        providerOptions: {
          // Caches the system block on Anthropic. Ignored by providers that
          // cache automatically, so it is safe to send unconditionally.
          anthropic: { cacheControl: { type: 'ephemeral' } },
          // Each key is read only by the provider it names, so an option meant
          // for one is inert for the rest.
          ...(this.opts.reasoningEffort
            ? { openai: { reasoningEffort: this.opts.reasoningEffort } }
            : {}),
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
      const name = error instanceof Error ? error.name : 'unknown';
      return {
        reply: escalationReply('low_confidence', config.rules.messages.escalation),
        interventions: [`model_error: ${name}`],
        modelError: name,
        latencyMs: Date.now() - started,
        model: this.opts.modelSpec,
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

    const guarded = applyGuardrails(result.object, config.rules);

    return {
      reply: guarded.reply,
      interventions: guarded.interventions,
      latencyMs: Date.now() - started,
      model: this.opts.modelSpec,
      usage: { ...usage, costUsd: estimateCostUsd(this.opts.modelSpec, usage) },
    };
  }
}
