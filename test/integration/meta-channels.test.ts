import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildServer } from '../../src/server.ts';
import { createTestDatabase } from '../helpers/db.ts';
import type { Database } from '../../src/db/client.ts';
import { conversations, nudges, outbox, turns } from '../../src/db/schema.ts';
import { loadEnv, ConfigStore, loadTenantConfig } from '../../src/config/loader.ts';
import type { AgentResult, AgentRunner, AgentTurnInput } from '../../src/agent/runner.ts';
import type { AgentReply } from '../../src/contracts/agent.ts';
import { RulesSchema } from '../../src/contracts/config.ts';
import { ConversationStore } from '../../src/conversation/store.ts';
import { OutboxQueue } from '../../src/outbox/queue.ts';
import { OutboxWorker } from '../../src/outbox/worker.ts';
import { NudgeStore } from '../../src/nudge/store.ts';
import { NudgeWorker } from '../../src/nudge/worker.ts';
import { manychatClientFor } from '../../src/channels/manychat/client.ts';
import type { ContactReader } from '../../src/channels/manychat/client.ts';
import { fakeManyChatApi, mediaUrl } from '../helpers/manychat.ts';

/**
 * specs/048-one-deployment-every-meta-channel.md § Verification items 1–5, 7
 * and 8, against PGlite, the ManyChat HTTP boundary faked, and the fictional
 * demo tenant in test/fixtures/config.
 */

const SECRET = 'a'.repeat(32);
const ROUTE = '/v1/channels/manychat/message';
const HOUR_MS = 3_600_000;

const baseEnv = {
  AGENT_MODEL: 'anthropic:claude-haiku-4-5',
  PUBLIC_BASE_URL: 'https://agent.example.com',
  MANYCHAT_SHARED_SECRET: SECRET,
  MANYCHAT_API_TOKEN: 'tok',
  MANYCHAT_REPLY_FLOW_NS: 'content_whatsapp_reply',
  MANYCHAT_REPLY_FLOW_NS_INSTAGRAM: 'content_instagram_reply',
  MANYCHAT_REPLY_FLOW_NS_MESSENGER: 'content_messenger_reply',
  CHANNELS: 'whatsapp,instagram,messenger',
  DATABASE_URL: 'postgres://unused',
  TENANT_ID: 'demo',
  RACE_DEADLINE_MS: '300',
  MODEL_ABORT_MS: '5000',
  LOG_LEVEL: 'fatal',
};

const replyOf = (messages: string[]): AgentReply => ({
  messages,
  escalate: false,
  escalation_reason: null,
  closing_question: null,
  confidence: 0.9,
});

const resultOf = (reply: AgentReply): AgentResult => ({
  reply,
  model: 'mock:demo',
  usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, costUsd: 0.0001 },
  interventions: [],
  latencyMs: 5,
});

const FOUR = ['One.', 'Two.', 'Three.', 'Four.'];

/** Answers `FOUR` at once, and records every turn it was given. */
function recordingRunner() {
  const inputs: AgentTurnInput[] = [];
  const runner: AgentRunner = {
    run: input => {
      inputs.push(input);
      return Promise.resolve(resultOf(replyOf(FOUR)));
    },
  };
  return { runner, inputs };
}

let db: Database;
let close: () => Promise<void>;
let api: ReturnType<typeof fakeManyChatApi>;
beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
  api = fakeManyChatApi();
});
afterEach(async () => {
  await close();
});

let logs: string[];
beforeEach(() => {
  logs = [];
});

async function makeApp(runner: AgentRunner, env: Record<string, string> = {}) {
  const { app } = await buildServer({
    env: loadEnv({ ...baseEnv, LOG_LEVEL: 'warn', ...env }),
    db,
    configStore: new ConfigStore('test/fixtures/config'),
    runner,
    manychatFetch: api.fetch,
    logStream: { write: (line: string) => void logs.push(line) },
  });
  await app.ready();
  return app;
}

type App = Awaited<ReturnType<typeof makeApp>>;

const post = (app: App, body: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: ROUTE,
    headers: { authorization: `Bearer ${SECRET}` },
    payload: { subscriber_id: '100', text: 'What are the class times?', ...body },
  });

type Rendered = {
  content: {
    messages: { text: string }[];
    quick_replies?: unknown;
    external_message_callback?: { payload: Record<string, unknown> };
  };
};

