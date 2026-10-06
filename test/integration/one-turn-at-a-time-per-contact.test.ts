import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { createTestDatabase } from '../helpers/db.ts';
import type { Database } from '../../src/db/client.ts';
import { turns } from '../../src/db/schema.ts';
import { TurnHandler } from '../../src/routes/turn.ts';
import { TurnLanes } from '../../src/conversation/turns.ts';
import type { AgentRunner, AgentResult, AgentTurnInput } from '../../src/agent/runner.ts';
import { RulesSchema } from '../../src/contracts/config.ts';
import type { InboundMessage } from '../../src/contracts/agent.ts';
import { OutboxQueue } from '../../src/outbox/queue.ts';
import { buildServer } from '../../src/server.ts';
import { loadEnv, ConfigStore } from '../../src/config/loader.ts';
import { FakeContactFields, fakeManyChatApi } from '../helpers/manychat.ts';

/**
 * specs/037-one-turn-at-a-time-per-contact.md § Verification items 2 to 7. The
 * model is the only fake besides ManyChat: each call records the history it
 * was given and answers after a delay the test chooses.
 */

let db: Database;
let close: () => Promise<void>;
let contactFields: FakeContactFields;
beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
  contactFields = new FakeContactFields();
});
afterEach(async () => {
  await close();
});

const rules = RulesSchema.parse({
  messages: { acknowledgement: 'One moment.', escalation: 'Passing you to a person.' },
  budget: { dailyTokenCap: 100_000, dailyCostCapUsd: 5 },
  rateLimit: { turnsPerSubscriberPerHour: 60 },
});

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
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

/** Answers "reply to <text>" after `delayMs(text)`, keeping the history each call saw. */
function recordingRunner(delayMs: (text: string) => number) {
  const seen: { text: string; history: string[] }[] = [];
  const runner: AgentRunner = {
    run: async ({ text, history }: AgentTurnInput) => {
      seen.push({ text, history: history.map(turn => `${turn.role}: ${turn.text}`) });
      await sleep(delayMs(text));
      return result(`reply to ${text}`);
    },
  };
  return { runner, seen };
}

const inbound = (text: string, contactToken: string | null = null): InboundMessage => ({
  tenantId: 'demo',
  subscriberId: 's1',
  text,
  channel: 'whatsapp',
  contactName: null,
  locale: null,
  contactToken,
  receivedAt: new Date(),
});

function handler(
  runner: AgentRunner,
  lanes: TurnLanes,
  opts: { raceDeadlineMs?: number; tokensEnforced?: boolean } = {},
) {
  return new TurnHandler({
    db,
    runner,
    rules,
    logger,
    raceDeadlineMs: opts.raceDeadlineMs ?? 2_000,
    modelAbortMs: 10_000,
    tokenWriter: contactFields,
    tokensEnforced: opts.tokensEnforced ?? false,
    actions: { performAction: () => Promise.resolve() },
    lanes,
  });
}

const recorded = async () =>
  (await db.select().from(turns).orderBy(asc(turns.seq))).map(turn => `${turn.role}: ${turn.text}`);

const replyRows = async () =>
  (await db.query.outbox.findMany({ orderBy: (row, { asc: up }) => [up(row.createdAt)] })).filter(
    row => row.kind === 'reply',
  );

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let tries = 0; tries < 150; tries++) {
    const value = await read();
    if (done(value)) return value;
    await sleep(20);
  }
  throw new Error('never settled');
}

describe('a second message waits for the first turn (specs/037 V2)', () => {
  it('reads the first reply, and lands in history after it', async () => {
    const lanes = new TurnLanes(20_000);
    const { runner, seen } = recordingRunner(text => (text === 'first' ? 200 : 0));

    const first = handler(runner, lanes).handle(inbound('first'));
    await sleep(50);
    const second = handler(runner, lanes).handle(inbound('second'));
    const [one, two] = await Promise.all([first, second]);

    expect(one.reply.messages).toEqual(['reply to first']);
    expect(two.reply.messages).toEqual(['reply to second']);
    expect(seen[1]).toEqual({
      text: 'second',
      history: ['user: first', 'agent: reply to first'],
    });
    expect(await recorded()).toEqual([
      'user: first',
      'agent: reply to first',
      'user: second',
      'agent: reply to second',
    ]);
  });

  it('never holds another contact', async () => {
    const lanes = new TurnLanes(20_000);
    const { runner } = recordingRunner(text => (text === 'first' ? 300 : 0));
    const first = handler(runner, lanes).handle(inbound('first'));
    await sleep(20);
    const started = Date.now();
    await handler(runner, lanes).handle({ ...inbound('hello'), subscriberId: 's2' });
    expect(Date.now() - started).toBeLessThan(250);
    await first;
  });
});

