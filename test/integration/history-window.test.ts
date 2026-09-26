import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '../helpers/db.ts';
import type { Database } from '../../src/db/client.ts';
import { conversations, turns } from '../../src/db/schema.ts';
import { TurnHandler } from '../../src/routes/turn.ts';
import type { AgentRunner, AgentResult } from '../../src/agent/runner.ts';
import { RulesSchema } from '../../src/contracts/config.ts';
import type { InboundMessage } from '../../src/contracts/agent.ts';
import { ConversationStore } from '../../src/conversation/store.ts';

/** specs/018-history-window-and-turn-cap.md § Verification. */

let db: Database;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
});
afterEach(async () => {
  await close();
});

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// Defaults on purpose: 25 turns, 24 hours, 30 days.
const rules = RulesSchema.parse({
  messages: { acknowledgement: 'One moment.', escalation: 'Passing you to a person.' },
  budget: {},
  rateLimit: {},
});

const inbound = (text: string): InboundMessage => ({
  tenantId: 'demo',
  subscriberId: 's1',
  text,
  channel: 'whatsapp',
  contactName: null,
  locale: null,
  receivedAt: new Date(),
});

const result: AgentResult = {
  reply: {
    messages: ['ok'],
    escalate: false,
    escalation_reason: null,
    closing_question: null,
    confidence: 0.9,
  },
  model: 'mock:demo',
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, costUsd: 0.0001 },
  interventions: [],
  latencyMs: 1,
};

function recordingRunner() {
  const seen: { role: string; text: string }[][] = [];
  const runner: AgentRunner = {
    run: ({ history }) => {
      seen.push(history);
      return Promise.resolve(result);
    },
  };
  return { runner, seen };
}

const handler = (runner: AgentRunner) =>
  new TurnHandler({
    db,
    runner,
    rules,
    logger: { info: vi.fn(), error: vi.fn() },
    raceDeadlineMs: 1000,
    modelAbortMs: 5000,
  });

const contact = { tenantId: 'demo', subscriberId: 's1', channel: 'whatsapp', idleResetHours: 24 };

describe('turn cap', () => {
  it('escalates the 26th message when there was no gap', async () => {
    const { runner, seen } = recordingRunner();
    for (let index = 1; index <= 25; index++) await handler(runner).handle(inbound(`m${index}`));

    const out = await handler(runner).handle(inbound('m26'));
    expect(out.outcome).toBe('escalated_precheck');
    expect(seen).toHaveLength(25);
  });

  it('lets the next message reach the model after a 25-hour gap', async () => {
    const { runner, seen } = recordingRunner();
    for (let index = 1; index <= 25; index++) await handler(runner).handle(inbound(`m${index}`));
    await db
      .update(conversations)
      .set({ lastMessageAt: new Date(Date.now() - 25 * HOUR_MS) })
      .where(eq(conversations.subscriberId, 's1'));

    const out = await handler(runner).handle(inbound('back again'));
    expect(out.outcome).toBe('answered_inline');
    expect(seen).toHaveLength(26);
  });

  it('starts the count at one on a gap of exactly idleResetHours, and not a minute short', async () => {
    const store = new ConversationStore(db);
    const start = new Date('2026-03-01T10:00:00Z');
    const later = (ms: number) => new Date(start.getTime() + ms);
    await store.startTurn(contact, start);

    const short = await store.startTurn(contact, later(24 * HOUR_MS - 60_000));
    expect(short.turnCount).toBe(2);

    const exact = await store.startTurn(contact, later(48 * HOUR_MS - 60_000));
    expect(exact.turnCount).toBe(1);
  });

  it('does not move the gap backwards when a request reads an older clock', async () => {
    const store = new ConversationStore(db);
    const start = new Date('2026-03-01T10:00:00Z');
    await store.startTurn(contact, start);
    await store.startTurn(contact, new Date(start.getTime() - 1000));
    const row = await store.find('demo', 's1');
    const stored = await db.query.conversations.findFirst({
      where: eq(conversations.id, row!.id),
    });
    expect(stored!.lastMessageAt).toEqual(start);
  });
});

describe('history', () => {
  async function seed(entries: { text: string; ageMs: number }[]) {
    const conversation = await new ConversationStore(db).startTurn(contact);
    for (const entry of entries) {
      await db.insert(turns).values({
        conversationId: conversation.id,
        role: 'user',
        text: entry.text,
        createdAt: new Date(Date.now() - entry.ageMs),
      });
    }
  }

  it('passes a turn from 29 days ago and not one from 31 days ago', async () => {
    await seed([
      { text: 'asked 31 days ago', ageMs: 31 * DAY_MS },
      { text: 'asked 29 days ago', ageMs: 29 * DAY_MS },
    ]);
    const { runner, seen } = recordingRunner();
    await handler(runner).handle(inbound('hello again'));

    expect(seen[0]!.map(entry => entry.text)).toEqual(['asked 29 days ago']);
  });

  it('passes no more than ten turns', async () => {
    await seed(
      Array.from({ length: 15 }, (_unused, index) => ({ text: `t${index}`, ageMs: DAY_MS })),
    );
    const { runner, seen } = recordingRunner();
    await handler(runner).handle(inbound('latest'));

    // The current message is the tenth; the runner adds it itself.
    expect(seen[0]!.map(entry => entry.text)).toEqual([
      't6',
      't7',
      't8',
      't9',
      't10',
      't11',
      't12',
      't13',
      't14',
    ]);
  });

  it('keeps context while resetting the cap for a contact back after two weeks', async () => {
    const { runner, seen } = recordingRunner();
    for (let index = 1; index <= 25; index++) await handler(runner).handle(inbound(`m${index}`));
    const twoWeeksAgo = new Date(Date.now() - 14 * DAY_MS);
    await db.update(conversations).set({ lastMessageAt: twoWeeksAgo });
    await db.update(turns).set({ createdAt: twoWeeksAgo });

    const out = await handler(runner).handle(inbound('back after two weeks'));
    expect(out.outcome).toBe('answered_inline');
    expect(
      seen
        .at(-1)!
        .map(entry => entry.text)
        .slice(-2),
    ).toEqual(['m25', 'ok']);
  });
});

describe('rules', () => {
  const base = {
    messages: { acknowledgement: 'One moment.', escalation: 'Passing you to a person.' },
    budget: {},
    rateLimit: {},
  };

  it.each([
    ['historyDays', 0],
    ['historyDays', 1.5],
    ['idleResetHours', 0],
    ['idleResetHours', 1.5],
  ])('refuses %s of %s', (field, value) => {
    expect(RulesSchema.safeParse({ ...base, [field]: value }).success).toBe(false);
  });
});
