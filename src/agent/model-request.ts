import type { AIMessage, BaseMessage, MessageContent } from '@langchain/core/messages';

/**
 * A model call as a provider receives it: the turn's LangChain.js messages as
 * role-tagged entries of parts, and the tools offered with their JSON schemas.
 * The `mock:` model decides from it, and the test fakes record it, so both read
 * one shape whatever LangChain's message classes hold (specs/053 § The mock and
 * every fake are LangChain chat models). It is the shape the AI SDK's provider
 * prompt had, so what was asserted of a call before reads the same now.
 */

/** One part of a message, as a model call holds it. */
export type ModelPart =
  | { type: 'text'; text: string }
  | { type: 'file'; mediaType: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: Record<string, unknown> }
  | {
      type: 'tool-result';
      toolCallId: string;
      toolName: string;
      output: { type: 'json'; value: unknown } | { type: 'error-text'; value: string };
    };

export type ModelEntry =
  | { role: 'system'; content: string }
  | { role: 'user' | 'assistant' | 'tool'; content: ModelPart[] };

export interface ModelTool {
  type: 'function';
  name: string;
  description?: string | undefined;
  inputSchema: { properties?: Record<string, unknown> };
}

/** A turn as a model call holds it: the messages in order, and the tools offered. */
export interface ModelRequest {
  prompt: ModelEntry[];
  tools?: ModelTool[] | undefined;
}

export function textOf(content: MessageContent): string {
  if (typeof content === 'string') return content;
  return content.flatMap(block => (block.type === 'text' ? [String(block.text)] : [])).join('');
}

/** An inline image, by its media type: a call records that an image came, never its bytes. */
function imagePart(url: string): ModelPart {
  const match = /^data:([^;]+);base64,/.exec(url);
  if (!match?.[1]) throw new Error('only inline images reach the model (specs/020)');
  return { type: 'file', mediaType: match[1] };
}

function userParts(content: MessageContent): ModelPart[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content.map(block => {
    if (block.type === 'text') return { type: 'text', text: String(block.text) };
    if (block.type === 'image_url') {
      const imageUrl = block.image_url as string | { url: string };
      return imagePart(typeof imageUrl === 'string' ? imageUrl : imageUrl.url);
    }
    throw new Error(`unsupported content block: ${block.type}`);
  });
}

/**
 * The turn's LangChain messages as a provider receives them: a system entry, the
 * user's parts, the model's text and tool calls, and one tool entry per step
 * holding its results, as a provider receives them.
 */
export function modelRequestOf(
  messages: BaseMessage[],
  tools: ModelTool[] | undefined,
): ModelRequest {
  const prompt: ModelEntry[] = [];
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
      const part: ModelPart = {
        type: 'tool-result',
        toolCallId: tool.tool_call_id,
        toolName: tool.name ?? '',
        output:
          tool.status === 'error'
            ? { type: 'error-text', value: text }
            : { type: 'json', value: JSON.parse(text) as unknown },
      };
      const last = prompt.at(-1);
      if (last?.role === 'tool') last.content.push(part);
      else prompt.push({ role: 'tool', content: [part] });
    } else {
      throw new Error(`unsupported message type: ${type}`);
    }
  }
  return { prompt, tools };
}
