import {
  ManyChatInbound,
  ManyChatResponse,
  type ManyChatMessage,
} from '../../contracts/manychat.ts';
import type { AgentReply, InboundMessage } from '../../contracts/agent.ts';
import type { ChannelAdapter, RenderContext } from '../port.ts';
import type { ManyChatClient } from './client.ts';

/**
 * Renders an AgentReply as a Dynamic Block v2 body.
 *
 * The capability checks are the whole point (ADR-0005): on WhatsApp, ManyChat
 * accepts a payload containing `quick_replies` and the contact simply never sees
 * them. The key must be absent, not empty.
 */
export function renderManyChat(reply: AgentReply, ctx: RenderContext): ManyChatResponse {
  const caps = ctx.capabilities;

  // Overflow is folded into the last message, never dropped. Slicing it away
  // silently delivered a reply's opening line and discarded everything after
  // it: contacts got "here are the two options:" and no options, because
  // WhatsApp renders one message per Dynamic Block response. A reply that does
  // not fit is a formatting problem, not a licence to lose half of it.
  const head = reply.messages.slice(0, caps.maxMessages - 1);
  const tail = reply.messages.slice(caps.maxMessages - 1);
  const texts = tail.length > 0 ? [...head, tail.join('\n\n')] : head;

  const messages: ManyChatMessage[] = texts.map(text => ({ type: 'text' as const, text }));

  const content: ManyChatResponse['content'] = { messages };

  if (ctx.callbackUrl) {
    content.external_message_callback = {
      url: ctx.callbackUrl,
      method: 'post',
      ...(ctx.callbackSecret ? { headers: { Authorization: `Bearer ${ctx.callbackSecret}` } } : {}),
      // ManyChat substitutes the contact's next message into this field.
      payload: { text: '{{last_input_text}}', subscriber_id: '{{contact.id}}' },
      timeout: ctx.callbackTimeoutSeconds ?? 86_400,
    };
  }

  // Validated on the way out so a renderer bug surfaces here rather than as a
  // silently malformed message to a customer (Constitution C3).
  return ManyChatResponse.parse({ version: 'v2', content });
}

export class ManyChatAdapter implements ChannelAdapter<unknown, ManyChatResponse> {
  readonly name = 'manychat';

  private readonly client: ManyChatClient;

  constructor(client: ManyChatClient) {
    this.client = client;
  }

  parse(raw: unknown, ctx: { tenantId: string; channel: string }): InboundMessage {
    const parsed = ManyChatInbound.parse(raw);
    const name = [parsed.first_name, parsed.last_name].filter(Boolean).join(' ').trim();
    return {
      tenantId: ctx.tenantId,
      subscriberId: parsed.subscriber_id,
      text: parsed.text,
      channel: parsed.channel ?? ctx.channel,
      contactName: name.length > 0 ? name : null,
      locale: parsed.locale ?? null,
      receivedAt: new Date(),
    };
  }

  render(reply: AgentReply, ctx: RenderContext): ManyChatResponse {
    return renderManyChat(reply, ctx);
  }

  async push(to: { subscriberId: string }, reply: AgentReply): Promise<void> {
    await this.client.sendText(to.subscriberId, reply.messages);
  }
}
