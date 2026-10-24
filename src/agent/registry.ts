import { AsyncLocalStorage } from 'node:async_hooks';
import { createProviderRegistry } from 'ai';
import type { LanguageModel, TranscriptionModel } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { openai, createOpenAI } from '@ai-sdk/openai';
import { google } from '@ai-sdk/google';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { SystemMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { JSONSchema7 } from '@ai-sdk/provider';
import { createMockModel } from './mock-provider.ts';
import { AiSdkChatModel, aiSdkProviderOptions } from './ai-sdk-chat-model.ts';

/**
 * The ONLY module permitted to import a provider package (Constitution C2).
 * Everything else depends on the AgentRunner port, so switching provider is an
 * environment change rather than a code change (ADR-0002).
 */
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1';
const ollama = createOpenAI({ baseURL: OLLAMA_BASE_URL, apiKey: 'ollama' });
const registry = createProviderRegistry({ anthropic, openai, google, ollama });

/** Per-million-token prices, USD. Used for budget caps, not billing. */
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
}

/**
 * Prices drift, and a stale table would silently mis-cap spend. Treated as a
 * best-effort estimate: an unknown model falls back to a deliberately
 * pessimistic estimate so the cap errs toward stopping early. That fallback
 * prices a cheap model at many times its list price, so a model in regular use
 * belongs in this table.
 */
