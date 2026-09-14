import { describe, it, expect, vi } from 'vitest';
import { renderManyChat, createManyChatAdapter } from '../../src/channels/manychat/adapter.ts';
import { createManyChatClient, ManyChatApiError } from '../../src/channels/manychat/client.ts';
import { capabilitiesFor } from '../../src/contracts/config.ts';
import type { AgentReply } from '../../src/contracts/agent.ts';

const reply: AgentReply = {
  messages: ['Hola!', 'El curso sale $45.000.'],
  escalate: false,
  escalation_reason: null,
  confidence: 0.9,
};

describe('Dynamic Block v2 rendering', () => {
  it('produces a valid v2 envelope', () => {
    const out = renderManyChat(reply, { capabilities: capabilitiesFor('whatsapp') });
    expect(out.version).toBe('v2');
    expect(out.content.messages).toHaveLength(2);
    expect(out.content.messages[0]).toEqual({ type: 'text', text: 'Hola!' });
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

  it('clamps to the platform message ceiling', () => {
    const many = { ...reply, messages: Array.from({ length: 12 }, (_, i) => `m${i}`) };
    const out = renderManyChat(many, { capabilities: capabilitiesFor('whatsapp') });
    expect(out.content.messages.length).toBeLessThanOrEqual(10);
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
  const adapter = createManyChatAdapter({ sendText: async () => {} });
  const ctx = { tenantId: 'demo', channel: 'whatsapp' };

  it('normalizes a ManyChat payload', () => {
    const m = adapter.parse(
      { subscriber_id: 998, text: 'hola', first_name: 'Ana', last_name: 'Diaz', locale: 'es_AR' },
      ctx,
    );
    expect(m.subscriberId).toBe('998');
    expect(m.contactName).toBe('Ana Diaz');
    expect(m.tenantId).toBe('demo');
    expect(m.channel).toBe('whatsapp');
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

describe('Send API client', () => {
  it('sends one request per message, in order, with bearer auth', async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push(JSON.parse(String(init!.body)).data.content.messages[0].text);
      return new Response('{"status":"success"}', { status: 200 });
    }) as unknown as typeof fetch;

    const client = createManyChatClient({ apiToken: 't0ken', fetchImpl, requestsPerSecond: 1000 });
    await client.sendText('s1', ['uno', 'dos']);

    expect(seen).toEqual(['uno', 'dos']);
    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer t0ken');
  });

  it('marks 5xx retryable and 4xx terminal', async () => {
    const mk = (status: number) =>
      createManyChatClient({
        apiToken: 't',
        requestsPerSecond: 1000,
        fetchImpl: async () => new Response('err', { status }),
      });
    await expect(mk(500).sendText('s', ['x'])).rejects.toMatchObject({ retryable: true });
    await expect(mk(429).sendText('s', ['x'])).rejects.toMatchObject({ retryable: true });
    await expect(mk(400).sendText('s', ['x'])).rejects.toMatchObject({ retryable: false });
    await expect(mk(400).sendText('s', ['x'])).rejects.toBeInstanceOf(ManyChatApiError);
  });
});
