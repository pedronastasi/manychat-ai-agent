import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { buildServer } from '../../src/server.ts';
import { createTestDatabase } from '../helpers/db.ts';
import { fakeManyChatApi } from '../helpers/manychat.ts';
import type { Database } from '../../src/db/client.ts';
import { conversations, outbox, turns } from '../../src/db/schema.ts';
import { loadEnv, ConfigStore, ConfigError } from '../../src/config/loader.ts';
import type { AgentRunner, AgentResult } from '../../src/agent/runner.ts';
import { ManyChatHttpClient } from '../../src/channels/manychat/client.ts';
import { OutboxWorker } from '../../src/outbox/worker.ts';
import { ContactTokens, hashToken } from '../../src/conversation/tokens.ts';
import {
  backfillContactTokens,
  countContactsWithoutTokens,
} from '../../src/conversation/backfill.ts';

/**
 * specs/019-contact-tokens.md § Verification. Every app here comes from
 * `buildServer`, and ManyChat is faked at its HTTP boundary, so the token
 * travels the same path it does in production: issued here, written to the
 * contact's field, and presented back as `ai_token`.
 */

const SECRET = 'a'.repeat(32);
const ROUTE = '/v1/channels/manychat/message';
const CONTACT = '5550001234987';
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const baseEnv = {
  AGENT_MODEL: 'anthropic:claude-haiku-4-5',
  PUBLIC_BASE_URL: 'https://agent.example.com',
  MANYCHAT_SHARED_SECRET: SECRET,
  MANYCHAT_API_TOKEN: 'tok',
  DATABASE_URL: 'postgres://unused',
  CHANNEL: 'whatsapp',
  TENANT_ID: 'demo',
  RACE_DEADLINE_MS: '1000',
  MODEL_ABORT_MS: '5000',
  LOG_LEVEL: 'info',
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

let db: Database;
let close: () => Promise<void>;
let api: ReturnType<typeof fakeManyChatApi>;
let logs: string[];
let bodies: string[];
/** The history each model call received, in order. */
let seen: string[][];

const runner: AgentRunner = {
  run: async ({ history }) => {
    seen.push(history.map(entry => entry.text));
    return answer;
  },
};

beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
  api = fakeManyChatApi();
  logs = [];
  bodies = [];
  seen = [];
});

afterEach(async () => {
  // § Each contact's token lives in ManyChat, never in a response: checked
  // after every test in this suite, against every token any of them issued.
  const issued = api.tokensWritten();
  for (const token of issued) {
    for (const body of bodies) expect(body).not.toContain(token);
    for (const line of logs) expect(line).not.toContain(token);
  }
  await close();
});

async function makeApp(options: { env?: Record<string, string>; database?: Database } = {}) {
  const { app } = await buildServer({
    env: loadEnv({ ...baseEnv, ...options.env }),
    db: options.database ?? db,
    configStore: new ConfigStore('test/fixtures/config'),
    runner,
    manychatFetch: api.fetch,
    logStream: { write: (line: string) => void logs.push(line) },
  });
  await app.ready();
  return app;
}

type App = Awaited<ReturnType<typeof makeApp>>;

/** A message from the contact, carrying `token` as `ai_token` unless it is undefined. */
async function send(app: App, text: string, token?: string | null, subscriber = CONTACT) {
  const res = await app.inject({
    method: 'POST',
    url: ROUTE,
    headers: { authorization: `Bearer ${SECRET}` },
    payload: {
      subscriber_id: subscriber,
      text,
      ...(token !== undefined ? { ai_token: token } : {}),
    },
  });
  bodies.push(res.body);
  expect(res.statusCode).toBe(200);
  return res;
}

/** What ManyChat would fill in for the contact, once the write has landed. */
async function fieldAfterWrites(count: number, subscriber = CONTACT) {
  await vi.waitFor(() => expect(api.tokensWritten()).toHaveLength(count));
  return api.fieldOf(subscriber);
}

const turnsOf = async (subscriber = CONTACT) => {
  const conversation = await db.query.conversations.findFirst({
    where: eq(conversations.subscriberId, subscriber),
  });
  return db.query.turns.findMany({
    where: eq(turns.conversationId, conversation!.id),
    orderBy: (table, { asc }) => [asc(table.seq)],
  });
};

const tokenJobs = () => db.query.outbox.findMany({ where: eq(outbox.kind, 'contact_token') });

const logged = (message: string) =>
  logs
    .map(raw => JSON.parse(raw) as Record<string, unknown>)
    .filter(entry => entry.msg === message);

const backdateIssue = (ms: number) =>
  db
    .update(conversations)
    .set({ tokenIssuedAt: new Date(Date.now() - ms) })
    .where(eq(conversations.subscriberId, CONTACT));