describe('a turn still waiting at its deadline (specs/037 V3)', () => {
  it('is answered silently, and its reply is queued after the first', async () => {
    const lanes = new TurnLanes(20_000);
    const { runner, seen } = recordingRunner(text => (text === 'first' ? 600 : 0));
    const deadline = { raceDeadlineMs: 200 };

    const first = await handler(runner, lanes, deadline).handle(inbound('first'));
    expect(first.outcome).toBe('deferred');
    expect(first.reply.messages).toEqual(['One moment.']);

    const second = await handler(runner, lanes, deadline).handle(inbound('second'));
    expect(second).toMatchObject({ outcome: 'deferred', silent: true });
    expect(second.reply.messages).toEqual([]);

    const rows = await eventually(replyRows, found => found.length === 2);
    expect(rows.map(row => (row.payload as { messages: string[] }).messages)).toEqual([
      ['reply to first'],
      ['reply to second'],
    ]);
    expect(rows[1]!.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(
      rows[0]!.nextAttemptAt.getTime(),
    );
    expect(seen[1]!.history).toEqual(['user: first', 'agent: reply to first']);
  });
});

describe('a reply to the contact still queued (specs/037 V4)', () => {
  const queueEarlier = async (notBefore = new Date(Date.now() + 60_000)) => {
    await handler(recordingRunner(() => 0).runner, new TurnLanes(20_000)).handle(inbound('hi'));
    return new OutboxQueue(db).enqueue({
      tenantId: 'demo',
      subscriberId: 's1',
      conversationId: null,
      reply: result('held for a flow').reply,
      notBefore,
    });
  };

  it('queues a turn answered inside the deadline behind it, silently', async () => {
    const notBefore = new Date(Date.now() + 60_000);
    await queueEarlier(notBefore);
    const { runner } = recordingRunner(() => 0);

    const turn = await handler(runner, new TurnLanes(20_000)).handle(inbound('and the dates?'));
    expect(turn).toMatchObject({ outcome: 'answered_inline', silent: true });

    const rows = await replyRows();
    expect(rows.map(row => (row.payload as { messages: string[] }).messages[0])).toEqual([
      'held for a flow',
      'reply to and the dates?',
    ]);
    expect(rows[1]!.nextAttemptAt.getTime()).toBe(notBefore.getTime());
  });

  it('sends no holding line when the race is lost', async () => {
    await queueEarlier();
    const { runner } = recordingRunner(() => 400);
    const turn = await handler(runner, new TurnLanes(20_000), { raceDeadlineMs: 100 }).handle(
      inbound('and the dates?'),
    );
    expect(turn).toMatchObject({ outcome: 'deferred', silent: true });
    await eventually(replyRows, found => found.length === 2);
  });

  it('queues a reply decided without the model behind it too', async () => {
    await queueEarlier();
    const strict = RulesSchema.parse({
      ...rules,
      escalationKeywords: ['refund'],
    });
    const turn = await new TurnHandler({
      db,
      runner: recordingRunner(() => 0).runner,
      rules: strict,
      logger,
      raceDeadlineMs: 2_000,
      modelAbortMs: 10_000,
      tokenWriter: contactFields,
      tokensEnforced: false,
      actions: { performAction: () => Promise.resolve() },
      lanes: new TurnLanes(20_000),
    }).handle(inbound('I want a refund'));
    expect(turn).toMatchObject({ outcome: 'escalated_precheck', silent: true });
    expect(await replyRows()).toHaveLength(2);
  });
});

describe('a turn without the contact token (specs/037 V6)', () => {
  it('neither waits for the contact nor holds them up', async () => {
    const lanes = new TurnLanes(20_000);
    const { runner } = recordingRunner(text => (text === 'bound' ? 400 : 0));
    const enforced = { tokensEnforced: true };
    // The first message issues the contact's token.
    await handler(runner, lanes, enforced).handle(inbound('hi'));
    const token = contactFields.tokenOf('s1');
    expect(token).not.toBeNull();

    const bound = handler(runner, lanes, enforced).handle(inbound('bound', token));
    await sleep(20);
    const started = Date.now();
    const unbound = await handler(runner, lanes, enforced).handle(inbound('unbound', null));
    expect(Date.now() - started).toBeLessThan(300);
    expect(unbound.binding).toBe('unbound');
    expect((await bound).binding).toBe('bound');
  });
});

describe('the server shares one order between requests (specs/037 V7)', () => {
  it("runs a contact's second request after the first, though each has its own handler", async () => {
    const env = loadEnv({
      AGENT_MODEL: 'anthropic:claude-haiku-4-5',
      PUBLIC_BASE_URL: 'https://agent.example.com',
      MANYCHAT_SHARED_SECRET: 'a'.repeat(32),
      MANYCHAT_API_TOKEN: 'tok',
      DATABASE_URL: 'postgres://unused',
      CHANNEL: 'whatsapp',
      TENANT_ID: 'demo',
      RACE_DEADLINE_MS: '2000',
      MODEL_ABORT_MS: '5000',
      CONTACT_TOKENS_ENFORCED: 'false',
      LOG_LEVEL: 'fatal',
    });
    const { runner, seen } = recordingRunner(text => (text === 'first' ? 200 : 0));
    const { app } = await buildServer({
      env,
      db,
      configStore: new ConfigStore('test/fixtures/config'),
      runner,
      manychatFetch: fakeManyChatApi().fetch,
    });
    await app.ready();
    const post = (text: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/channels/manychat/message',
        headers: { authorization: `Bearer ${'a'.repeat(32)}` },
        payload: { subscriber_id: '5550001', text },
      });

    const first = post('first');
    await sleep(50);
    await Promise.all([first, post('second')]);
    expect(seen.find(call => call.text === 'second')?.history).toEqual([
      'user: first',
      'agent: reply to first',
    ]);
    const conversation = await db.query.conversations.findFirst();
    expect(conversation).toBeDefined();
    const contactTurns = await db
      .select()
      .from(turns)
      .where(eq(turns.conversationId, conversation!.id))
      .orderBy(asc(turns.seq));
    expect(contactTurns.map(turn => turn.role)).toEqual(['user', 'agent', 'user', 'agent']);
    await app.close();
  });
});
