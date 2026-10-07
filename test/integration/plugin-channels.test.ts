import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { asc } from 'drizzle-orm';
import type { LanguageModel } from 'ai';
import { createTestDatabase } from '../helpers/db.ts';
import { mockModel } from '../helpers/model.ts';
import { fakeManyChatApi } from '../helpers/manychat.ts';
import { EXAMPLE_CHANNEL_PLUGIN, tenantProject } from '../helpers/plugins.ts';
import type { Database } from '../../src/db/client.ts';
import { conversations, outbox, turns } from '../../src/db/schema.ts';
import type { AgentResult, AgentRunner, AgentTurnInput } from '../../src/agent/runner.ts';
import { buildServer } from '../../src/server.ts';
import { ConfigStore, loadEnv } from '../../src/config/loader.ts';
import { loadPlugins } from '../../src/plugins/loader.ts';
import { manychatClientFor } from '../../src/channels/manychat/client.ts';
import { OutboxQueue } from '../../src/outbox/queue.ts';
import { OutboxWorker } from '../../src/outbox/worker.ts';

/**
 * specs/038-plugin-channels.md § Verification. The channel plugin under
 * test/fixtures/plugins is invented, as is every value here (C1). Only the
 * model and the ManyChat HTTP boundary are faked; the plugin's own `push` and
 * `writeToken` record into `globalThis.exampleChat`.
 */

interface ExampleChat {
  pushed: { subscriberId: string; messages: string[] }[];
  tokens: { subscriberId: string; token: string }[];
  failing: boolean;
}
const holder = globalThis as unknown as { exampleChat: ExampleChat };

const SECRET = 'a'.repeat(32);
const AUTH = { authorization: `Bearer ${SECRET}` };
const ROUTE = '/v1/channels/example-chat/message';
const ACKNOWLEDGEMENT = 'Give me one second while I check that.';
const ESCALATION =
  "Let me put you through to someone on the team who can give you the exact answer. They'll reply here shortly.";
const MEDIA_FALLBACK = "I couldn't make out that message. Could you type your question for me?";

let db: Database;
let close: () => Promise<void>;
let cleanup: (() => void)[] = [];
beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
  // Before the plugin loads: its module keeps whatever object it finds here.
  holder.exampleChat = { pushed: [], tokens: [], failing: false };
});
afterEach(async () => {
  for (const remove of cleanup) remove();
  cleanup = [];
  await close();
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let tries = 0; tries < 150; tries++) {
    const value = await read();
    if (done(value)) return value;
    await sleep(20);
  }
  throw new Error('never settled');
}

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
  const seen: AgentTurnInput[] = [];
  const runner: AgentRunner = {
    run: async input => {
      seen.push(input);
      await sleep(delayMs(input.text));
      return result(`reply to ${input.text}`);
    },
  };
  return { runner, seen };
}

/** A channel plugin given as source, for the cases the fixture does not cover. */
function channelSource(over: { parse?: string; writeToken?: boolean } = {}): string {
  return `export default {
  name: 'inline-chat',
  apiVersion: 1,
  channelApiVersion: 0,
  channels: [{
    name: 'inline-chat',
    inbound: { safeParse: value => ({ success: true, data: value }) },
    maxMessages: 1,
    parse: ${over.parse ?? 'body => ({ subscriberId: body.id, text: body.text })'},
    render: reply => ({ out: reply.messages }),
    async push() {},
    ${over.writeToken ? 'async writeToken() {},' : ''}
  }],
};
`;
}

