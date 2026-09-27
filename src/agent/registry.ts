import { createProviderRegistry } from 'ai';
import type { LanguageModel, TranscriptionModel } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { openai, createOpenAI } from '@ai-sdk/openai';
import { google } from '@ai-sdk/google';
import { createMockModel } from './mock-provider.ts';

/**
 * The ONLY module permitted to import a provider package (Constitution C2).
 * Everything else depends on the AgentRunner port, so switching provider is an
 * environment change rather than a code change (ADR-0002).
 */
const ollama = createOpenAI({
  baseURL: process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1',
  apiKey: 'ollama',
});
const registry = createProviderRegistry({ anthropic, openai, google, ollama });

/** Per-million-token prices, USD. Used for budget caps, not billing. */
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
}

/**
 * Prices drift, and a stale table would silently mis-cap spend. Treated as a
 * best-effort estimate: `PRICING_OVERRIDES` lets an operator correct a value
 * without a release, and an unknown model falls back to a deliberately
 * pessimistic estimate so the cap errs toward stopping early.
 */
const PRICING: Record<string, ModelPricing> = {
  'anthropic:claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1 },
  'anthropic:claude-sonnet-5': { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2 },
  'anthropic:claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5 },
};

const FALLBACK_PRICING: ModelPricing = {
  inputPerMTok: 5,
  outputPerMTok: 25,
  cacheReadPerMTok: 0.5,
};

const ZERO_PRICING: ModelPricing = { inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: 0 };

export function pricingFor(modelId: string): ModelPricing {
  if (modelId.startsWith('ollama:')) return ZERO_PRICING;
  return PRICING[modelId] ?? FALLBACK_PRICING;
}

/** OpenAI's reasoning families: the o-series and gpt-5. */
const REASONING_MODEL = /^openai:(o\d|gpt-5)/;

/**
 * Whether a model accepts `temperature` at all.
 *
 * Reasoning models reject it. The provider does not fail the call — it drops
 * the setting and emits a warning per request, which is noise in every log and
 * every eval run, and it trains the reader to ignore SDK warnings that
 * occasionally matter.
 *
 * Keyed off the `provider:model` spec rather than a provider package, so this
 * stays on the right side of C2.
 */
export function supportsTemperature(modelId: string): boolean {
  return !REASONING_MODEL.test(modelId);
}

/** OpenAI models that take no image input. */
const TEXT_ONLY_OPENAI = /^openai:(gpt-3\.5|o1-mini|o3-mini)/;

/**
 * Whether the answering model accepts images (specs/020). A model that does
 * not sends images and video frames to the media fallback.
 *
 * Every hosted provider in the registry takes images on its current models.
 * An Ollama model is assumed not to: most local models have no vision, and a
 * wrong `true` fails the turn, where a wrong `false` only asks the contact to
 * type (specs/007). An unknown provider is treated the same way.
 */
export function acceptsImages(modelId: string): boolean {
  if (TEXT_ONLY_OPENAI.test(modelId)) return false;
  return /^(anthropic|openai|google|mock):/.test(modelId);
}

/**
 * Per-minute transcription prices, USD. Beside token pricing for the same
 * reason: they feed the daily budget cap, so a stale value mis-caps spend.
 */
const TRANSCRIPTION_PRICING: Record<string, number> = {
  'openai:gpt-4o-mini-transcribe': 0.003,
  'openai:gpt-4o-transcribe': 0.006,
  'openai:whisper-1': 0.006,
};

/** Deliberately pessimistic, like FALLBACK_PRICING. */
const FALLBACK_TRANSCRIPTION_PER_MINUTE = 0.02;

export function transcriptionCostUsd(modelId: string, seconds: number): number {
  const perMinute = TRANSCRIPTION_PRICING[modelId] ?? FALLBACK_TRANSCRIPTION_PER_MINUTE;
  return (seconds / 60) * perMinute;
}

export function estimateCostUsd(
  modelId: string,
  usage: {
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    cacheReadTokens?: number | undefined;
  },
): number {
  const pricing = pricingFor(modelId);
  const cacheRead = usage.cacheReadTokens ?? 0;
  const freshInput = Math.max(0, (usage.inputTokens ?? 0) - cacheRead);
  return (
    (freshInput * pricing.inputPerMTok) / 1_000_000 +
    (cacheRead * pricing.cacheReadPerMTok) / 1_000_000 +
    ((usage.outputTokens ?? 0) * pricing.outputPerMTok) / 1_000_000
  );
}

export class UnknownProviderError extends Error {
  constructor(spec: string, cause: unknown, variable = 'AGENT_MODEL') {
    super(
      `Cannot resolve model '${spec}'. Expected "provider:model" where provider is one of ` +
        `anthropic, openai, google, ollama. Check ${variable} and that the provider's API key is set.`,
      { cause },
    );
    this.name = 'UnknownProviderError';
  }
}

/**
 * Resolves `provider:model` to a language model.
 *
 * Called once at startup rather than per request: a typo in AGENT_MODEL should
 * fail the deploy, not the first customer message.
 */
export function resolveModel(spec: string): LanguageModel {
  // Offline provider for local dev, CI and demos. Keeping it behind the same
  // `provider:model` indirection means nothing downstream knows the difference.
  if (spec.startsWith('mock:')) {
    return createMockModel(spec.slice('mock:'.length));
  }
  try {
    return registry.languageModel(spec as Parameters<typeof registry.languageModel>[0]);
  } catch (cause) {
    throw new UnknownProviderError(spec, cause);
  }
}

/**
 * Resolves TRANSCRIPTION_MODEL, at startup for the same reason as
 * `resolveModel`. Not every provider transcribes (Anthropic does not), and one
 * that does not fails here rather than on the first voice note.
 */
export function resolveTranscriptionModel(spec: string): TranscriptionModel {
  try {
    return registry.transcriptionModel(spec as Parameters<typeof registry.transcriptionModel>[0]);
  } catch (cause) {
    throw new UnknownProviderError(spec, cause, 'TRANSCRIPTION_MODEL');
  }
}
