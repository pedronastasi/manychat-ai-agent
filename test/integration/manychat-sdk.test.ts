import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDatabase } from '../helpers/db.ts';
import { fakeManyChatApi, manychatAnswer, neverAnswers } from '../helpers/manychat.ts';
import type { Database } from '../../src/db/client.ts';
import { buildServer } from '../../src/server.ts';
import { loadEnv, ConfigStore } from '../../src/config/loader.ts';
import { manychatClientFor } from '../../src/channels/manychat/client.ts';
import type { ManyChatClient } from '../../src/channels/manychat/client.ts';
import { OutboxQueue } from '../../src/outbox/queue.ts';
import { OutboxWorker } from '../../src/outbox/worker.ts';
import type { AgentRunner } from '../../src/agent/runner.ts';

/**
 * specs/022-manychat-sdk.md § Verification. ManyChat is faked at its HTTP
 * boundary and the client is the one `main.ts` builds, so every failure here
 * reaches the worker the way it does in production: through the SDK.
 */

const baseEnv = {
  AGENT_MODEL: 'anthropic:claude-haiku-4-5',
  PUBLIC_BASE_URL: 'https://agent.example.com',
  MANYCHAT_SHARED_SECRET: 'a'.repeat(32),
  MANYCHAT_API_TOKEN: 'tok',
  MANYCHAT_REPLY_FLOW_NS: 'content20260101000000_000001',
  DATABASE_URL: 'postgres://unused',
  CHANNEL: 'whatsapp',
  TENANT_ID: 'demo',
  LOG_LEVEL: 'error',
};

let db: Database;
let close: () => Promise<void>;
let api: ReturnType<typeof fakeManyChatApi>;

beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
  api = fakeManyChatApi();
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await close();
});

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

const enqueue = () =>
  new OutboxQueue(db).enqueue({
    tenantId: 'demo',
    subscriberId: '5550001234987',
    conversationId: null,
    reply: {
      messages: ['Classes start on the first Monday of the month.'],
      escalate: false,
      escalation_reason: null,
      confidence: 0.9,
      closing_question: null,
    },
  });

const rowById = async (id: string) => {
  const raw: unknown = await db.execute(
    sql`SELECT status, attempts, last_error, next_attempt_at FROM outbox WHERE id = ${id}`,
  );
  const rows = Array.isArray(raw) ? raw : ((raw as { rows: unknown[] }).rows ?? []);
  return rows[0] as {
    status: string;
    attempts: number;
    last_error: string | null;
    next_attempt_at: string;
  };
};

const drain = (client: ManyChatClient) =>
  new OutboxWorker({ db, client, logger: silentLogger }).drainOnce();

describe('specs/022 § One instance per process, at 10 requests a second in bursts of 5', () => {
  it('sends five requests at once and holds the sixth for the refill', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const start = Date.now();
    const sentAt: number[] = [];
    // The factory main.ts calls once and hands to both the server and the
    // worker, so this limiter is the whole process's.
    const shared = manychatClientFor(loadEnv(baseEnv), () => {
      sentAt.push(Date.now() - start);
      return Promise.resolve(manychatAnswer());
    });

    const writes = Promise.all(
      Array.from({ length: 6 }, (_slot, index) =>
        shared.writeToken(`subscriber-${index}`, 'token'),
      ),
    );
    await vi.advanceTimersByTimeAsync(1000);
    await writes;

    expect(sentAt).toEqual([0, 0, 0, 0, 0, 100]);
  });
});

describe('specs/022 § Every call is abandoned after 10 seconds, and a timed-out send is retried', () => {
  it('fails a reply send ManyChat never answers, and reschedules the row', async () => {
    // The SDK bounds each call with AbortSignal.timeout, which fake timers do
    // not reach. The bound it asks for is recorded, and the signal it gets
    // fires at once, so the test does not wait the ten seconds out.
    const requested: number[] = [];
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      requested.push(ms);
      return timeout(10);
    });
    api.state.respond = neverAnswers;

    const id = await enqueue();
    const result = await drain(manychatClientFor(loadEnv(baseEnv), api.fetch));

    expect(requested).toEqual([10_000]);
    expect(result).toMatchObject({ retrying: 1, deadLettered: 0 });
    const row = await rowById(id);
    expect(row.status).toBe('pending');
    expect(row.last_error).toMatch(/timeout/);
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
    // The field write hung, so the flow that would render it was never sent.
    expect(api.calls.map(call => call.path)).toEqual(['/fb/subscriber/setCustomFieldByName']);
  });
});

