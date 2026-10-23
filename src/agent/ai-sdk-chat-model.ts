import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type {
  BaseChatModelCallOptions,
  BindToolsInput,
} from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';
import type { BaseMessage, MessageContent, UsageMetadata } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import type {
  JSONSchema7,
  JSONValue,
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4Message,
  LanguageModelV4Prompt,
  LanguageModelV4Usage,
  SharedV4ProviderOptions,
} from '@ai-sdk/provider';

/**
 * A LangChain.js chat model over an AI SDK model, so the LangChain runner can
 * drive `mock:` and every test fake built at the AI SDK's provider boundary,
 * unchanged (specs/050 § The mock answers as today's mock provider does,
 * § The public exports keep their signatures).
 *
 * It sends the request `generateText` would: the same prompt parts, the tools
 * as `function` tools, `toolChoice: auto`, the reply schema as a JSON response
 * format and the same provider options. A fake that records its calls sees
 * the same thing from both runners, which is how parity is tested.
 *
 * It never retries: the AI SDK's own retries live in `generateText`, which
 * this does not call, and every model it wraps is a fake.
 */

export interface AiSdkChatModelCallOptions extends BaseChatModelCallOptions {
  tools?: ReturnType<typeof convertToOpenAITool>[] | undefined;
  responseFormat?: { type: 'json'; schema: JSONSchema7 } | undefined;
}

export interface AiSdkChatModelSettings {
  maxOutputTokens: number;
  temperature?: number | undefined;
  providerOptions?: SharedV4ProviderOptions | undefined;
}

export class AiSdkChatModel extends BaseChatModel<AiSdkChatModelCallOptions> {
  readonly model: LanguageModelV4;
  private readonly settings: AiSdkChatModelSettings;

  constructor(model: LanguageModelV4, settings: AiSdkChatModelSettings) {
    super({});
    this.model = model;
    this.settings = settings;
  }

  _llmType(): string {
    return 'ai-sdk';
  }

  override bindTools(tools: BindToolsInput[], kwargs?: Partial<AiSdkChatModelCallOptions>) {
    return this.withConfig({
      ...kwargs,
      tools: tools.map(tool => convertToOpenAITool(tool)),
    });
  }

  async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
  ): Promise<ChatResult> {
    const call: LanguageModelV4CallOptions = {
      prompt: toPrompt(messages),
      maxOutputTokens: this.settings.maxOutputTokens,
      ...(this.settings.temperature !== undefined
        ? { temperature: this.settings.temperature }
        : {}),
      ...(options.tools && options.tools.length > 0
        ? {
            tools: options.tools.map(tool => ({
              type: 'function' as const,
              name: tool.function.name,
              ...(tool.function.description !== undefined
                ? { description: tool.function.description }
                : {}),
              inputSchema: tool.function.parameters as JSONSchema7,
            })),
          }
        : {}),
      toolChoice: { type: 'auto' },
      ...(options.responseFormat ? { responseFormat: options.responseFormat } : {}),
      ...(this.settings.providerOptions ? { providerOptions: this.settings.providerOptions } : {}),
      ...(options.signal ? { abortSignal: options.signal } : {}),
    };
    const result = await this.model.doGenerate(call);
    const message = toMessage(result.content, result.usage);
    return { generations: [{ text: textOf(message.content), message }] };
  }
}

/**
 * The usage LangChain reads, from the provider-facing shape. Each count is
 * carried on its own, so one the provider left out stays out and the rest are
 * still summed, as `generateText` sums them. Absent when no count is reported.
 */
function usageOf(usage: LanguageModelV4Usage): UsageMetadata | undefined {
  const input = usage.inputTokens.total;
  const output = usage.outputTokens.total;
  const cacheRead = usage.inputTokens.cacheRead;
  if (input === undefined && output === undefined && cacheRead === undefined) return undefined;
  // A partial count: LangChain's type wants both totals, but readers take
  // each field as optional.
  return {
    ...(input !== undefined ? { input_tokens: input } : {}),
    ...(output !== undefined ? { output_tokens: output } : {}),
    ...(input !== undefined && output !== undefined ? { total_tokens: input + output } : {}),
    ...(cacheRead !== undefined ? { input_token_details: { cache_read: cacheRead } } : {}),
  } as UsageMetadata;
}

