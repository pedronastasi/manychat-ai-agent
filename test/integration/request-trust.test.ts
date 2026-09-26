import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildServer } from '../../src/server.ts';
import { createTestDatabase } from '../helpers/db.ts';
import type { Database } from '../../src/db/client.ts';
import { loadEnv, ConfigStore, ConfigError } from '../../src/config/loader.ts';
import type { AgentRunner, AgentResult } from '../../src/agent/runner.ts';

/**
 * specs/017-inbound-request-trust.md. Every app here comes from `buildServer`,
 * the composition a process gets, because the rate limiter once passed every
 * test that assembled its own app and never ran in production (§ A control
 * that no test fires does not exist).
 */

const ESCALATION_MESSAGE = (
  JSON.parse(readFileSync('test/fixtures/config/rules.json', 'utf8')) as {
    messages: { escalation: string };
  }
).messages.escalation;

const SECRET = 'a'.repeat(32);
const ROTATING = 'b'.repeat(32);
const ROUTE = '/v1/channels/manychat/message';
/** Long and distinctive, so finding it in a log line cannot be a coincidence. */
const SUBSCRIBER = '5550001234987';

const baseEnv = {
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
};

const answer: AgentResult = {
  reply: {
    messages: ['Hi!'],
    escalate: false,
    escalation_reason: null,
    closing_question: null,
    confidence: 0.95,
  },
  model: 'mock:demo',
  usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, costUsd: 0.0001 },
  interventions: [],
  latencyMs: 5,
};

const fastRunner: AgentRunner = { run: async () => answer };

let db: Database;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
});
afterEach(async () => {
  await close();
});

async function makeApp(
  options: {
    env?: Record<string, string>;
    database?: Database;
    runner?: AgentRunner;
    logs?: string[];
  } = {},
) {
  const logs = options.logs;
  const { app } = await buildServer({
    env: loadEnv({ ...baseEnv, ...options.env }),
    db: options.database ?? db,
    configStore: new ConfigStore('test/fixtures/config'),
    runner: options.runner ?? fastRunner,
    ...(logs ? { logStream: { write: (line: string) => void logs.push(line) } } : {}),
  });
  await app.ready();
  return app;
}

type App = Awaited<ReturnType<typeof makeApp>>;

const post = (app: App, body: object, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: ROUTE, headers, payload: body });

const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });

/** Holds the event loop, as CPU saturation would. */
function holdEventLoop(ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // Spinning is the point: nothing else may run.
  }
}

const nextTurnOfLoop = () => new Promise(resolve => setImmediate(resolve));

describe('specs/017 § Rate limiting is attached before any route and keyed on an address the proxy vouches for', () => {
  it('refuses the 301st request a minute from one address, counting failed authentication', async () => {
    const app = await makeApp();
    for (let index = 0; index < 300; index++) {
      expect((await post(app, { subscriber_id: '1', text: 'hi' })).statusCode).toBe(401);
    }
    expect((await post(app, { subscriber_id: '1', text: 'hi' })).statusCode).toBe(429);
    await app.close();
  });

  it('keeps a separate budget for requests carrying the secret, so a flood without it cannot lock ManyChat out', async () => {
    const app = await makeApp();
    for (let index = 0; index < 301; index++) {
      await post(app, { subscriber_id: '1', text: 'hi' });
    }
    // Same address, which is what every caller shares behind an unlisted proxy.
    expect((await post(app, { subscriber_id: '1', text: 'hi' }, bearer(SECRET))).statusCode).toBe(
      200,
    );
    await app.close();
  });

  it('caps requests carrying the secret at 300 a minute too', async () => {
    const app = await makeApp();
    // An invalid body is refused after authentication, so it counts against
    // the authenticated budget without running a turn.
    for (let index = 0; index < 300; index++) {
      const res = await post(app, { subscriber_id: '1' }, bearer(SECRET));
      expect(res.statusCode).toBe(400);
    }
    expect((await post(app, { subscriber_id: '1', text: 'hi' }, bearer(SECRET))).statusCode).toBe(
      429,
    );
    await app.close();
  });

  it('does not reset the count for a caller rotating X-Forwarded-For when no proxy is trusted', async () => {
    const app = await makeApp();
    for (let index = 0; index < 300; index++) {
      await post(
        app,
        { subscriber_id: '1', text: 'hi' },
        { 'x-forwarded-for': `203.0.113.${index % 250}` },
      );
    }
    const res = await post(
      app,
      { subscriber_id: '1', text: 'hi' },
      { 'x-forwarded-for': '198.51.100.7' },
    );
    expect(res.statusCode).toBe(429);
    await app.close();
  });

  it('keys on the address a trusted proxy forwards', async () => {
    // inject() connects from 127.0.0.1, which plays the proxy here.
    const app = await makeApp({ env: { TRUST_PROXY: '127.0.0.1' } });
    for (let index = 0; index < 300; index++) {
      await post(app, { subscriber_id: '1', text: 'hi' }, { 'x-forwarded-for': '203.0.113.1' });
    }
    const exhausted = await post(
      app,
      { subscriber_id: '1', text: 'hi' },
      { 'x-forwarded-for': '203.0.113.1' },
    );
    expect(exhausted.statusCode).toBe(429);
    const other = await post(
      app,
      { subscriber_id: '1', text: 'hi' },
      { 'x-forwarded-for': '203.0.113.2' },
    );
    expect(other.statusCode).toBe(401);
    await app.close();
  });

  it('refuses a TRUST_PROXY entry that is not an address, a range or a preset', () => {
    expect(() => loadEnv({ ...baseEnv, TRUST_PROXY: 'caddy' })).toThrow(ConfigError);
    expect(() => loadEnv({ ...baseEnv, TRUST_PROXY: '10.0.0.0/33' })).toThrow(ConfigError);
    expect(loadEnv({ ...baseEnv, TRUST_PROXY: 'uniquelocal, 10.0.0.0/8' }).TRUST_PROXY).toEqual([
      'uniquelocal',
      '10.0.0.0/8',
    ]);
  });
});