describe('the channel belongs to the request (specs/048 V1)', () => {
  it('renders each request for the channel it names, on one server', async () => {
    const app = await makeApp(recordingRunner().runner);

    const instagram = (
      await post(app, { subscriber_id: '1', channel: 'instagram' })
    ).json<Rendered>();
    const whatsapp = (
      await post(app, { subscriber_id: '2', channel: 'whatsapp' })
    ).json<Rendered>();

    // Instagram takes ten messages; WhatsApp delivers one, so the rest is
    // joined into it rather than dropped (specs/002 § Channel capability matrix).
    expect(instagram.content.messages.map(message => message.text)).toEqual(FOUR);
    expect(whatsapp.content.messages.map(message => message.text)).toEqual([FOUR.join('\n\n')]);
    expect(whatsapp.content).not.toHaveProperty('quick_replies');
    await app.close();
  });
});

describe('a request naming no channel, or one not answered here (specs/048 V2)', () => {
  it('reads a request without a channel, or with an empty one, as CHANNEL', async () => {
    const app = await makeApp(recordingRunner().runner, { CHANNEL: 'instagram' });
    for (const body of [{ subscriber_id: '1' }, { subscriber_id: '2', channel: '' }]) {
      const res = (await post(app, body)).json<Rendered>();
      expect(res.content.messages).toHaveLength(FOUR.length);
      expect(res.content.external_message_callback?.payload.channel).toBe('instagram');
    }
    await app.close();
  });

  it.each([
    ['telegram, which is outside the default CHANNELS', {}, 'telegram'],
    ['a channel outside CHANNELS', { CHANNELS: 'whatsapp' }, 'instagram'],
    ['a channel in no table', {}, 'carrier-pigeon'],
  ])('refuses %s with a 400 that never reaches the model', async (_label, env, channel) => {
    const { runner, inputs } = recordingRunner();
    const app = await makeApp(runner, { CHANNELS: '', ...env });
    const res = await post(app, { channel });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid request' });
    expect(inputs).toHaveLength(0);
    expect(await db.select().from(conversations)).toHaveLength(0);
    await app.close();
  });

  it('refuses it only after authentication', async () => {
    const app = await makeApp(recordingRunner().runner);
    const res = await app.inject({
      method: 'POST',
      url: ROUTE,
      payload: { subscriber_id: '1', text: 'hi', channel: 'telegram' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('the callback carries the channel back (specs/048 V3)', () => {
  it("registers a callback whose body names the turn's channel", async () => {
    const app = await makeApp(recordingRunner().runner);
    const res = (await post(app, { channel: 'messenger' })).json<Rendered>();
    expect(res.content.external_message_callback?.payload).toMatchObject({
      channel: 'messenger',
      subscriber_id: '{{contact.id}}',
    });
    await app.close();
  });
});

describe('one subscriber is one contact on every channel (specs/048 V4)', () => {
  it('keeps one conversation, history and turn cap across WhatsApp and Instagram', async () => {
    const { runner, inputs } = recordingRunner();
    const app = await makeApp(runner);

    await post(app, { channel: 'whatsapp', text: 'Asked on WhatsApp.' });
    await vi.waitFor(() => expect(api.fieldOf('100')).not.toBeNull());
    const token = api.fieldOf('100')!;
    await post(app, { channel: 'instagram', text: 'Asked on Instagram.', ai_token: token });

    const rows = await db.select().from(conversations);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.turnCount).toBe(2);
    const userTurns = await db
      .select({ text: turns.text, channel: turns.channel })
      .from(turns)
      .where(eq(turns.role, 'user'))
      .orderBy(turns.seq);
    expect(userTurns).toEqual([
      { text: 'Asked on WhatsApp.', channel: 'whatsapp' },
      { text: 'Asked on Instagram.', channel: 'instagram' },
    ]);
    // The Instagram turn's history holds the WhatsApp one.
    expect(JSON.stringify(inputs[1]!.history)).toContain('Asked on WhatsApp.');
    await app.close();
  });
});

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** A contact whose message on `channel` arrived `hoursAgo` hours ago. */
async function wrote(subscriberId: string, channel: string, hoursAgo: number) {
  const store = new ConversationStore(db);
  const conversation = await store.startTurn({
    tenantId: 'demo',
    subscriberId,
    channel,
    idleResetHours: 24,
  });
  const turnId = await store.recordUserMessage(conversation.id, 'An invented question.', {
    bound: true,
    channel,
  });
  await db
    .update(turns)
    .set({ createdAt: new Date(Date.now() - hoursAgo * HOUR_MS) })
    .where(eq(turns.id, turnId));
  return conversation.id;
}

function outboxWorker(channel = 'whatsapp') {
  const client = manychatClientFor(loadEnv(baseEnv), api.fetch);
  return new OutboxWorker({ db, client, logger: silentLogger, channel });
}

const flowsTriggered = () =>
  api.calls
    .filter(call => call.path === '/fb/sending/sendFlow')
    .map(call => [call.body.subscriber_id, call.body.flow_ns]);

describe("a deferred reply goes out through its channel's flow (specs/048 V5)", () => {
  it('delivers a race lost on Instagram through the Instagram flow', async () => {
    const slow: AgentRunner = {
      run: ({ signal }) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(resultOf(replyOf(['Late.']))), 600);
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          });
        }),
    };
    const app = await makeApp(slow);
    await post(app, { channel: 'instagram' });
    const replies = () => db.select().from(outbox).where(eq(outbox.kind, 'reply'));
    await vi.waitFor(async () => expect(await replies()).toHaveLength(1));
    const [row] = await replies();
    expect(row!.payload).toMatchObject({ manychatChannel: 'instagram' });

    await outboxWorker().drainOnce();
    expect(flowsTriggered()).toEqual([['100', 'content_instagram_reply']]);
    await app.close();
  });

  it('delivers a row queued before specs/048, naming no channel, as CHANNEL', async () => {
    const conversationId = await wrote('200', 'whatsapp', 1);
    // As a row written before the field existed: no manychatChannel.
    await new OutboxQueue(db).enqueue({
      tenantId: 'demo',
      subscriberId: '200',
      conversationId,
      reply: replyOf(['Queued earlier.']),
    });
    await outboxWorker('whatsapp').drainOnce();
    expect(flowsTriggered()).toEqual([['200', 'content_whatsapp_reply']]);
  });
});

describe('outside the window, only WhatsApp has a way back (specs/048 V7)', () => {
  it('dead-letters an Instagram reply past its window and escalates, sending nothing', async () => {
    // The WhatsApp window is open; the Instagram one closed an hour ago.
    await wrote('300', 'instagram', 25);
    const conversationId = await wrote('300', 'whatsapp', 1);
    await new OutboxQueue(db).enqueue({
      tenantId: 'demo',
      subscriberId: '300',
      conversationId,
      reply: replyOf(['Too late for Instagram.']),
      manychatChannel: 'instagram',
    });
    await new NudgeStore(db).schedule(conversationId, 60, new Date(), 'instagram');

    const result = await outboxWorker().drainOnce();

    expect(result).toMatchObject({ claimed: 1, delivered: 0, retrying: 0, deadLettered: 1 });
    expect(api.calls).toEqual([]);
    const [row] = await db.select().from(outbox);
    expect(row).toMatchObject({ status: 'failed', lastError: 'window_closed' });
    const [conversation] = await db.select().from(conversations);
    expect(conversation!.escalatedAt).not.toBeNull();
    const [nudge] = await db.select().from(nudges);
    expect(nudge).toMatchObject({ status: 'cancelled', cancelReason: 'escalated' });
  });

  it('counts a message an older process wrote without a channel, as during a rolling deploy', async () => {
    const conversationId = await wrote('303', 'instagram', 30);
    // Written after migration 0013 by code from before it: no channel.
    await db
      .insert(turns)
      .values({ conversationId, role: 'user', text: 'An invented question.', bound: true });
    await new OutboxQueue(db).enqueue({
      tenantId: 'demo',
      subscriberId: '303',
      conversationId,
      reply: replyOf(['Still in time.']),
      manychatChannel: 'instagram',
    });
    expect(await outboxWorker().drainOnce()).toMatchObject({ delivered: 1, deadLettered: 0 });
  });

  it('delivers an Instagram reply inside its window', async () => {
    const conversationId = await wrote('301', 'instagram', 23);
    await new OutboxQueue(db).enqueue({
      tenantId: 'demo',
      subscriberId: '301',
      conversationId,
      reply: replyOf(['Still in time.']),
      manychatChannel: 'instagram',
    });
    expect(await outboxWorker().drainOnce()).toMatchObject({ delivered: 1 });
    expect(flowsTriggered()).toEqual([['301', 'content_instagram_reply']]);
  });

  it('sends a WhatsApp reply past the window as before, through its template flow', async () => {
    const conversationId = await wrote('302', 'whatsapp', 30);
    await new OutboxQueue(db).enqueue({
      tenantId: 'demo',
      subscriberId: '302',
      conversationId,
      reply: replyOf(['Through the template.']),
      manychatChannel: 'whatsapp',
    });
    expect(await outboxWorker().drainOnce()).toMatchObject({ delivered: 1 });
  });
});

describe("nudges follow each channel's window (specs/048 V8)", () => {
  const fixture = loadTenantConfig('test/fixtures/config');
  const rules = RulesSchema.parse({
    messages: { acknowledgement: 'One moment.', escalation: 'Passing you to a person.' },
    budget: { dailyTokenCap: 100_000, dailyCostCapUsd: 5 },
    rateLimit: { turnsPerSubscriberPerHour: 60 },
  });
  const noTags: ContactReader = {
    readContact: () => Promise.resolve({ tags: [], custom_fields: [] }),
  };

  function nudgeWorker(runner: AgentRunner) {
    return new NudgeWorker({
      db,
      runner,
      config: () => ({ ...fixture, rules }),
      contacts: noTags,
      logger: silentLogger,
      modelAbortMs: 5000,
    });
  }

  /** Makes the conversation's pending nudge due a minute ago. */
  async function due(conversationId: string, channel: string) {
    const scheduledAt = new Date(Date.now() - 2 * HOUR_MS);
    await new NudgeStore(db).schedule(conversationId, 1, scheduledAt, channel);
    await db
      .update(nudges)
      .set({ dueAt: new Date(Date.now() - 60_000) })
      .where(eq(nudges.conversationId, conversationId));
  }

  it('measures an Instagram nudge from the last Instagram message, not a later WhatsApp one', async () => {
    await wrote('400', 'instagram', 23.5);
    const conversationId = await wrote('400', 'whatsapp', 1);
    await due(conversationId, 'instagram');
    const { runner, inputs } = recordingRunner();

    expect(await nudgeWorker(runner).drainOnce()).toEqual(['window_closing']);
    expect(inputs).toHaveLength(0);
  });

  it('runs an Instagram nudge inside its window and queues it for Instagram', async () => {
    const conversationId = await wrote('401', 'instagram', 2);
    await due(conversationId, 'instagram');
    const { runner } = recordingRunner();

    expect(await nudgeWorker(runner).drainOnce()).toEqual(['sent']);
    const [row] = await db.select().from(outbox);
    expect(row!.payload).toMatchObject({ manychatChannel: 'instagram' });
  });

  it('is cancelled as contact_replied by a message on WhatsApp', async () => {
    const app = await makeApp(recordingRunner().runner);
    const conversationId = await wrote('100', 'instagram', 2);
    await due(conversationId, 'instagram');

    await post(app, { channel: 'whatsapp', text: 'Answered on WhatsApp.' });

    const [nudge] = await db.select().from(nudges);
    expect(nudge).toMatchObject({ status: 'cancelled', cancelReason: 'contact_replied' });
    await app.close();
  });
});

describe("another channel's media is unsupported until its shape is observed (specs/048 V9)", () => {
  it('answers an invented Instagram file without downloading it, storing it or logging it', async () => {
    const { runner, inputs } = recordingRunner();
    const app = await makeApp(runner);
    const url = mediaUrl('jpeg').replace('/wa/', '/ig/');

    const res = await post(app, { channel: 'instagram', text: url });

    expect(res.statusCode).toBe(200);
    expect(api.media.requested).toEqual([]);
    expect(inputs).toHaveLength(0);
    const [turn] = await db.select().from(turns).where(eq(turns.role, 'user'));
    expect(turn!.mediaKind).toBe('unsupported');
    expect(turn!.text).not.toContain('manybot-files');
    const logged = logs.join('\n');
    expect(logged).toContain('media_url_unmatched');
    expect(logged).toContain('/<n>/ig/<n>/<n>/<n>/original_<hex>.jpeg');
    expect(logged).not.toContain(url);
    await app.close();
  });
});
