import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { asc } from 'drizzle-orm';
import { createTestDatabase } from '../helpers/db.ts';
import type { Database } from '../../src/db/client.ts';
import { turns } from '../../src/db/schema.ts';
import { TurnHandler } from '../../src/turn/handler.ts';
import type { TurnResult } from '../../src/turn/handler.ts';
import { TurnLanes } from '../../src/conversation/turns.ts';
import type { AgentRunner, AgentTurnInput } from '../../src/agent/runner.ts';
import { RulesSchema } from '../../src/contracts/config.ts';
import type { InboundMessage } from '../../src/contracts/agent.ts';
import { FakeContactFields } from '../helpers/manychat.ts';

/**
 * specs/047-a-burst-window-before-the-model.md § Verification items 2 to 5.
 * The model is the only fake besides ManyChat, and answers at once, so every
 * fold here is the window's and none is a wait behind a running model call.
 * Every message is invented.
 */

let db: Database;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
});
afterEach(async () => {
  await close();
});

const baseRules = {
  messages: { acknowledgement: 'One moment.', escalation: 'Passing you to a person.' },
  budget: { dailyTokenCap: 100_000, dailyCostCapUsd: 5 },
  rateLimit: { turnsPerSubscriberPerHour: 60 },
  escalationKeywords: ['refund'],
  openingTrigger: { keywords: ['start workflow'], message: 'Hi! How can I help?' },
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function recordingRunner() {
  const seen: { text: string; history: string[] }[] = [];
  const runner: AgentRunner = {
    run: ({ text, history }: AgentTurnInput) => {
      seen.push({ text, history: history.map(turn => `${turn.role}: ${turn.text}`) });
      return Promise.resolve({
        reply: {
          messages: [`reply to ${text}`],
          escalate: false,
          escalation_reason: null,
          confidence: 0.9,
          closing_question: null,
        },
        model: 'mock:demo',
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, costUsd: 0.001 },
        interventions: [],
        latencyMs: 5,
        toolsOffered: false,
      });
    },
  };
  return { runner, seen };
}

const inbound = (text: string): InboundMessage => ({
  tenantId: 'demo',
  subscriberId: 's1',
  text,
  channel: 'whatsapp',
  contactName: null,
  locale: null,
  contactToken: null,
  receivedAt: new Date(),
});

function handler(
  runner: AgentRunner,
  lanes: TurnLanes,
  opts: { burstWindowMs?: number; raceDeadlineMs?: number; tokensEnforced?: boolean } = {},
) {
  return new TurnHandler({
    db,
    runner,
    rules: RulesSchema.parse({ ...baseRules, burstWindowMs: opts.burstWindowMs ?? 300 }),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    raceDeadlineMs: opts.raceDeadlineMs ?? 2_000,
    modelAbortMs: 10_000,
    tokenWriter: new FakeContactFields(),
    tokensEnforced: opts.tokensEnforced ?? false,
    actions: { performAction: () => Promise.resolve() },
    lanes,
  });
}

/** Sends `texts` `gapMs` apart, each to a fresh handler sharing one lane. */
async function burst(
  texts: string[],
  opts: Parameters<typeof handler>[2] & { gapMs?: number } = {},
) {
  const lanes = new TurnLanes(20_000);
  const { runner, seen } = recordingRunner();
  const pending: Promise<TurnResult>[] = [];
  for (const text of texts) {
    pending.push(handler(runner, lanes, opts).handle(inbound(text)));
    await sleep(opts.gapMs ?? 50);
  }
  return { results: await Promise.all(pending), seen };
}

const sent = (results: TurnResult[]) =>
  results.filter(found => !found.silent).map(found => found.reply.messages);

const queuedReplies = async () =>
  (await db.query.outbox.findMany({ orderBy: (row, { asc: up }) => [up(row.createdAt)] }))
    .filter(row => row.kind === 'reply')
    .map(row => (row.payload as { messages: string[] }).messages);