describe('specs/017 § Authentication runs before the body is read', () => {
  it('answers a request with no credential and an invalid body with 401, not 400', async () => {
    const app = await makeApp();
    const res = await post(app, { subscriber_id: '1', text: 'hi', evil: 'x' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
    await app.close();
  });
});

describe('specs/017 § The callback carries back the secret the caller presented', () => {
  it('registers a callback carrying the second secret for a caller that presented it', async () => {
    const app = await makeApp();
    const res = await post(app, { subscriber_id: '1', text: 'hi' }, bearer(ROTATING));
    expect(res.json().content.external_message_callback.headers.Authorization).toBe(
      `Bearer ${ROTATING}`,
    );
    await app.close();
  });
});

describe('specs/017 § An error on the message route is a handoff, not a 500', () => {
  /** A database whose writes fail, as when the connection is lost mid-turn. */
  const failingWrites = (): Database =>
    new Proxy(db, {
      get(target, property, receiver) {
        if (property === 'insert') {
          return () => {
            // Driver errors can quote a query's parameters, contact text included.
            throw new Error('insert failed for params ("call me on +1 555 010 9999")');
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

  it('answers 200 with the escalation copy and no error text', async () => {
    const app = await makeApp({ database: failingWrites() });
    const res = await post(app, { subscriber_id: '1', text: 'hi' }, bearer(ROTATING));

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.content.messages[0].text).toBe(ESCALATION_MESSAGE);
    expect(res.body).not.toContain('insert failed');
    expect(res.body).not.toContain('555 010');
    // The callback is registered as usual, so the contact's next message
    // still reaches the service once it recovers.
    expect(body.content.external_message_callback.headers.Authorization).toBe(`Bearer ${ROTATING}`);
    await app.close();
  });

  it('logs the error name and code, with its message redacted', async () => {
    const logs: string[] = [];
    const app = await makeApp({ database: failingWrites(), env: { LOG_LEVEL: 'info' }, logs });
    await post(app, { subscriber_id: '1', text: 'hi' }, bearer(SECRET));

    const line = logs
      .map(raw => JSON.parse(raw) as Record<string, unknown>)
      .find(entry => entry.msg === 'unhandled error');
    expect(line).toBeDefined();
    expect(line!.error).toMatchObject({ name: 'Error' });
    expect((line!.error as { message: string }).message).toContain('[phone]');
    for (const raw of logs) expect(raw).not.toContain('555 010');
    await app.close();
  });

  it('hands the contact to a person when the service sheds load', async () => {
    const logs: string[] = [];
    let modelCalled = false;
    const spy: AgentRunner = {
      run: async () => {
        modelCalled = true;
        return answer;
      },
    };
    const app = await makeApp({ env: { LOG_LEVEL: 'info' }, logs, runner: spy });

    // under-pressure samples the loop's lag once a second and averages it over
    // the window. The first block ends a window, so the second fills the next
    // one alone and the sampled lag is the block itself, past the 1000 ms limit.
    holdEventLoop(1200);
    await nextTurnOfLoop();
    holdEventLoop(1500);
    await nextTurnOfLoop();

    const res = await post(app, { subscriber_id: '1', text: 'hi' }, bearer(SECRET));
    expect(res.statusCode).toBe(200);
    expect(res.json().content.messages[0].text).toBe(ESCALATION_MESSAGE);
    expect(res.headers['retry-after']).toBeUndefined();
    expect(modelCalled).toBe(false);

    const messages = logs.map(raw => (JSON.parse(raw) as { msg: string }).msg);
    expect(messages).toContain('load shed');
    expect(messages).not.toContain('unhandled error');
    await app.close();
  });
});

describe('specs/017 § Callbacks are HTTPS or the process does not boot', () => {
  it('refuses an http:// PUBLIC_BASE_URL at load', () => {
    expect(() => loadEnv({ ...baseEnv, PUBLIC_BASE_URL: 'http://agent.example.com' })).toThrow(
      ConfigError,
    );
  });
});

describe('specs/017 § Logs name the conversation, never the contact', () => {
  it('carries the conversation ID on every line about a turn, and never the subscriber ID', async () => {
    const logs: string[] = [];
    const failing: AgentRunner = {
      run: async () => {
        throw new Error('provider down');
      },
    };
    const app = await makeApp({ env: { LOG_LEVEL: 'info' }, logs, runner: failing });
    await post(app, { subscriber_id: SUBSCRIBER, text: 'hi' }, bearer(SECRET));

    const conversation = await db.query.conversations.findFirst();
    const entries = logs.map(raw => JSON.parse(raw) as Record<string, unknown>);
    const aboutTheTurn = entries.filter(
      entry => entry.msg === 'model call failed' || entry.msg === 'turn complete',
    );

    expect(aboutTheTurn).toHaveLength(2);
    for (const entry of aboutTheTurn) expect(entry.conversation).toBe(conversation!.id);
    for (const raw of logs) expect(raw).not.toContain(SUBSCRIBER);
    await app.close();
  });
});
