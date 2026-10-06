import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ManyChatHttpClient, ManyChatApiError } from '../../src/channels/manychat/client.ts';
import { manychatAnswer } from '../helpers/manychat.ts';
import { loadEnv } from '../../src/config/loader.ts';

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

function clientCapturing(calls: Call[], response?: { status: number; text: string }) {
  const fetchImpl = ((url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({
      url,
      headers: init.headers,
      body: JSON.parse(init.body) as Record<string, unknown>,
    });
    return Promise.resolve(
      response ? manychatAnswer(response.status, response.text) : manychatAnswer(),
    );
  }) as unknown as typeof fetch;

  return new ManyChatHttpClient({
    apiToken: 'tok',
    baseUrl: 'https://api.manychat.com',
    replyField: 'ai_message',
    replyFlowNs: 'content123_456',
    tokenField: 'ai_token',
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
    const client = clientCapturing(calls, { status: 400, text: 'no such field' });
    await expect(client.sendText('123', ['hello'])).rejects.toThrow(ManyChatApiError);
    expect(calls.some(call => call.url.includes('sendFlow'))).toBe(false);
  });

  it('marks 5xx and 429 retryable, other 4xx not', async () => {
    await expect(
      clientCapturing([], { status: 503, text: 'upstream' }).sendText('123', ['x']),
    ).rejects.toMatchObject({ retryable: true });
    await expect(
      clientCapturing([], { status: 429, text: 'slow down' }).sendText('123', ['x']),
    ).rejects.toMatchObject({ retryable: true });
    await expect(
      clientCapturing([], { status: 400, text: 'Validation error' }).sendText('123', ['x']),
    ).rejects.toMatchObject({ retryable: false });
  });

  it('carries the status and body on the error, so a dead letter says why', async () => {
    const failing = clientCapturing([], { status: 400, text: 'flow_ns not found' });
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
      tokenField: 'ai_token',
      fetchImpl: ((url: string, init: { headers: Record<string, string>; body: string }) => {
        calls.push({
          url,
          headers: init.headers,
          body: JSON.parse(init.body) as Record<string, unknown>,
        });
        return Promise.resolve(manychatAnswer());
      }) as unknown as typeof fetch,
    });
    await client.sendText('123', ['hello']);
    expect(calls[0]!.url).toBe('https://proxy.example.com/fb/subscriber/setCustomFieldByName');
  });
});

describe("specs/019 § Each contact's token lives in ManyChat, never in a response", () => {
  it("writes the token to the contact's own field through the per-subscriber endpoint", async () => {
    const calls: Call[] = [];
    await clientCapturing(calls).writeToken('123', 'the-token');
    expect(calls).toEqual([
      {
        url: 'https://api.manychat.com/fb/subscriber/setCustomFieldByName',
        headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
        body: { subscriber_id: '123', field_name: 'ai_token', field_value: 'the-token' },
      },
    ]);
  });

  it('throws on a refused write, so the outbox retries it', async () => {
    const failing = clientCapturing([], { status: 503, text: 'down' });
    await expect(failing.writeToken('123', 'the-token')).rejects.toMatchObject({
      status: 503,
      retryable: true,
    });
  });
});

