import { describe, it, expect } from 'vitest';
import { renderManyChat, ManyChatAdapter } from '../../src/channels/manychat/adapter.ts';
import { capabilitiesFor } from '../../src/contracts/config.ts';
import type { AgentReply } from '../../src/contracts/agent.ts';

const reply: AgentReply = {
  messages: ['Hi!', 'The foundation course is $450.00.'],
  escalate: false,
  escalation_reason: null,
  confidence: 0.9,
  closing_question: null,
};

describe('Dynamic Block v2 rendering', () => {
  it('produces a valid v2 envelope', () => {
    const out = renderManyChat(reply, { capabilities: capabilitiesFor('messenger') });
    expect(out.version).toBe('v2');
    expect(out.content.messages).toHaveLength(2);
    expect(out.content.messages[0]).toEqual({ type: 'text', text: 'Hi!' });
  });

  it('joins a multi-message reply into one on WhatsApp instead of dropping the rest', () => {
    // specs/002 § Channel capability matrix: ManyChat accepts a ten-message
    // array on WhatsApp and delivers only the first. Rendering all of them sent
    // contacts an opening line with the prices it promised silently discarded.
    const out = renderManyChat(reply, { capabilities: capabilitiesFor('whatsapp') });
    expect(out.content.messages).toHaveLength(1);
    expect(out.content.messages[0]).toEqual({
      type: 'text',
      text: 'Hi!\n\nThe foundation course is $450.00.',
    });
  });

  it('OMITS quick_replies on WhatsApp rather than sending an empty array', () => {
    // specs/002: ManyChat accepts quick_replies on WhatsApp and the contact
    // never sees them. Absence is the contract, not emptiness.
    const out = renderManyChat(reply, { capabilities: capabilitiesFor('whatsapp') });
    expect('quick_replies' in out.content).toBe(false);
  });

  it('respects each channel capability profile', () => {
    expect(capabilitiesFor('whatsapp').supportsQuickReplies).toBe(false);
    expect(capabilitiesFor('telegram').supportsQuickReplies).toBe(false);
    expect(capabilitiesFor('instagram').supportsQuickReplies).toBe(true);
    expect(capabilitiesFor('whatsapp').maxButtonsPerMessage).toBe(3);
    expect(capabilitiesFor('telegram').maxButtonsPerMessage).toBe(10);
  });

  it('rejects an unknown channel loudly', () => {
    expect(() => capabilitiesFor('carrier-pigeon')).toThrow(/Unknown channel/);
  });

  it('clamps to the platform message ceiling without losing any content', () => {
    // The ceiling bounds how many messages are sent, never how much is said:
    // anything past it is folded into the last one. Dropping the overflow is
    // how a reply reached a contact missing everything after its first line.
    const many = {
      ...reply,
      messages: Array.from({ length: 12 }, (_unused, index) => `m${index}`),
    };
    for (const channel of ['whatsapp', 'messenger']) {
      const out = renderManyChat(many, { capabilities: capabilitiesFor(channel) });
      expect(out.content.messages.length).toBeLessThanOrEqual(capabilitiesFor(channel).maxMessages);
      const rendered = out.content.messages.map(message => ('text' in message ? message.text : ''));
      for (const original of many.messages) {
        expect(rendered.some(text => text.includes(original))).toBe(true);
      }
    }
  });

  it('registers external_message_callback so the loop stays server-side', () => {
    const out = renderManyChat(reply, {
      capabilities: capabilitiesFor('whatsapp'),
      callbackUrl: 'https://agent.example.com/v1/channels/manychat/message',
      callbackSecret: 'shhh',
      callbackTimeoutSeconds: 3600,
    });
    const cb = out.content.external_message_callback!;
    expect(cb.method).toBe('post');
    expect(cb.timeout).toBe(3600);
    expect(cb.headers?.Authorization).toBe('Bearer shhh');
    expect(cb.payload?.text).toBe('{{last_input_text}}');
  });

  it('refuses a non-HTTPS callback url', () => {
    expect(() =>
      renderManyChat(reply, {
        capabilities: capabilitiesFor('whatsapp'),
        callbackUrl: 'http://insecure.example.com/hook',
      }),
    ).toThrow();
  });
});

describe('inbound parsing', () => {
  const adapter = new ManyChatAdapter({ sendText: async () => {} });
  const ctx = { tenantId: 'demo', channel: 'whatsapp' };

  it('normalizes a ManyChat payload', () => {
    const inbound = adapter.parse(
      { subscriber_id: 998, text: 'hello', first_name: 'Ana', last_name: 'Diaz', locale: 'es_AR' },
      ctx,
    );
    expect(inbound.subscriberId).toBe('998');
    expect(inbound.contactName).toBe('Ana Diaz');
    expect(inbound.tenantId).toBe('demo');
    expect(inbound.channel).toBe('whatsapp');
  });

  it('leaves contactName null when absent', () => {
    expect(adapter.parse({ subscriber_id: '1', text: 'hi' }, ctx).contactName).toBeNull();
  });

  it('rejects unknown fields (strict)', () => {
    expect(() => adapter.parse({ subscriber_id: '1', text: 'hi', evil: 1 }, ctx)).toThrow();
  });

  it('rejects a payload with no subscriber id', () => {
    expect(() => adapter.parse({ text: 'hi' }, ctx)).toThrow();
  });
});