describe('bubbles inside the window (specs/047 V2)', () => {
  it('get one reply, from the last, whose history holds them all', async () => {
    const { results, seen } = await burst(['hi', 'I wanted to ask', 'about the evening course']);

    expect(seen.map(call => call.text)).toEqual(['about the evening course']);
    expect(results.map(found => found.outcome)).toEqual(['folded', 'folded', 'answered_inline']);
    expect(sent(results)).toEqual([['reply to about the evening course']]);
    expect(seen[0]!.history).toEqual(['user: hi', 'user: I wanted to ask']);
    const rows = await db.select().from(turns).orderBy(asc(turns.seq));
    expect(rows.map(row => `${row.role}: ${row.text}`)).toEqual([
      'user: hi',
      'user: I wanted to ask',
      'user: about the evening course',
      'agent: reply to about the evening course',
    ]);
  });
});

describe('a message the window passes in silence (specs/047 V3)', () => {
  it('is answered after the window, on its own', async () => {
    const started = Date.now();
    const { results } = await burst(['how much is it?'], { gapMs: 0 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
    expect(sent(results)).toEqual([['reply to how much is it?']]);
  });

  it('is not folded into a bubble sent after the window', async () => {
    const { results, seen } = await burst(['hi', 'how much is it?'], {
      burstWindowMs: 100,
      gapMs: 250,
    });
    expect(seen.map(call => call.text)).toEqual(['hi', 'how much is it?']);
    expect(sent(results)).toEqual([['reply to hi'], ['reply to how much is it?']]);
  });
});

describe('messages that never wait (specs/047 V4)', () => {
  const quick = async (message: InboundMessage, opts: Parameters<typeof handler>[2] = {}) => {
    const { runner } = recordingRunner();
    const started = Date.now();
    const found = await handler(runner, new TurnLanes(20_000), {
      burstWindowMs: 4_000,
      raceDeadlineMs: 6_000,
      ...opts,
    }).handle(message);
    return { found, elapsed: Date.now() - started };
  };

  it('a message with an escalation keyword', async () => {
    const { found, elapsed } = await quick(inbound('I want a refund'));
    expect(found.outcome).toBe('escalated_precheck');
    expect(elapsed).toBeLessThan(2_000);
  });

  it('the opening sentinel', async () => {
    const { found, elapsed } = await quick(inbound('start workflow'));
    expect(found.outcome).toBe('answered_scripted');
    expect(elapsed).toBeLessThan(2_000);
  });

  it('a media message', async () => {
    const { elapsed } = await quick({
      ...inbound(''),
      media: { kind: 'audio', url: 'https://media.example.com/clip.ogg' },
    });
    expect(elapsed).toBeLessThan(2_000);
  });

  it('a turn that reads no history (specs/019)', async () => {
    const { found, elapsed } = await quick(inbound('hi'), { tokensEnforced: true });
    expect(found.outcome).toBe('answered_inline');
    expect(elapsed).toBeLessThan(2_000);
  });
});

describe('a window that reaches the deadline (specs/047 V5)', () => {
  it('is answered silently at the deadline, and its reply follows from the outbox', async () => {
    const lanes = new TurnLanes(20_000);
    const { runner } = recordingRunner();
    const started = Date.now();
    const found = await handler(runner, lanes, { burstWindowMs: 400, raceDeadlineMs: 150 }).handle(
      inbound('how much is it?'),
    );
    expect(Date.now() - started).toBeLessThan(400);
    expect(found.silent).toBe(true);
    for (let tries = 0; tries < 100 && (await queuedReplies()).length === 0; tries++) {
      await sleep(20);
    }
    expect(await queuedReplies()).toEqual([['reply to how much is it?']]);
  });

  it('is folded from behind the deadline when the contact writes again', async () => {
    const lanes = new TurnLanes(20_000);
    const { runner, seen } = recordingRunner();
    const opts = { burstWindowMs: 400, raceDeadlineMs: 150 };
    const first = await handler(runner, lanes, opts).handle(inbound('hi'));
    expect(first.silent).toBe(true);
    const last = handler(runner, lanes, opts).handle(inbound('how much is it?'));
    await last;
    for (let tries = 0; tries < 100 && (await queuedReplies()).length === 0; tries++) {
      await sleep(20);
    }
    expect(seen.map(call => call.text)).toEqual(['how much is it?']);
    expect(await queuedReplies()).toEqual([['reply to how much is it?']]);
  });
});
