import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { asc } from 'drizzle-orm';
import { createTestDatabase } from '../helpers/db.ts';
import { fakeManyChatApi } from '../helpers/manychat.ts';
import {
  channelPluginSource,
  EXAMPLE_CHANNEL_PLUGIN,
  EXAMPLE_PLUGIN,
  tenantProject,
} from '../helpers/plugins.ts';
import type { Database } from '../../src/db/client.ts';
import { conversations, turns } from '../../src/db/schema.ts';
import { buildServer } from '../../src/server.ts';
import { loadEnv, ConfigStore } from '../../src/config/loader.ts';
import type { AgentRunner, AgentResult, AgentTurnInput } from '../../src/agent/runner.ts';
import { OutboxWorker } from '../../src/outbox/worker.ts';
import { manychatClientFor } from '../../src/channels/manychat/client.ts';
import { loadPlugins } from '../../src/plugins/loader.ts';
import { Plugins, type HostLogger } from '../../src/plugins/plugins.ts';

/**
 * specs/038-plugin-channels.md § Verification. The invented widget channel is
 * loaded from a stand-in tenant project as a real plugin is, and every request
 * goes through the real server, turn handler and outbox. The model and the
 * ManyChat HTTP boundary are the only fakes (specs/004).
 */

const SECRET = 'a'.repeat(32);
const ROUTE = '/v1/channels/example-widget/message';

let plugins: Plugins;
let removeProject: () => void;
beforeAll(async () => {
  const project = tenantProject([EXAMPLE_CHANNEL_PLUGIN, EXAMPLE_PLUGIN], {
    [EXAMPLE_CHANNEL_PLUGIN]: EXAMPLE_CHANNEL_PLUGIN,
    [EXAMPLE_PLUGIN]: EXAMPLE_PLUGIN,
  });
  removeProject = project.remove;
  plugins = await loadPlugins(project.configDir);
});
afterAll(() => removeProject());

let db: Database;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
});
afterEach(async () => {
  await close();
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const result = (text: string): AgentResult => ({
  reply: {
    messages: [text],
    escalate: false,
    escalation_reason: null,
    confidence: 0.9,
    closing_question: null,
  },
  model: 'mock:demo',
  usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, costUsd: 0.001 },
  interventions: [],
  latencyMs: 5,
});

/** Answers "reply to <text>" after `delayMs(text)`, keeping what each call was given. */
function recordingRunner(delayMs: (text: string) => number = () => 0) {
  const seen: { text: string; history: string[]; builtInTools: boolean | undefined }[] = [];
  const runner: AgentRunner = {
    run: async ({ text, history, builtInTools }: AgentTurnInput) => {
      seen.push({
        text,
        history: history.map(turn => `${turn.role}: ${turn.text}`),
        builtInTools,
      });
      await sleep(delayMs(text));
      return result(`reply to ${text}`);
    },
  };
  return { runner, seen };
}

async function server(
  runner: AgentRunner,
  opts: { raceDeadlineMs?: number; loaded?: Plugins } = {},
) {
  const env = loadEnv({
    AGENT_MODEL: 'anthropic:claude-haiku-4-5',
    PUBLIC_BASE_URL: 'https://agent.example.com',
    MANYCHAT_SHARED_SECRET: SECRET,
    MANYCHAT_API_TOKEN: 'tok',
    DATABASE_URL: 'postgres://unused',
    CHANNEL: 'whatsapp',
    TENANT_ID: 'demo',
    RACE_DEADLINE_MS: String(opts.raceDeadlineMs ?? 2_000),
    MODEL_ABORT_MS: '5000',
    // Enforced, as in production: the widget's turns are bound all the same.
    CONTACT_TOKENS_ENFORCED: 'true',
    LOG_LEVEL: 'fatal',
  });
  const manychat = fakeManyChatApi();
  const { app } = await buildServer({
    env,
    db,
    configStore: new ConfigStore('test/fixtures/config'),
    runner,
    manychatFetch: manychat.fetch,
    plugins: opts.loaded ?? plugins,
  });
  await app.ready();
  /** `null` sends no Authorization header at all. */
  const post = (payload: object, authorization: string | null = `Bearer ${SECRET}`) =>
    app.inject({
      method: 'POST',
      url: ROUTE,
      headers: authorization ? { authorization } : {},
      payload,
    });
  // The worker's client, on the same fake ManyChat boundary.
  const client = manychatClientFor(env, manychat.fetch);
  return { app, post, manychat, client };
}

/** Every line written, so a test can read what the plugin's `push` was given. */
function journal() {
  const lines: { message: string; fields: Record<string, unknown> }[] = [];
  const at = (fields: object, message: string) => {
    lines.push({ message, fields: fields as Record<string, unknown> });
  };
  const logger: HostLogger = { info: at, warn: at, error: at };
  return { lines, logger };
}

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let tries = 0; tries < 150; tries++) {
    const value = await read();
    if (done(value)) return value;
    await sleep(20);
  }
  throw new Error('never settled');
}

