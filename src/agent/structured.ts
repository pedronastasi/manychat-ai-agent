import { HumanMessage } from '@langchain/core/messages';
import type { AIMessage, MessageContent, UsageMetadata } from '@langchain/core/messages';
import type { z } from 'zod';
import { modelJsonSchema } from './model-schema.ts';
import type { ChatModelHandle } from './registry.ts';

/**
 * One structured call for the judges and the analyst (specs/053 § The judges
 * and the analyst validate their own output). The JSON is asked for the way
 * the customer reply is, per provider through `replyFormat`, and never left
 * to a wrapper's choice. The answer is parsed and validated here (C3).
 */

/** The output could not be parsed, or failed the schema: what the AI SDK called `NoObjectGeneratedError`. */
export class NoObjectGeneratedError extends Error {
  /** What the failed call cost: it was still paid for. */
  readonly usage: StructuredUsage;

  constructor(message: string, usage: StructuredUsage, options?: { cause: unknown }) {
    super(message, options);
    this.name = 'NoObjectGeneratedError';
    this.usage = usage;
  }
}

export interface StructuredUsage {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  cacheReadTokens: number | undefined;
}

function textOf(content: MessageContent): string {
  if (typeof content === 'string') return content;
  return content.flatMap(block => (block.type === 'text' ? [String(block.text)] : [])).join('');
}

function usageOf(message: AIMessage): StructuredUsage {
  const usage = (message as unknown as { usage_metadata?: UsageMetadata }).usage_metadata;
  return {
    inputTokens: usage?.input_tokens,
    outputTokens: usage?.output_tokens,
    cacheReadTokens: usage?.input_token_details?.cache_read,
  };
}

/**
 * Asks `handle` for one object matching `schema`. Resolves with the object
 * and the call's tokens; throws `NoObjectGeneratedError`, carrying the tokens,
 * when the answer is not JSON or fails the schema, and rethrows anything
 * else (an abort, a provider error) as it came.
 */
export async function generateObject<S extends z.ZodType>(
  handle: ChatModelHandle,
  schema: S,
  request: { system: string; user: string; signal?: AbortSignal | undefined },
): Promise<{ output: z.output<S>; usage: StructuredUsage }> {
  const response = (await handle.model
    .withConfig(handle.replyFormat(modelJsonSchema(schema)))
    .invoke([handle.systemMessage(request.system), new HumanMessage(request.user)], {
      ...(request.signal ? { signal: request.signal } : {}),
    })) as AIMessage;
  const usage = usageOf(response);
  const text = textOf(response.content);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new NoObjectGeneratedError('No object generated: could not parse the response.', usage, {
      cause,
    });
  }
  const checked = await schema.safeParseAsync(value);
  if (!checked.success) {
    throw new NoObjectGeneratedError('No object generated: response did not match schema.', usage, {
      cause: checked.error,
    });
  }
  return { output: checked.data, usage };
}