async function serve(
  opts: {
    runner?: AgentRunner;
    model?: LanguageModel;
    env?: Record<string, string>;
    packages?: Record<string, string>;
  } = {},
) {
  const packages = opts.packages ?? { [EXAMPLE_CHANNEL_PLUGIN]: EXAMPLE_CHANNEL_PLUGIN };
  const project = tenantProject(Object.keys(packages), packages);
  cleanup.push(project.remove);
  const plugins = await loadPlugins(project.configDir);
  const env = loadEnv({
    AGENT_MODEL: 'anthropic:claude-haiku-4-5',
    PUBLIC_BASE_URL: 'https://agent.example.com',
    MANYCHAT_SHARED_SECRET: SECRET,
    MANYCHAT_API_TOKEN: 'tok',
    DATABASE_URL: 'postgres://unused',
    CHANNEL: 'whatsapp',
    TENANT_ID: 'demo',
    RACE_DEADLINE_MS: '2000',
    MODEL_ABORT_MS: '5000',
    CONTACT_TOKENS_ENFORCED: 'false',
    LOG_LEVEL: 'fatal',
    ...opts.env,
  });
  const api = fakeManyChatApi();
  const lines: string[] = [];
  const { app } = await buildServer({
    env,
    db,
    configStore: new ConfigStore('test/fixtures/config'),
    ...(opts.runner ? { runner: opts.runner } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    manychatFetch: api.fetch,
    plugins,
    logStream: { write: line => void lines.push(line) },
  });
  await app.ready();
  const post = (payload: unknown, headers: Record<string, string> = AUTH, url = ROUTE) =>
    app.inject({ method: 'POST', url, headers, payload: payload as Record<string, unknown> });
  const worker = () =>
    new OutboxWorker({
      db,
      client: manychatClientFor(env, api.fetch),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      plugins,
    });
  return { app, api, plugins, post, worker, lines };
}

const message = (id: string, text: string, token?: string) => ({
  contact: { id },
  message: { text },
  ...(token ? { token } : {}),
});

/* -------------------------------------------------------------------------- */
/* V1: mounted beside ManyChat's route, behind the same auth                   */
/* -------------------------------------------------------------------------- */

describe('a plugin channel is mounted beside ManyChat (specs/038 V1)', () => {
  it('loads the invented channel from test/fixtures/plugins', async () => {
    const { plugins } = await serve();
    expect(plugins.channels.map(channel => [channel.plugin, channel.name, channel.route])).toEqual([
      ['example-chat', 'example-chat', ROUTE],
    ]);
  });

  it('answers at /v1/channels/<name>/message, rendered by the channel', async () => {
    const { runner } = recordingRunner();
    const { post } = await serve({ runner });
    const response = await post(message('c1', 'hello'));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ replies: ['reply to hello'] });
  });

  it('refuses a request without the shared secret, exactly as the ManyChat route does', async () => {
    const { runner, seen } = recordingRunner();
    const { post } = await serve({ runner });
    const wrong = { authorization: `Bearer ${'b'.repeat(32)}` };
    for (const headers of [{}, wrong]) {
      const plugin = await post(message('c1', 'hello'), headers);
      const manychat = await post(
        { subscriber_id: '5550001', text: 'hello' },
        headers,
        '/v1/channels/manychat/message',
      );
      expect(plugin.statusCode).toBe(manychat.statusCode);
      expect(plugin.statusCode).toBe(401);
      expect(plugin.json()).toEqual(manychat.json());
    }
    expect(seen).toHaveLength(0);
  });

  it('mounts nothing when no plugin declares a channel', async () => {
    const { runner } = recordingRunner();
    const { post } = await serve({ runner, packages: {} });
    expect((await post(message('c1', 'hello'))).statusCode).toBe(404);
  });
});

/* -------------------------------------------------------------------------- */
/* V2: the race, the contact's order, and the plugin's outbound port           */
/* -------------------------------------------------------------------------- */