const replyRows = async () =>
  (await db.query.outbox.findMany({ orderBy: (row, { asc: up }) => [up(row.createdAt)] })).filter(
    row => row.kind === 'reply',
  );

describe('a plugin channel is mounted behind the same auth (specs/038 V1)', () => {
  it('mounts the invented channel at /v1/channels/<name>/message', async () => {
    const { runner } = recordingRunner();
    const { post } = await server(runner);

    const response = await post({ visitor: 'v-100', says: 'When does the evening course start?' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      say: ['reply to When does the evening course start?'],
      handoff: false,
    });
  });

  it('refuses a request without the shared secret, or with a wrong one, as the ManyChat route does', async () => {
    const { runner, seen } = recordingRunner();
    const { app, post } = await server(runner);
    const payload = { visitor: 'v-100', says: 'Hello' };

    for (const authorization of [null, 'Bearer not-the-secret-not-the-secret']) {
      const widget = await post(payload, authorization);
      const manychat = await app.inject({
        method: 'POST',
        url: '/v1/channels/manychat/message',
        headers: authorization ? { authorization } : {},
        payload: { subscriber_id: '5550001', text: 'Hello' },
      });
      expect(widget.statusCode).toBe(401);
      expect(manychat.statusCode).toBe(401);
      expect(widget.json()).toEqual(manychat.json());
    }
    expect(seen).toEqual([]);
  });

  it('mounts nothing for a tenant without a channel plugin', async () => {
    const { runner } = recordingRunner();
    const { post } = await server(runner, { loaded: Plugins.NONE });
    expect((await post({ visitor: 'v-100', says: 'Hello' })).statusCode).toBe(404);
  });
});