describe("specs/022 § Retries follow the SDK's retryable, not instanceof", () => {
  const error = (message: string) => JSON.stringify({ status: 'error', message });

  it.each([
    {
      failure: 'ManyChat answered 429',
      respond: () => Promise.resolve(manychatAnswer(429, error('Too many requests'))),
      retried: true,
    },
    {
      failure: 'ManyChat answered 5xx',
      respond: () => Promise.resolve(manychatAnswer(503, 'Service Unavailable')),
      retried: true,
    },
    {
      failure: 'no connection',
      respond: () => Promise.reject(new TypeError('fetch failed')),
      retried: true,
    },
    {
      failure: 'ManyChat answered another 4xx',
      respond: () => Promise.resolve(manychatAnswer(400, error('Field not found'))),
      retried: false,
    },
    {
      failure: 'ManyChat answered 2xx with "status": "error"',
      respond: () => Promise.resolve(manychatAnswer(200, error('Subscriber does not exist'))),
      retried: false,
    },
    {
      failure: 'ManyChat answered 2xx with a body that is not JSON',
      respond: () => Promise.resolve(manychatAnswer(200, '<html>OK</html>')),
      retried: false,
    },
  ])('$failure: retried $retried', async ({ respond, retried }) => {
    api.state.respond = respond;
    const id = await enqueue();
    const result = await drain(manychatClientFor(loadEnv(baseEnv), api.fetch));

    expect(result).toMatchObject(
      retried ? { retrying: 1, deadLettered: 0 } : { retrying: 0, deadLettered: 1 },
    );
    expect((await rowById(id)).status).toBe(retried ? 'pending' : 'failed');
  });

  it('retries an error that is not a ManyChatError, such as the database', async () => {
    const id = await enqueue();
    const result = await drain({
      sendText: () => Promise.reject(new Error('Connection terminated unexpectedly')),
      writeToken: () => Promise.resolve(),
      performAction: () => Promise.resolve(),
    });
    expect(result).toMatchObject({ retrying: 1, deadLettered: 0 });
    expect((await rowById(id)).status).toBe('pending');
  });

  it('delivers when ManyChat answers with its success body', async () => {
    const id = await enqueue();
    const result = await drain(manychatClientFor(loadEnv(baseEnv), api.fetch));
    expect(result).toMatchObject({ delivered: 1 });
    expect((await rowById(id)).status).toBe('delivered');
  });
});

describe('specs/022 § One instance per process: without MANYCHAT_API_TOKEN', () => {
  const runner: AgentRunner = { run: () => Promise.reject(new Error('not called')) };
  const withoutToken = Object.fromEntries(
    Object.entries(baseEnv).filter(([name]) => name !== 'MANYCHAT_API_TOKEN'),
  );

  it('boots the server', async () => {
    const { app } = await buildServer({
      env: loadEnv(withoutToken),
      db,
      configStore: new ConfigStore('test/fixtures/config'),
      runner,
    });
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    await app.close();
  });

  it('fails a deferred send loudly, and keeps the reply to retry', async () => {
    const id = await enqueue();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await new OutboxWorker({
      db,
      client: manychatClientFor(loadEnv(withoutToken)),
      logger,
    }).drainOnce();

    expect(result).toMatchObject({ delivered: 0, retrying: 1 });
    expect((await rowById(id)).last_error).toMatch(/MANYCHAT_API_TOKEN is not set/);
    expect(logger.warn).toHaveBeenCalledWith(expect.anything(), 'outbox delivery retrying');
  });
});
