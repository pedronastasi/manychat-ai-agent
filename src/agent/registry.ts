import { createProviderRegistry } from 'ai';
import type { LanguageModel } from 'ai';
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
  constructor(spec: string, cause: unknown) {
    super(
      `Cannot resolve model '${spec}'. Expected "provider:model" where provider is one of ` +
        `anthropic, openai, google, ollama. Check AGENT_MODEL and that the provider's API key is set.`,
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