function toMessage(content: LanguageModelV4Content[], usage: LanguageModelV4Usage): AIMessage {
  const text = content.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('');
  const toolCalls = content.flatMap(part =>
    part.type === 'tool-call'
      ? [
          {
            id: part.toolCallId,
            name: part.toolName,
            args: JSON.parse(part.input) as Record<string, unknown>,
            type: 'tool_call' as const,
          },
        ]
      : [],
  );
  const usageMetadata = usageOf(usage);
  const message = new AIMessage({ content: text, tool_calls: toolCalls });
  // The default message structure types usage as absent, though it is the
  // standard field every provider wrapper sets and LangChain reads.
  if (usageMetadata) Object.assign(message, { usage_metadata: usageMetadata });
  return message;
}

function textOf(content: MessageContent): string {
  if (typeof content === 'string') return content;
  return content.flatMap(block => (block.type === 'text' ? [String(block.text)] : [])).join('');
}

type UserPart = Extract<LanguageModelV4Message, { role: 'user' }>['content'][number];

/** A data URL's bytes, as `generateText` hands an image to the provider. */
function filePart(url: string): UserPart {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(url);
  if (!match?.[1] || match[2] === undefined) {
    throw new Error('only inline images reach the model (specs/020)');
  }
  return {
    type: 'file',
    mediaType: match[1],
    data: { type: 'data', data: new Uint8Array(Buffer.from(match[2], 'base64')) },
  };
}

function userParts(content: MessageContent): UserPart[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content.map(block => {
    if (block.type === 'text') return { type: 'text', text: String(block.text) };
    if (block.type === 'image_url') {
      const imageUrl = block.image_url as string | { url: string };
      return filePart(typeof imageUrl === 'string' ? imageUrl : imageUrl.url);
    }
    throw new Error(`unsupported content block: ${block.type}`);
  });
}

/** LangChain's messages as the provider prompt `generateText` builds from the same turn. */
export function toPrompt(messages: BaseMessage[]): LanguageModelV4Prompt {
  const prompt: LanguageModelV4Prompt = [];
  for (const message of messages) {
    const type = message.type;
    if (type === 'system') {
      prompt.push({ role: 'system', content: textOf(message.content) });
    } else if (type === 'human') {
      prompt.push({ role: 'user', content: userParts(message.content) });
    } else if (type === 'ai') {
      const ai = message as AIMessage;
      const texts =
        typeof ai.content === 'string'
          ? ai.content.length > 0
            ? [ai.content]
            : []
          : ai.content.flatMap(block => (block.type === 'text' ? [String(block.text)] : []));
      prompt.push({
        role: 'assistant',
        content: [
          ...texts.map(text => ({ type: 'text' as const, text })),
          ...(ai.tool_calls ?? []).map(call => ({
            type: 'tool-call' as const,
            toolCallId: call.id ?? '',
            toolName: call.name,
            input: call.args,
          })),
        ],
      });
    } else if (type === 'tool') {
      const tool = message as BaseMessage & {
        tool_call_id: string;
        name?: string;
        status?: 'success' | 'error';
      };
      const text = textOf(tool.content);
      const part = {
        type: 'tool-result' as const,
        toolCallId: tool.tool_call_id,
        toolName: tool.name ?? '',
        output:
          tool.status === 'error'
            ? { type: 'error-text' as const, value: text }
            : { type: 'json' as const, value: JSON.parse(text) as JSONValue },
      };
      // One tool message per step, as `generateText` groups a step's results.
      const last = prompt.at(-1);
      if (last?.role === 'tool') last.content.push(part);
      else prompt.push({ role: 'tool', content: [part] });
    } else {
      throw new Error(`unsupported message type: ${type}`);
    }
  }
  return prompt;
}

/** The provider options `generateText` is called with: Anthropic's cache breakpoint, and OpenAI's reasoning effort when set. */
export function aiSdkProviderOptions(
  reasoningEffort: 'minimal' | 'low' | 'medium' | 'high' | undefined,
): SharedV4ProviderOptions {
  return {
    anthropic: { cacheControl: { type: 'ephemeral' } },
    ...(reasoningEffort ? { openai: { reasoningEffort } } : {}),
  };
}