describe('a plugin channel turn runs the race, the order and the outbox (specs/038 V2)', () => {
  it('is a bound turn with no token issued, offered no tools.json tool, and recorded on its own channel', async () => {
    const { runner, seen } = recordingRunner();
    const { post, manychat } = await server(runner);

    await post({ visitor: 'v-100', says: 'first', nickname: 'Invented Visitor' });
    await post({ visitor: 'v-100', says: 'second' });

    // Bound by the channel's own auth: the second turn reads the first.
    expect(seen.map(call => call.history)).toEqual([[], ['user: first', 'agent: reply to first']]);
    expect(seen.every(call => call.builtInTools === false)).toBe(true);
    const [conversation] = await db.select().from(conversations);
    expect(conversation).toMatchObject({
      channel: 'example-widget',
      subscriberId: 'example-widget:v-100',
      tokenHash: null,
    });
    // Nothing reached ManyChat: no token write, no action.
    expect(manychat.calls).toEqual([]);
  });

  it('never shares a conversation with a ManyChat contact whose ID is the same', async () => {
    const { runner } = recordingRunner();
    const { app, post } = await server(runner);

    await post({ visitor: '5550001', says: 'from the widget' });
    await app.inject({
      method: 'POST',
      url: '/v1/channels/manychat/message',
      headers: { authorization: `Bearer ${SECRET}` },
      payload: { subscriber_id: '5550001', text: 'from ManyChat' },
    });

    const rows = await db.select().from(conversations).orderBy(asc(conversations.createdAt));
    expect(rows.map(row => [row.channel, row.subscriberId])).toEqual([
      ['example-widget', 'example-widget:5550001'],
      ['whatsapp', '5550001'],
    ]);
  });

  it("orders a contact's second message behind the first, as specs/037 orders ManyChat's", async () => {
    const { runner, seen } = recordingRunner(text => (text === 'first' ? 200 : 0));
    const { post } = await server(runner);

    const first = post({ visitor: 'v-100', says: 'first' });
    await sleep(50);
    await Promise.all([first, post({ visitor: 'v-100', says: 'second' })]);

    expect(seen.find(call => call.text === 'second')?.history).toEqual([
      'user: first',
      'agent: reply to first',
    ]);
    const recorded = (await db.select().from(turns).orderBy(asc(turns.seq))).map(
      turn => `${turn.role}: ${turn.text}`,
    );
    expect(recorded).toEqual([
      'user: first',
      'agent: reply to first',
      'user: second',
      'agent: reply to second',
    ]);
  });

  it('answers a lost race with the holding line and delivers the reply through the plugin, not ManyChat', async () => {
    const { runner } = recordingRunner(() => 300);
    const { post, manychat, client } = await server(runner, { raceDeadlineMs: 50 });

    const response = await post({ visitor: 'v-100', says: 'a slow question' });
    expect(response.json()).toEqual({
      say: ['Give me one second while I check that.'],
      handoff: false,
    });

    const [row] = await eventually(replyRows, rows => rows.length === 1);
    expect(row).toMatchObject({
      subscriberId: 'example-widget:v-100',
      payload: { messages: ['reply to a slow question'], channel: 'example-widget' },
    });

    const { lines, logger } = journal();
    const worker = new OutboxWorker({ db, client, logger, plugins });
    expect(await worker.drainOnce()).toMatchObject({ delivered: 1, retrying: 0 });

    const pushed = lines.find(line => line.message === 'reply pushed');
    expect(pushed?.fields).toEqual({
      // Exactly what specs/038 hands `push`, and the plugin named on its line.
      given: 'logger,reply,signal,subscriberId',
      // The platform's own ID, without the prefix, redacted from the line (C5).
      subscriber: '[subscriber]',
      messages: 'reply to a slow question',
      handoff: false,
      plugin: 'example-widget',
    });
    expect(manychat.calls).toEqual([]);
  });

  it('retries a push that fails, as the outbox retries ManyChat', async () => {
    const { runner } = recordingRunner(() => 300);
    const { post, manychat, client } = await server(runner, { raceDeadlineMs: 50 });

    await post({ visitor: 'v-100', says: 'unreachable' });
    await eventually(replyRows, rows => rows.length === 1);

    const { logger } = journal();
    const worker = new OutboxWorker({ db, client, logger, plugins });
    expect(await worker.drainOnce()).toMatchObject({ delivered: 0, retrying: 1 });
    const [row] = await replyRows();
    expect(row).toMatchObject({ status: 'pending', lastError: 'the widget is unreachable' });
    expect(manychat.calls).toEqual([]);
  });

  it('dead-letters a reply for a channel no plugin adds any more, without reaching ManyChat', async () => {
    const { runner } = recordingRunner(() => 300);
    const { post, manychat, client } = await server(runner, { raceDeadlineMs: 50 });

    await post({ visitor: 'v-100', says: 'a slow question' });
    await eventually(replyRows, rows => rows.length === 1);

    // The process restarted without the plugin.
    const { logger } = journal();
    const worker = new OutboxWorker({ db, client, logger });
    expect(await worker.drainOnce()).toMatchObject({ delivered: 0, deadLettered: 1 });
    expect(manychat.calls).toEqual([]);
  });

  it('hands off through the channel when its parse fails after the schema passed (C6)', async () => {
    const project = tenantProject(['invented-channel'], {
      'invented-channel': channelPluginSource({
        parse: "() => { throw new Error('the plugin could not read it'); }",
      }),
    });
    try {
      const loaded = await loadPlugins(project.configDir);
      const { runner, seen } = recordingRunner();
      const { app } = await server(runner, { loaded });
      const response = await app.inject({
        method: 'POST',
        url: '/v1/channels/invented/message',
        headers: { authorization: `Bearer ${SECRET}` },
        payload: { id: 'v-100', text: 'Hello' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        out: [
          "Let me put you through to someone on the team who can give you the exact answer. They'll reply here shortly.",
        ],
      });
      expect(seen).toEqual([]);
    } finally {
      project.remove();
    }
  });
});

describe("a request failing the channel's schema is refused before the model (specs/038 V3)", () => {
  it.each([
    ['a missing field', { visitor: 'v-100' }],
    ['a field of the wrong type', { visitor: 'v-100', says: 42 }],
    ['a key the schema does not declare', { visitor: 'v-100', says: 'Hello', ai_token: 'x' }],
    ['a value over its bound', { visitor: 'v-100', says: 'x'.repeat(2001) }],
  ])('refuses %s with a 400 and never calls the model', async (_case, payload) => {
    const { runner, seen } = recordingRunner();
    const { post } = await server(runner);

    const response = await post(payload);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid request' });
    expect(seen).toEqual([]);
    expect(await db.select().from(conversations)).toEqual([]);
  });

  it('checks the schema only after authentication, so a caller without the secret learns nothing', async () => {
    const { runner } = recordingRunner();
    const { post } = await server(runner);
    const response = await post({ visitor: 'v-100' }, null);
    expect(response.statusCode).toBe(401);
  });
});
