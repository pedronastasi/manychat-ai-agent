import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../../src/server.ts';
import { createTestDatabase } from '../helpers/db.ts';
import type { Database } from '../../src/db/client.ts';
import { loadEnv, ConfigStore } from '../../src/config/loader.ts';
import type { AgentRunner, AgentResult } from '../../src/agent/runner.ts';
import { claimBatch } from '../../src/outbox/queue.ts';
import { readFileSync } from 'node:fs';

/** The acknowledgement is tenant copy now (Constitution C9), not a constant. */
const ACK_MESSAGE = (
  JSON.parse(readFileSync('test/fixtures/config/rules.json', 'utf8')) as {
    messages: { acknowledgement: string };
  }
).messages.acknowledgement;

const ESCALATION_MESSAGE = (
  JSON.parse(readFileSync('test/fixtures/config/rules.json', 'utf8')) as {
    messages: { escalation: string };
  }
).messages.escalation;

const SECRET = 'a'.repeat(32);
const ROTATING = 'b'.repeat(32);

const env = loadEnv({
  AGENT_MODEL: 'anthropic:claude-haiku-4-5',
  PUBLIC_BASE_URL: 'https://agent.example.com',
  MANYCHAT_SHARED_SECRET: `${SECRET},${ROTATING}`,
  MANYCHAT_API_TOKEN: 'tok',
  DATABASE_URL: 'postgres://unused',
  CHANNEL: 'whatsapp',
  TENANT_ID: 'demo',
  RACE_DEADLINE_MS: '300',
  MODEL_ABORT_MS: '5000',
  LOG_LEVEL: 'fatal',
});

const okResult = (messages: string[], escalate = false): AgentResult => ({
  reply: {
    messages,
    escalate,
    escalation_reason: escalate ? 'out_of_scope' : null,
    confidence: 0.95,
  },
  usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, costUsd: 0.0001 },
  interventions: [],
  latencyMs: 5,
});

const fastRunner: AgentRunner = {
  run: async () => okResult(['Hi!', 'The foundation course is $450.00.']),
};

/**
 * Answers well after the race deadline. It honours `signal` on purpose: a fake
 * that ignores the abort would let this suite pass even if the abort were
 * misconfigured to fire before the deadline, which is exactly the bug that
 * reached a running server once.
 */
const slowRunner: AgentRunner = {
  run: async ({ signal }) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve(okResult(['Late reply'])), 1500);
      signal?.addEventListener('abort', () => {
        clearTimeout(t);
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    }),
};

let db: Database;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
});
afterEach(async () => {
  await close();
});

async function makeApp(runner: AgentRunner) {
  const { app, registerPlugins } = buildServer({
    env,
    db,
    configStore: new ConfigStore('test/fixtures/config'),
    runner,
  });
  await registerPlugins();
  await app.ready();
  return app;
}

const post = (app: Awaited<ReturnType<typeof makeApp>>, body: unknown, secret?: string) =>
  app.inject({
    method: 'POST',
    url: '/v1/channels/manychat/message',
    ...(secret ? { headers: { authorization: `Bearer ${secret}` } } : {}),
    payload: body as object,
  });