describe('specs/022 § The SDK sits behind the ManyChatClient port, and only client.ts imports it', () => {
  it('is imported by no file under src/ but the client', () => {
    // `page.setBotField` sits beside `subscriber.setCustomFieldByName` in the
    // SDK, and choosing between them decides whether one contact's reply can
    // reach another. Keeping the import in one file keeps that choice in view.
    const importers = readdirSync('src', { recursive: true, encoding: 'utf8' })
      .filter(path => path.endsWith('.ts'))
      .filter(path =>
        /(?:from\s+|import\s*\(\s*|import\s+)['"]manychat-sdk['"]/.test(
          readFileSync(join('src', path), 'utf8'),
        ),
      );
    expect(importers).toEqual([join('channels', 'manychat', 'client.ts')]);
  });
});

describe('specs/002 § Messages to one contact are paced', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const GAP = 2_000;

  /** Each field write as [subscriber, text, ms since start], with failures on demand. */
  function pacedClient(fail: (text: string) => boolean = () => false) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const start = Date.now();
    const writes: [string, unknown, number][] = [];
    const fetchImpl = ((url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      if (url.includes('setCustomField')) {
        writes.push([body.subscriber_id as string, body.field_value, Date.now() - start]);
        if (fail(body.field_value as string)) return Promise.resolve(manychatAnswer(400, 'bad'));
      }
      return Promise.resolve(manychatAnswer());
    }) as unknown as typeof fetch;
    const client = new ManyChatHttpClient({
      apiToken: 'tok',
      baseUrl: 'https://api.manychat.com',
      replyField: 'ai_message',
      replyFlowNs: 'content123_456',
      tokenField: 'ai_token',
      replyGapMs: GAP,
      fetchImpl,
    });
    return { client, writes };
  }

  it('waits the gap before each message after the first', async () => {
    // A flow reads the field when its message step runs. Written sooner, the
    // next message would be what the previous flow renders.
    const { client, writes } = pacedClient();
    const sent = client.sendText('123', ['one', 'two', 'three']);
    await vi.advanceTimersByTimeAsync(2 * GAP);
    await sent;
    expect(writes).toEqual([
      ['123', 'one', 0],
      ['123', 'two', GAP],
      ['123', 'three', 2 * GAP],
    ]);
  });

  it("holds a contact's next reply for the gap, and not the caller of the first", async () => {
    const { client, writes } = pacedClient();
    let firstDone = false;
    const first = client.sendText('123', ['first reply']).then(() => (firstDone = true));
    const second = client.sendText('123', ['second reply']);
    await vi.advanceTimersByTimeAsync(0);
    expect(firstDone).toBe(true);
    await vi.advanceTimersByTimeAsync(GAP);
    await Promise.all([first, second]);
    expect(writes).toEqual([
      ['123', 'first reply', 0],
      ['123', 'second reply', GAP],
    ]);
  });

  it('never holds one contact for another', async () => {
    const { client, writes } = pacedClient();
    const sends = Promise.all([
      client.sendText('aaa', ['for A', 'more for A']),
      client.sendText('bbb', ['for B']),
    ]);
    await vi.advanceTimersByTimeAsync(GAP);
    await sends;
    expect(writes).toContainEqual(['bbb', 'for B', 0]);
    expect(writes).toContainEqual(['aaa', 'more for A', GAP]);
  });

  it('paces the next reply after a failed one, rather than blocking it', async () => {
    const { client, writes } = pacedClient(text => text === 'fails');
    const failed = client.sendText('123', ['fails']);
    const next = client.sendText('123', ['next']);
    await expect(failed).rejects.toThrow(ManyChatApiError);
    await vi.advanceTimersByTimeAsync(GAP);
    await next;
    expect(writes).toEqual([
      ['123', 'fails', 0],
      ['123', 'next', GAP],
    ]);
  });

  it('waits two seconds by default, and at most ten', () => {
    const base = {
      AGENT_MODEL: 'mock:demo',
      PUBLIC_BASE_URL: 'https://x.com',
      MANYCHAT_SHARED_SECRET: 'a'.repeat(32),
      DATABASE_URL: 'pglite',
    };
    expect(loadEnv(base).MANYCHAT_REPLY_GAP_MS).toBe(2_000);
    expect(loadEnv({ ...base, MANYCHAT_REPLY_GAP_MS: '0' }).MANYCHAT_REPLY_GAP_MS).toBe(0);
    expect(() => loadEnv({ ...base, MANYCHAT_REPLY_GAP_MS: '10001' })).toThrow();
  });

  it('sends back to back when no gap is configured', async () => {
    const calls: Call[] = [];
    await clientCapturing(calls).sendText('123', ['first', 'second']);
    expect(calls).toHaveLength(4);
  });
});