describe("a plugin channel's turn runs as ManyChat's does (specs/038 V2)", () => {
  it("loses the race to the deadline, and the reply is delivered through the channel's push", async () => {
    const { runner } = recordingRunner(text => (text === 'slow' ? 1_500 : 0));
    const { post, worker, api } = await serve({
      runner,
      env: { RACE_DEADLINE_MS: '1000', MODEL_ABORT_MS: '5000' },
    });

    const response = await post(message('c1', 'slow'));
    expect(response.json()).toEqual({ replies: [ACKNOWLEDGEMENT] });

    const [row] = await eventually(
      () => db.select().from(outbox),
      rows => rows.some(row => row.kind === 'reply'),
    );
    expect(row).toMatchObject({ channel: 'example-chat', subscriberId: 'example-chat:c1' });

    const drained = await worker().drainOnce();
    expect(drained.delivered).toBe(1);
    // The platform's own id, never the agent's `<channel>:` form.
    expect(holder.exampleChat.pushed).toEqual([
      { subscriberId: 'c1', messages: ['reply to slow'] },
    ]);
    expect(api.calls.filter(call => call.path.includes('sending'))).toEqual([]);
  });

  it('retries a push that fails, as a failed ManyChat send is retried', async () => {
    const { runner } = recordingRunner(() => 1_500);
    const { post, worker } = await serve({
      runner,
      env: { RACE_DEADLINE_MS: '1000', MODEL_ABORT_MS: '5000' },
    });
    await post(message('c1', 'slow'));
    await eventually(
      () => db.select().from(outbox),
      rows => rows.some(row => row.kind === 'reply'),
    );
    holder.exampleChat.failing = true;
    expect(await worker().drainOnce()).toMatchObject({ delivered: 0, retrying: 1 });
    expect(holder.exampleChat.pushed).toEqual([]);
  });

  it("orders a contact's second request after the first, which it reads in its history", async () => {
    const { runner, seen } = recordingRunner(text => (text === 'first' ? 200 : 0));
    const { post } = await serve({ runner });

    const first = post(message('c1', 'first'));
    await sleep(50);
    await Promise.all([first, post(message('c1', 'second'))]);

    const second = seen.find(call => call.text === 'second')!;
    expect(second.history.map(turn => `${turn.role}: ${turn.text}`)).toEqual([
      'user: first',
      'agent: reply to first',
    ]);
    const rows = await db.select().from(turns).orderBy(asc(turns.seq));
    expect(rows.map(turn => turn.text)).toEqual([
      'first',
      'reply to first',
      'second',
      'reply to second',
    ]);
  });

  it("keeps a channel's contact apart from a ManyChat contact with the same id", async () => {
    const { runner } = recordingRunner();
    const { post } = await serve({ runner });
    await post(message('5550001', 'from the plugin channel'));
    await post(
      { subscriber_id: '5550001', text: 'from ManyChat' },
      AUTH,
      '/v1/channels/manychat/message',
    );
    const rows = await db.select().from(conversations);
    expect(rows.map(row => [row.subscriberId, row.channel]).sort()).toEqual([
      ['5550001', 'whatsapp'],
      ['example-chat:5550001', 'example-chat'],
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* V3: the channel's schema is checked before anything reads the body           */
/* -------------------------------------------------------------------------- */

describe("a request failing the channel's schema never reaches the model (specs/038 V3)", () => {
  it('is refused with 400, and nothing is recorded', async () => {
    const { runner, seen } = recordingRunner();
    const { post } = await serve({ runner });
    for (const body of [
      {},
      { contact: { id: '' }, message: { text: 'hello' } },
      { contact: { id: 'c1' } },
      { contact: { id: 'c1' }, message: { text: 'hello' }, token: 7 },
    ]) {
      const response = await post(body);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'invalid_request' });
    }
    expect(seen).toHaveLength(0);
    expect(await db.select().from(conversations)).toEqual([]);
  });

  it("checks what the channel's parse returns too: a malformed one is a handoff, not a turn", async () => {
    const { runner, seen } = recordingRunner();
    const { post } = await serve({
      runner,
      packages: { 'inline-chat': channelSource({ parse: '() => ({ subscriberId: 42 })' }) },
    });
    const response = await post({}, AUTH, '/v1/channels/inline-chat/message');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ out: [ESCALATION] });
    expect(seen).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* What only ManyChat can do is off on a plugin channel                        */
/* -------------------------------------------------------------------------- */

describe('a plugin channel is offered nothing that acts on a ManyChat contact (specs/038)', () => {
  it('offers no tools.json tool and no contact read, which the ManyChat route does', async () => {
    const { model, calls } = mockModel({
      messages: ['An invented answer.'],
      escalate: false,
      escalation_reason: null,
      confidence: 0.9,
      closing_question: null,
    });
    const { post } = await serve({ model });

    await post({ subscriber_id: '5550001', text: 'hello' }, AUTH, '/v1/channels/manychat/message');
    const manychatTools = (calls[0]?.tools ?? []).map(tool => tool.name);
    expect(manychatTools).toEqual(expect.arrayContaining(['set_field', 'send_flow']));

    const response = await post(message('c1', 'hello'));
    expect(response.json()).toEqual({ replies: ['An invented answer.'] });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.tools ?? []).toEqual([]);
    // Nor does its prompt describe them.
    const system = JSON.stringify(calls[1]?.prompt[0]);
    expect(system).not.toContain('send_flow');
  });

  it('never downloads media: the contact is asked to type instead', async () => {
    const { runner, seen } = recordingRunner();
    const { post } = await serve({
      runner,
      packages: {
        'inline-chat': channelSource({
          parse:
            "body => ({ subscriberId: body.id, text: '', media: { kind: 'audio', url: 'https://media.example.com/note.ogg' } })",
        }),
      },
    });
    const response = await post({ id: 'c1' }, AUTH, '/v1/channels/inline-chat/message');
    expect(response.json()).toEqual({ out: [MEDIA_FALLBACK] });
    expect(seen).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Contact tokens: through the channel's writeToken, or no history             */
/* -------------------------------------------------------------------------- */

describe('contact tokens on a plugin channel (specs/038, specs/019)', () => {
  it("writes the contact's token through the channel, and a request carrying it reads history", async () => {
    const { runner, seen } = recordingRunner();
    const { post } = await serve({ runner, env: { CONTACT_TOKENS_ENFORCED: 'true' } });

    await post(message('c1', 'first'));
    const [written] = await eventually(
      async () => holder.exampleChat.tokens,
      tokens => tokens.length > 0,
    );
    expect(written?.subscriberId).toBe('c1');

    await post(message('c1', 'without the token'));
    await post(message('c1', 'with the token', written!.token));
    const history = (text: string) =>
      seen.find(call => call.text === text)!.history.map(turn => turn.text);
    expect(history('without the token')).toEqual([]);
    expect(history('with the token')).toEqual(['first', 'reply to first']);
  });

  it('reads no history on a channel that stores no token, and says so at startup', async () => {
    const { runner, seen } = recordingRunner();
    const { post, lines } = await serve({
      runner,
      env: { CONTACT_TOKENS_ENFORCED: 'true', LOG_LEVEL: 'warn' },
      packages: { 'inline-chat': channelSource() },
    });
    const url = '/v1/channels/inline-chat/message';
    await post({ id: 'c1', text: 'first' }, AUTH, url);
    await post({ id: 'c1', text: 'second' }, AUTH, url);
    expect(seen.map(call => call.history.length)).toEqual([0, 0]);
    expect(lines.join('')).toContain('plugin channel stores no contact tokens');
  });

  it('issues no token on a channel that stores none', async () => {
    const { runner } = recordingRunner();
    const { post } = await serve({
      runner,
      env: { CONTACT_TOKENS_ENFORCED: 'true' },
      packages: { 'inline-chat': channelSource() },
    });
    await post({ id: 'c1', text: 'first' }, AUTH, '/v1/channels/inline-chat/message');
    const [conversation] = await db.select().from(conversations);
    expect(conversation?.tokenHash).toBeNull();
    expect((await db.select().from(outbox)).filter(row => row.kind === 'contact_token')).toEqual(
      [],
    );
  });
});

describe('the outbox delivers each row through its own channel (specs/038)', () => {
  it('dead-letters a row for a channel this process has not loaded, without a retry', async () => {
    const { worker, api } = await serve({ packages: {}, runner: recordingRunner().runner });
    await new OutboxQueue(db).enqueue({
      tenantId: 'demo',
      subscriberId: 'gone-chat:c1',
      channel: 'gone-chat',
      conversationId: null,
      reply: result('An invented reply.').reply,
    });
    expect(await worker().drainOnce()).toMatchObject({ delivered: 0, deadLettered: 1 });
    expect(api.calls).toEqual([]);
  });
});
