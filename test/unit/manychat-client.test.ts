import { describe, it, expect } from 'vitest';
import { ManyChatHttpClient, ManyChatApiError } from '../../src/channels/manychat/client.ts';

/**
 * specs/002-channel-contract.md § Deferred delivery goes through a flow,
 * § The reply field is per-subscriber, never a bot field, and
 * § The two calls are one delivery.
 *
 * The outbox suite stubs `ManyChatClient` at the port, so nothing there sees the
 * wire format. A stale field in this body (`message_tag`, which ManyChat stopped
 * accepting) once failed every deferred delivery while the suite stayed green.
 */

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function clientCapturing(
  calls: Call[],
  response: { ok: boolean; status: number; text?: string } = { ok: true, status: 200 },
) {
  const fetchImpl = ((url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({
      url,
      headers: init.headers,
      body: JSON.parse(init.body) as Record<string, unknown>,
    });
    return Promise.resolve({
      ok: response.ok,
      status: response.status,
      text: () => Promise.resolve(response.text ?? ''),
    });
  }) as unknown as typeof fetch;

  return new ManyChatHttpClient({
    apiToken: 'tok',
    replyField: 'ai_message',
    replyFlowNs: 'content123_456',
    requestsPerSecond: 1000,
    fetchImpl,
  });
}

describe('deferred delivery', () => {
  it('writes the reply to a custom field, then triggers the flow', async () => {
    const calls: Call[] = [];
    await clientCapturing(calls).sendText('123', ['hello']);

    expect(calls.map(call => call.url)).toEqual([
      'https://api.manychat.com/fb/subscriber/setCustomFieldByName',
      'https://api.manychat.com/fb/sending/sendFlow',
    ]);
    expect(calls[0]!.body).toEqual({
      subscriber_id: '123',
      field_name: 'ai_message',
      field_value: 'hello',
    });
    expect(calls[1]!.body).toEqual({ subscriber_id: '123', flow_ns: 'content123_456' });
    expect(calls[0]!.headers.Authorization).toBe('Bearer tok');
  });

  it('never writes to the account-global bot-field endpoint', async () => {
    // specs/002 § The reply field is per-subscriber. The two endpoints accept
    // near-identical bodies, so the URL is the only thing separating a safe
    // write from one that delivers a contact's reply to a different contact
    // (Constitution C5). Asserted on the path for exactly that reason.
    const calls: Call[] = [];
    await clientCapturing(calls).sendText('123', ['hello']);
    expect(calls.some(call => call.url.includes('/fb/page/'))).toBe(false);
    expect(calls.every(call => 'subscriber_id' in call.body)).toBe(true);
  });

  it('sends no message_tag', async () => {
    // ManyChat rejects it: "Message tags are no longer supported".
    const calls: Call[] = [];
    await clientCapturing(calls).sendText('123', ['hello']);
    expect(calls.some(call => 'message_tag' in call.body)).toBe(false);
  });

  it('pairs a field write with every trigger, per message, in order', async () => {
    const calls: Call[] = [];
    await clientCapturing(calls).sendText('123', ['first', 'second']);

    // Four calls, strictly alternating: a flow that fires twice against one
    // field write would deliver the same message twice.
    expect(calls).toHaveLength(4);
    expect(calls.map(call => (call.url.includes('sendFlow') ? 'flow' : 'field'))).toEqual([
      'field',
      'flow',
      'field',
      'flow',
    ]);
    expect(
      calls.filter(call => call.url.includes('setCustomField')).map(call => call.body.field_value),
    ).toEqual(['first', 'second']);
  });

  it('carries each subscriber its own text when used concurrently', async () => {
    // The failure this guards against is one contact receiving another's reply.
    const calls: Call[] = [];
    const client = clientCapturing(calls);
    await Promise.all([client.sendText('aaa', ['for A']), client.sendText('bbb', ['for B'])]);

    const writes = calls.filter(call => call.url.includes('setCustomField'));
    expect(writes).toHaveLength(2);
    for (const write of writes) {
      const expected = write.body.subscriber_id === 'aaa' ? 'for A' : 'for B';
      expect(write.body.field_value).toBe(expected);
    }
  });

  it('does not trigger the flow when the field write fails', async () => {
    // Triggering anyway would render whatever the field happens to hold, which
    // after an intervening turn is the previous reply.
    const calls: Call[] = [];
    const client = clientCapturing(calls, { ok: false, status: 400, text: 'no such field' });
    await expect(client.sendText('123', ['hello'])).rejects.toThrow(ManyChatApiError);
    expect(calls.some(call => call.url.includes('sendFlow'))).toBe(false);
  });

  it('marks 5xx and 429 retryable, other 4xx not', async () => {
    await expect(
      clientCapturing([], { ok: false, status: 503, text: 'upstream' }).sendText('123', ['x']),
    ).rejects.toMatchObject({ retryable: true });
    await expect(
      clientCapturing([], { ok: false, status: 429, text: 'slow down' }).sendText('123', ['x']),
    ).rejects.toMatchObject({ retryable: true });
    await expect(
      clientCapturing([], { ok: false, status: 400, text: 'Validation error' }).sendText('123', [
        'x',
      ]),
    ).rejects.toMatchObject({ retryable: false });
  });

  it('carries the status and body on the error, so a dead letter says why', async () => {
    const failing = clientCapturing([], { ok: false, status: 400, text: 'flow_ns not found' });
    await expect(failing.sendText('123', ['x'])).rejects.toThrow(/400/);
    await expect(failing.sendText('123', ['x'])).rejects.toThrow(/flow_ns not found/);
  });

  it('honours a configured base url without doubling the slash', async () => {
    const calls: Call[] = [];
    const client = new ManyChatHttpClient({
      apiToken: 'tok',
      baseUrl: 'https://proxy.example.com/',
      replyField: 'ai_message',
      replyFlowNs: 'flow',
      requestsPerSecond: 1000,
      fetchImpl: ((url: string, init: { headers: Record<string, string>; body: string }) => {
        calls.push({
          url,
          headers: init.headers,
          body: JSON.parse(init.body) as Record<string, unknown>,
        });
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('') });
      }) as unknown as typeof fetch,
    });
    await client.sendText('123', ['hello']);
    expect(calls[0]!.url).toBe('https://proxy.example.com/fb/subscriber/setCustomFieldByName');
  });
});