describe("specs/019 § Each contact's token lives in ManyChat, never in a response", () => {
  it("writes the token to the contact's own field and stores only its hash", async () => {
    const app = await makeApp();
    await send(app, 'hello');
    const token = await fieldAfterWrites(1);

    const write = api.calls.find(call => call.body.field_name === 'ai_token')!;
    expect(write.path).toBe('/fb/subscriber/setCustomFieldByName');
    expect(write.body.subscriber_id).toBe(CONTACT);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const row = await db.query.conversations.findFirst();
    expect(row!.tokenHash).toBe(hashToken(token!));
    expect(JSON.stringify(row)).not.toContain(token);
    await app.close();
  });

  it('writes to the field MANYCHAT_TOKEN_FIELD names, and asks for it back', async () => {
    const app = await makeApp({ env: { MANYCHAT_TOKEN_FIELD: 'custom_token' } });
    const res = await send(app, 'hello');
    await vi.waitFor(() => expect(api.fieldOf(CONTACT, 'custom_token')).not.toBeNull());
    expect(res.json().content.external_message_callback.payload.ai_token).toBe('{{custom_token}}');
    await app.close();
  });

  it("registers a callback that carries the contact's field variable", async () => {
    const app = await makeApp();
    const res = await send(app, 'hello');
    expect(res.json().content.external_message_callback.payload).toEqual({
      text: '{{last_input_text}}',
      subscriber_id: '{{contact.id}}',
      ai_token: '{{ai_token}}',
    });
    await app.close();
  });

  it('carries the field variable on the handoff an error returns too', async () => {
    const failingWrites = new Proxy(db, {
      get(target, property, receiver) {
        if (property === 'insert') {
          return () => {
            throw new Error('insert failed');
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const app = await makeApp({ database: failingWrites });
    const res = await send(app, 'hello');
    expect(res.json().content.external_message_callback.payload.ai_token).toBe('{{ai_token}}');
    await app.close();
  });

  it('cancels the retry once the write lands', async () => {
    const app = await makeApp();
    await send(app, 'hello');
    await vi.waitFor(async () => {
      const [job] = await tokenJobs();
      expect(job!.status).toBe('delivered');
    });
    await app.close();
  });

  it('retries a failed write through the outbox worker, with a fresh token', async () => {
    const app = await makeApp();
    api.state.failing = true;
    await send(app, 'hello');
    await fieldAfterWrites(1);
    expect(api.fieldOf(CONTACT)).toBeNull();

    const [job] = await tokenJobs();
    expect(job!.status).toBe('pending');
    // Not before the in-process write could still land.
    expect(job!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 30_000);

    api.state.failing = false;
    await db.update(outbox).set({ nextAttemptAt: sql`now()` });
    const worker = new OutboxWorker({
      db,
      client: new ManyChatHttpClient({
        apiToken: 'tok',
        replyField: 'ai_message',
        replyFlowNs: 'flow',
        tokenField: 'ai_token',
        fetchImpl: api.fetch,
      }),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    expect(await worker.drainOnce()).toMatchObject({ claimed: 1, delivered: 1 });

    const token = api.fieldOf(CONTACT);
    expect((await db.query.conversations.findFirst())!.tokenHash).toBe(hashToken(token!));
    await send(app, 'back', token);
    expect(seen.at(-1)).toEqual(['hello', 'Hi!']);
    await app.close();
  });

  it("keeps a failed token write's recorded error to its status", async () => {
    const app = await makeApp();
    api.state.failing = true;
    await send(app, 'hello');
    await fieldAfterWrites(1);
    await db.update(outbox).set({ nextAttemptAt: sql`now()` });
    await new OutboxWorker({
      db,
      client: new ManyChatHttpClient({
        apiToken: 'tok',
        replyField: 'ai_message',
        replyFlowNs: 'flow',
        tokenField: 'ai_token',
        fetchImpl: api.fetch,
      }),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    }).drainOnce();

    const [job] = await tokenJobs();
    expect(job!.lastError).toBe('contact token write failed: 503');
    expect(logged('contact token write failed')).toHaveLength(1);
    await app.close();
  });

  it('drops a retry that a newer token superseded', async () => {
    const app = await makeApp();
    api.state.failing = true;
    await send(app, 'hello');
    await fieldAfterWrites(1);

    api.state.failing = false;
    await backdateIssue(HOUR_MS + 60_000);
    await send(app, 'no token');
    const newer = await fieldAfterWrites(2);
    // The newer write cancels its own retry; only the superseded one is left.
    await vi.waitFor(async () => {
      const pending = (await tokenJobs()).filter(job => job.status === 'pending');
      expect(pending).toHaveLength(1);
    });

    await db.update(outbox).set({ nextAttemptAt: sql`now()` });
    await new OutboxWorker({
      db,
      client: new ManyChatHttpClient({
        apiToken: 'tok',
        replyField: 'ai_message',
        replyFlowNs: 'flow',
        tokenField: 'ai_token',
        fetchImpl: api.fetch,
      }),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    }).drainOnce();

    expect(api.tokensWritten()).toHaveLength(2);
    expect(api.fieldOf(CONTACT)).toBe(newer);
    await app.close();
  });
});

describe("specs/019 § Each contact's token lives in ManyChat, never in a response: reissue", () => {
  it('writes a fresh token after an unbound request once, and none for a second within the hour', async () => {
    const app = await makeApp();
    await send(app, 'hello');
    const first = await fieldAfterWrites(1);
    await backdateIssue(HOUR_MS + 60_000);

    await send(app, 'field cleared', null);
    const second = await fieldAfterWrites(2);
    expect(second).not.toBe(first);

    await send(app, 'still cleared', null);
    const row = await db.query.conversations.findFirst();
    expect(row!.tokenGeneration).toBe(2);
    expect(api.tokensWritten()).toHaveLength(2);
    await app.close();
  });

  it('keeps the previous token binding until the next issue', async () => {
    const app = await makeApp();
    await send(app, 'hello');
    const first = await fieldAfterWrites(1);
    await backdateIssue(HOUR_MS + 60_000);
    await send(app, 'no token');
    const second = await fieldAfterWrites(2);

    // Sent before the new token landed.
    await send(app, 'in flight', first);
    expect(seen.at(-1)).toEqual(['hello', 'Hi!']);
    await send(app, 'current', second);
    expect(seen.at(-1)).toEqual(['hello', 'Hi!', 'in flight', 'Hi!']);

    await backdateIssue(HOUR_MS + 60_000);
    await send(app, 'no token again');
    await fieldAfterWrites(3);
    await send(app, 'two issues ago', first);
    expect(seen.at(-1)).toEqual([]);
    await app.close();
  });
});

describe("specs/019 § A request without the contact's current token reads no history", () => {
  async function contactWithHistory(app: App) {
    await send(app, 'my name is Ana, call me on 555 0100');
    const token = await fieldAfterWrites(1);
    await send(app, 'which course?', token);
    expect(seen.at(-1)).toEqual(['my name is Ana, call me on 555 0100', 'Hi!']);
    return token!;
  }

  it('answers a caller naming the contact without their token from its own message alone (specs/019 § The shared secret proves the caller, not the contact)', async () => {
    const app = await makeApp();
    const token = await contactWithHistory(app);

    await send(app, 'what did I tell you?');
    expect(seen.at(-1)).toEqual([]);
    await send(app, 'what did I tell you?', 'x'.repeat(43));
    expect(seen.at(-1)).toEqual([]);

    const recorded = await turnsOf();
    expect(recorded.filter(turn => !turn.bound)).toHaveLength(4);
    expect(recorded.filter(turn => !turn.bound).map(turn => turn.role)).toEqual([
      'user',
      'agent',
      'user',
      'agent',
    ]);

    await send(app, 'and now?', token);
    expect(seen.at(-1)).not.toContain('what did I tell you?');
    expect(seen.at(-1)).toHaveLength(4);
    await app.close();
  });

  it('logs every unbound turn', async () => {
    const app = await makeApp();
    await contactWithHistory(app);
    await send(app, 'forged');
    await send(app, 'forged', 'wrong');

    expect(logged('unbound turn')).toHaveLength(2);
    expect(logged('turn complete').map(entry => entry.binding)).toEqual([
      'first',
      'bound',
      'unbound',
      'unbound',
    ]);
    await app.close();
  });

  it('issues a new contact a token and records bound turns the next bound request sees', async () => {
    const app = await makeApp();
    await send(app, 'first message');
    expect(seen.at(-1)).toEqual([]);
    const token = await fieldAfterWrites(1);
    expect((await turnsOf()).every(turn => turn.bound)).toBe(true);

    await send(app, 'second message', token);
    expect(seen.at(-1)).toEqual(['first message', 'Hi!']);
    await app.close();
  });

  it('starts the history of a contact who has turns but no token', async () => {
    const [conversation] = await db
      .insert(conversations)
      .values({ tenantId: 'demo', subscriberId: CONTACT, channel: 'whatsapp', turnCount: 1 })
      .returning();
    await db.insert(turns).values({ conversationId: conversation!.id, role: 'user', text: 'old' });

    const app = await makeApp();
    await send(app, 'forged first');
    expect(seen.at(-1)).toEqual([]);
    await fieldAfterWrites(1);
    await app.close();
  });
});

describe('specs/019 § Only bound turns enter history and the turn cap', () => {
  it('neither shows unbound turns to the model nor counts them toward the cap', async () => {
    const app = await makeApp();
    await send(app, 'hello');
    const token = await fieldAfterWrites(1);

    // One more than the fixture's cap of 25, all inside the hourly rate limit.
    for (let index = 0; index < 26; index++) await send(app, `forged ${index}`);

    const res = await send(app, 'still me', token);
    expect(res.json().content.messages[0].text).toBe('Hi!');
    expect(seen.at(-1)).toEqual(['hello', 'Hi!']);
    expect((await db.query.conversations.findFirst())!.turnCount).toBe(2);
    await app.close();
  });
});

describe('specs/019 § Tokens reach existing contacts before they are required', () => {
  it('lets a request without the token read history when CONTACT_TOKENS_ENFORCED=false', async () => {
    const app = await makeApp({ env: { CONTACT_TOKENS_ENFORCED: 'false' } });
    await send(app, 'hello');
    const token = await fieldAfterWrites(1);

    await send(app, 'no token yet');
    expect(seen.at(-1)).toEqual(['hello', 'Hi!']);
    // A matching token still binds.
    await send(app, 'with token', token);
    expect(logged('turn complete').map(entry => entry.binding)).toEqual([
      'first',
      'unbound',
      'bound',
    ]);
    expect(seen.at(-1)).toEqual(['hello', 'Hi!', 'no token yet', 'Hi!']);
    await app.close();
  });

  it('enforces tokens unless told otherwise, and accepts only true or false', () => {
    expect(loadEnv(baseEnv).CONTACT_TOKENS_ENFORCED).toBe(true);
    expect(loadEnv({ ...baseEnv, CONTACT_TOKENS_ENFORCED: 'false' }).CONTACT_TOKENS_ENFORCED).toBe(
      false,
    );
    expect(() => loadEnv({ ...baseEnv, CONTACT_TOKENS_ENFORCED: 'no' })).toThrow(ConfigError);
  });

  describe('the backfill', () => {
    async function seedContact(
      subscriberId: string,
      options: { ageMs: number; tenantId?: string },
    ) {
      const [conversation] = await db
        .insert(conversations)
        .values({
          tenantId: options.tenantId ?? 'demo',
          subscriberId,
          channel: 'whatsapp',
          turnCount: 1,
        })
        .returning();
      await db.insert(turns).values({
        conversationId: conversation!.id,
        role: 'user',
        text: `asked by ${subscriberId}`,
        createdAt: new Date(Date.now() - options.ageMs),
      });
      return conversation!;
    }

    const client = () =>
      new ManyChatHttpClient({
        apiToken: 'tok',
        replyField: 'ai_message',
        replyFlowNs: 'flow',
        tokenField: 'ai_token',
        requestsPerSecond: 1000,
        fetchImpl: api.fetch,
      });
    const scope = () => ({ tenantId: 'demo', since: new Date(Date.now() - 30 * DAY_MS) });

    it('issues a token to every contact with a turn in the window, and to no one else', async () => {
      await seedContact('recent', { ageMs: 5 * DAY_MS });
      await seedContact('lapsed', { ageMs: 40 * DAY_MS });
      await seedContact('elsewhere', { ageMs: DAY_MS, tenantId: 'other' });
      const already = await seedContact('already', { ageMs: DAY_MS });
      await new ContactTokens(db, client()).issue({
        tenantId: 'demo',
        subscriberId: 'already',
        conversationId: already.id,
      });
      expect(await countContactsWithoutTokens(db, scope())).toBe(1);

      const result = await backfillContactTokens(db, new ContactTokens(db, client()), scope());
      expect(result).toEqual({ written: 1, queued: 0 });
      expect(api.fieldOf('recent')).not.toBeNull();
      expect(api.fieldOf('lapsed')).toBeNull();
      expect(api.fieldOf('elsewhere')).toBeNull();
      expect(await countContactsWithoutTokens(db, scope())).toBe(0);
    });

    it('queues a failed write for the outbox worker rather than stopping', async () => {
      await seedContact('first', { ageMs: DAY_MS });
      await seedContact('second', { ageMs: DAY_MS });
      api.state.failing = true;

      const result = await backfillContactTokens(db, new ContactTokens(db, client()), scope());
      expect(result).toEqual({ written: 0, queued: 2 });
      expect((await tokenJobs()).map(job => job.status)).toEqual(['pending', 'pending']);
    });

    it("keeps an existing contact's history for the request carrying the new token", async () => {
      await seedContact(CONTACT, { ageMs: 5 * DAY_MS });
      await backfillContactTokens(db, new ContactTokens(db, client()), scope());

      const app = await makeApp();
      await send(app, 'back again', api.fieldOf(CONTACT));
      expect(seen.at(-1)).toEqual([`asked by ${CONTACT}`]);
      await app.close();
    });
  });
});