describe('authentication (ADR-0006)', () => {
  it('rejects a request with no credential', async () => {
    const app = await makeApp(fastRunner);
    const res = await post(app, { subscriber_id: '1', text: 'hello' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('rejects a wrong secret', async () => {
    const app = await makeApp(fastRunner);
    const res = await post(app, { subscriber_id: '1', text: 'hello' }, 'c'.repeat(32));
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('rejects a secret of a different length', async () => {
    const app = await makeApp(fastRunner);
    expect((await post(app, { subscriber_id: '1', text: 'hello' }, 'short')).statusCode).toBe(401);
    await app.close();
  });

  it('accepts BOTH secrets during rotation', async () => {
    const app = await makeApp(fastRunner);
    expect((await post(app, { subscriber_id: '1', text: 'h' }, SECRET)).statusCode).toBe(200);
    expect((await post(app, { subscriber_id: '2', text: 'h' }, ROTATING)).statusCode).toBe(200);
    await app.close();
  });

  it('leaks nothing in the 401 body', async () => {
    const app = await makeApp(fastRunner);
    const res = await post(app, { subscriber_id: '1', text: 'hello' });
    expect(res.json()).toEqual({ error: 'unauthorized' });
    await app.close();
  });
});

describe('inbound validation', () => {
  it('rejects unknown fields with 400', async () => {
    const app = await makeApp(fastRunner);
    const res = await post(app, { subscriber_id: '1', text: 'hello', injected: 'x' }, SECRET);
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects a missing text field', async () => {
    const app = await makeApp(fastRunner);
    expect((await post(app, { subscriber_id: '1' }, SECRET)).statusCode).toBe(400);
    await app.close();
  });
});

describe('inline reply (race won)', () => {
  it('returns a valid Dynamic Block v2 body', async () => {
    const app = await makeApp(fastRunner);
    const res = await post(app, { subscriber_id: '77', text: 'how much is it?' }, SECRET);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.version).toBe('v2');
    expect(body.content.messages.map((m: { text: string }) => m.text)).toEqual([
      'Hi!',
      'The foundation course is $450.00.',
    ]);
    await app.close();
  });

  it('omits quick_replies on WhatsApp', async () => {
    const app = await makeApp(fastRunner);
    const body = (await post(app, { subscriber_id: '77', text: 'hello' }, SECRET)).json();
    expect('quick_replies' in body.content).toBe(false);
    await app.close();
  });

  it('re-registers external_message_callback every turn', async () => {
    const app = await makeApp(fastRunner);
    const body = (await post(app, { subscriber_id: '77', text: 'hello' }, SECRET)).json();
    const cb = body.content.external_message_callback;
    expect(cb.url).toBe('https://agent.example.com/v1/channels/manychat/message');
    expect(cb.headers.Authorization).toBe(`Bearer ${SECRET}`);
    await app.close();
  });

  it('persists the turn and its token usage', async () => {
    const app = await makeApp(fastRunner);
    await post(app, { subscriber_id: '77', text: 'hello' }, SECRET);
    const turns = await db.query.turns.findMany();
    expect(turns).toHaveLength(2);
    const agentTurn = turns.find(t => t.role === 'agent')!;
    expect(agentTurn.outcome).toBe('answered_inline');
    expect(agentTurn.cacheReadTokens).toBe(80);
    await app.close();
  });
});

describe('deferred reply (race lost) — ADR-0001', () => {
  it('acknowledges within the platform timeout instead of hanging', async () => {
    const app = await makeApp(slowRunner);
    const started = Date.now();
    const res = await post(app, { subscriber_id: '88', text: 'something slow' }, SECRET);
    const elapsed = Date.now() - started;

    expect(res.statusCode).toBe(200);
    expect(res.json().content.messages[0].text).toBe(ACK_MESSAGE);
    // The whole point: well under ManyChat's 10s kill.
    expect(elapsed).toBeLessThan(10_000);
    await app.close();
  });

  it('delivers the real answer to the outbox once the model finishes', async () => {
    const app = await makeApp(slowRunner);
    await post(app, { subscriber_id: '88', text: 'something slow' }, SECRET);
    // Let the abandoned-but-not-cancelled model call complete.
    await new Promise(r => setTimeout(r, 2000));

    const claimed = await claimBatch(db, 10);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.payload.messages).toEqual(['Late reply']);
    expect(claimed[0]!.subscriberId).toBe('88');
    await app.close();
  });
});

describe('escalation', () => {
  it('escalates on a keyword without ever calling the model', async () => {
    let called = false;
    const spy: AgentRunner = {
      run: async () => {
        called = true;
        return okResult(['no']);
      },
    };
    const app = await makeApp(spy);
    const res = await post(
      app,
      { subscriber_id: '99', text: 'i want to speak to a human' },
      SECRET,
    );

    expect(res.statusCode).toBe(200);
    expect(called).toBe(false);
    const conv = await db.query.conversations.findFirst();
    expect(conv?.escalatedAt).toBeInstanceOf(Date);
    await app.close();
  });

  it('escalates to a human when the model errors', async () => {
    const boom: AgentRunner = {
      run: async () => {
        throw new Error('provider exploded');
      },
    };
    const app = await makeApp(boom);
    const res = await post(app, { subscriber_id: '99', text: 'hello' }, SECRET);
    // A provider failure must not surface as a 500 to the platform.
    expect(res.statusCode).toBe(200);
    expect(res.json().content.messages[0].text).toBe(ESCALATION_MESSAGE);
    await app.close();
  });
});

describe('operational endpoints', () => {
  it('serves health and readiness', async () => {
    const app = await makeApp(fastRunner);
    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toEqual({ status: 'ok' });
    expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
    await app.close();
  });
});