const PRICING: Record<string, ModelPricing> = {
  // Standard list prices as of October 2026. Where a model has a long-prompt
  // tier, this is the short-prompt price: a prompt past that threshold (100k
  // tokens on Haiku 5.5, 272k on GPT-6) is under-counted.
  'anthropic:claude-haiku-5-5': { inputPerMTok: 0.1, outputPerMTok: 0.5, cacheReadPerMTok: 0.01 },
  'anthropic:claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.1 },
  'anthropic:claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2 },
  'anthropic:claude-sonnet-5': { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2 },
  'anthropic:claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5 },
  'anthropic:claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3 },
  'anthropic:claude-sonnet-4-5': { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3 },
  'anthropic:claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1 },
  'openai:gpt-6-sol': { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2 },
  'openai:gpt-6-luna': { inputPerMTok: 0.1, outputPerMTok: 0.5, cacheReadPerMTok: 0.01 },
  'openai:gpt-5': { inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.125 },
  'openai:gpt-5-mini': { inputPerMTok: 0.25, outputPerMTok: 2, cacheReadPerMTok: 0.025 },
  'openai:gpt-5-nano': { inputPerMTok: 0.05, outputPerMTok: 0.4, cacheReadPerMTok: 0.005 },
  // Introductory pricing halves this until 2027; the table holds the standard
  // price, so the cap errs toward stopping early meanwhile. Cache reads at 10%
  // of input, Google's ratio on its other Flash models.
  'google:gemini-3.8-flash': { inputPerMTok: 1.5, outputPerMTok: 7.5, cacheReadPerMTok: 0.15 },
  'google:gemini-3.5-flash-lite': { inputPerMTok: 0.3, outputPerMTok: 2.5, cacheReadPerMTok: 0.03 },
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

/** OpenAI's reasoning families: the o-series and GPT-5/GPT-6. */
const REASONING_MODEL = /^openai:(o\d|gpt-[56])/;

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
export function resolveModel(spec: string, variable = 'AGENT_MODEL'): LanguageModel {
  // Offline provider for local dev, CI and demos. Keeping it behind the same
  // `provider:model` indirection means nothing downstream knows the difference.
  if (spec.startsWith('mock:')) {
    return createMockModel(spec.slice('mock:'.length));
  }
  try {
    return registry.languageModel(spec as Parameters<typeof registry.languageModel>[0]);
  } catch (cause) {
    throw new UnknownProviderError(spec, cause, variable);
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

/** What the LangChain runner is configured with (specs/050). */
export interface ChatModelSettings {
  maxOutputTokens: number;
  temperature: number;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | undefined;
}

/**
 * A LangChain.js chat model, with what differs between providers kept here
 * beside the only provider imports (C2): how a reply is asked for as JSON, and
 * where the cache breakpoint goes (specs/050).
 */
export interface ChatModelHandle {
  model: BaseChatModel;
  /** Per-call options asking for the reply as JSON matching `schema`, the provider's way. */
  replyFormat(schema: JSONSchema7): Record<string, unknown>;
  /** The system prompt, carrying the provider's cache breakpoint. */
  systemMessage(text: string): SystemMessage;
}

/**
 * The retries every chat model makes, inside the abort: the AI SDK's
 * `maxRetries` default, kept from the removed AI SDK runner. LangChain's
 * own default is 6 (specs/050 § Defaults that change behaviour).
 */
export const CHAT_MODEL_MAX_RETRIES = 2;

/** An AI SDK model, `mock:` or a test fake, as a LangChain chat model. */
export function chatModelFromAiSdk(
  model: LanguageModel,
  modelSpec: string,
  settings: ChatModelSettings,
): ChatModelHandle {
  if (typeof model === 'string' || model.specificationVersion !== 'v4') {
    throw new Error(`the LangChain runner wraps AI SDK v4 models only, not ${modelSpec}`);
  }
  return {
    model: new AiSdkChatModel(model, {
      maxOutputTokens: settings.maxOutputTokens,
      temperature: supportsTemperature(modelSpec) ? settings.temperature : undefined,
      providerOptions: aiSdkProviderOptions(settings.reasoningEffort),
    }),
    replyFormat: schema => ({ responseFormat: { type: 'json', schema } }),
    systemMessage: text => new SystemMessage(text),
  };
}

/** The signal of the Gemini call in progress, for `AbortableGemini`. */
const geminiSignal = new AsyncLocalStorage<AbortSignal | undefined>();

/**
 * `ChatGoogleGenerativeAI` whose request stops on the abort. Its `_generate`
 * calls `completionWithRetry(request)` without the call options, so the signal
 * never reaches the request: the call is abandoned, not cancelled, and runs on
 * after the turn (read in 2.3.4; specs/050 § Defaults that change behaviour).
 */
class AbortableGemini extends ChatGoogleGenerativeAI {
  override _generate(...args: Parameters<ChatGoogleGenerativeAI['_generate']>) {
    return geminiSignal.run(args[1].signal, () => super._generate(...args));
  }

  override completionWithRetry(
    ...[request, options]: Parameters<ChatGoogleGenerativeAI['completionWithRetry']>
  ) {
    const signal = geminiSignal.getStore();
    return super.completionWithRetry(request, options ?? (signal ? { signal } : undefined));
  }
}

/** OpenAI's structured output, strict as the AI SDK's `strictJsonSchema` default. */
function openAiReplyFormat(schema: JSONSchema7): Record<string, unknown> {
  return {
    response_format: { type: 'json_schema', json_schema: { name: 'reply', schema, strict: true } },
  };
}

/**
 * Resolves `provider:model` to a LangChain.js chat model, built by its class.
 * Never `initChatModel`: it loads a provider with a dynamic import the C2 lint
 * cannot see, infers a provider from a bare model name, and with no model makes
 * the model selectable at call time (specs/050 § The registry builds each chat
 * model by its class). Called once at startup, like `resolveModel`.
 */
export function resolveChatModel(
  spec: string,
  settings: ChatModelSettings,
  variable = 'AGENT_MODEL',
): ChatModelHandle {
  const separator = spec.indexOf(':');
  const provider = separator > 0 ? spec.slice(0, separator) : '';
  const model = spec.slice(separator + 1);
  const temperature = supportsTemperature(spec) ? { temperature: settings.temperature } : {};
  const plainSystem = (text: string) => new SystemMessage(text);
  try {
    switch (provider) {
      case 'mock':
        return chatModelFromAiSdk(createMockModel(model), spec, settings);
      case 'anthropic':
        return {
          model: new ChatAnthropic({
            model,
            maxRetries: CHAT_MODEL_MAX_RETRIES,
            maxTokens: settings.maxOutputTokens,
            ...temperature,
          }),
          replyFormat: schema => ({ outputConfig: { format: { type: 'json_schema', schema } } }),
          systemMessage: text =>
            new SystemMessage({
              content: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }],
            }),
        };
      case 'openai':
      case 'ollama':
        return {
          model: new ChatOpenAI({
            model,
            maxRetries: CHAT_MODEL_MAX_RETRIES,
            maxTokens: settings.maxOutputTokens,
            // The AI SDK's `openai(model)` is the Responses API.
            useResponsesApi: true,
            ...temperature,
            ...(settings.reasoningEffort
              ? { reasoning: { effort: settings.reasoningEffort } }
              : {}),
            ...(provider === 'ollama'
              ? { apiKey: 'ollama', configuration: { baseURL: OLLAMA_BASE_URL } }
              : {}),
          }),
          replyFormat: openAiReplyFormat,
          systemMessage: plainSystem,
        };
      case 'google':
        return {
          model: new AbortableGemini({
            model,
            maxRetries: CHAT_MODEL_MAX_RETRIES,
            maxOutputTokens: settings.maxOutputTokens,
            ...temperature,
          }),
          replyFormat: schema => ({ responseSchema: schema }),
          systemMessage: plainSystem,
        };
      default:
        throw new Error(`unknown provider '${provider}'`);
    }
  } catch (cause) {
    throw new UnknownProviderError(spec, cause, variable);
  }
}
