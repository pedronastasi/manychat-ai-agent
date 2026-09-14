import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';

/**
 * Builds a mock model returning `object` as the model's JSON output.
 *
 * The usage shape here is the PROVIDER-facing one (nested `{total, noCache,
 * cacheRead, cacheWrite}`), which differs from the flattened shape the SDK hands
 * back to callers (`usage.inputTokens`, `usage.inputTokenDetails.*`). Getting
 * this wrong is silent: the call succeeds and every token count reads as
 * undefined, which would make the budget cap a no-op.
 */
export function mockModel(
  object: unknown,
  opts: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } = {},
) {
  const input = opts.inputTokens ?? 1000;
  const cacheRead = opts.cacheReadTokens ?? 0;
  const calls: LanguageModelV4CallOptions[] = [];

  const model = new MockLanguageModelV4({
    doGenerate: async (options: LanguageModelV4CallOptions) => {
      calls.push(options);
      return {
        finishReason: { unified: 'stop' as const, raw: 'end_turn' },
        usage: {
          inputTokens: { total: input, noCache: input - cacheRead, cacheRead, cacheWrite: 0 },
          outputTokens: {
            total: opts.outputTokens ?? 50,
            text: opts.outputTokens ?? 50,
            reasoning: 0,
          },
        },
        content: [{ type: 'text' as const, text: JSON.stringify(object) }],
        warnings: [],
      };
    },
  });
  return { model, calls };
}

/** A model that never resolves until aborted — for testing the race deadline. */
export function hangingModel() {
  return new MockLanguageModelV4({
    doGenerate: (options: LanguageModelV4CallOptions) =>
      new Promise((_resolve, reject) => {
        options.abortSignal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      }),
  });
}
