import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDatabase } from '../helpers/db.ts';
import type { Database } from '../../src/db/client.ts';
import { ConversationStore } from '../../src/conversation/store.ts';
import { BudgetGuard, checkKeywords, checkTurnCap } from '../../src/conversation/budget.ts';
import { RulesSchema } from '../../src/contracts/config.ts';

let db: Database;
let store: ConversationStore;
let budget: BudgetGuard;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
  store = new ConversationStore(db);
  budget = new BudgetGuard(db);
});
afterEach(async () => {
  await close();
});

const rules = RulesSchema.parse({
  messages: { acknowledgement: 'One moment.', escalation: 'Passing you to a person.' },
  escalationKeywords: ['speak to a human'],
  budget: { dailyTokenCap: 1000, dailyCostCapUsd: 0.5 },
  rateLimit: { turnsPerSubscriberPerHour: 3 },
});

describe('conversation store', () => {
  it('creates once and increments turn count thereafter', async () => {
    const first = await store.startTurn({
      tenantId: 'demo',
      subscriberId: 's1',
      channel: 'whatsapp',
      idleResetHours: 24,
    });
    const second = await store.startTurn({
      tenantId: 'demo',
      subscriberId: 's1',
      channel: 'whatsapp',
      idleResetHours: 24,
    });
    expect(first.id).toBe(second.id);
    expect(first.turnCount).toBe(1);
    expect(second.turnCount).toBe(2);
  });

  it('isolates subscribers and tenants', async () => {
    const demoTurn = await store.startTurn({
      tenantId: 'demo',
      subscriberId: 's1',
      channel: 'whatsapp',
      idleResetHours: 24,
    });
    const otherTurn = await store.startTurn({
      tenantId: 'other',
      subscriberId: 's1',
      channel: 'whatsapp',
      idleResetHours: 24,
    });
    expect(demoTurn.id).not.toBe(otherTurn.id);
  });

  it('survives concurrent turns from the same subscriber', async () => {
    // People send three messages in a row; ManyChat delivers them concurrently.
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        store.startTurn({
          tenantId: 'demo',
          subscriberId: 's1',
          channel: 'whatsapp',
          idleResetHours: 24,
        }),
      ),
    );
    expect(new Set(results.map(row => row.id)).size).toBe(1);
    const found = await store.find('demo', 's1');
    expect(found?.turnCount).toBe(5);
  });

  it('returns history oldest-first', async () => {
    const conversation = await store.startTurn({
      tenantId: 'demo',
      subscriberId: 's1',
      channel: 'whatsapp',
      idleResetHours: 24,
    });
    await store.recordUserMessage(conversation.id, 'first');
    await store.recordAgentReply(conversation.id, 'reply', 'answered_inline', {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 8,
      costUsd: 0.0001,
      model: 'anthropic:claude-haiku-4-5',
    });
    await store.recordUserMessage(conversation.id, 'second');
    const history = await store.recentTurns(conversation.id, new Date(0));
    expect(history.map(turn => turn.text)).toEqual(['first', 'reply', 'second']);
  });

  it('records escalation', async () => {
    const conversation = await store.startTurn({
      tenantId: 'demo',
      subscriberId: 's1',
      channel: 'whatsapp',
      idleResetHours: 24,
    });
    await store.markEscalated(conversation.id);
    expect((await store.find('demo', 's1'))?.escalatedAt).toBeInstanceOf(Date);
  });
});

describe('guards', () => {
  it('allows up to the rate limit then denies', async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await budget.checkRateLimit('demo', 's1', rules)).allowed).toBe(true);
    }
    const denied = await budget.checkRateLimit('demo', 's1', rules);
    expect(denied.allowed).toBe(false);
  });

  it('counts concurrent turns without losing increments', async () => {
    const out = await Promise.all(
      Array.from({ length: 6 }, () => budget.checkRateLimit('demo', 's2', rules)),
    );
    expect(out.filter(outcome => outcome.allowed).length).toBe(3);
  });

  it('denies once the daily cost cap is spent', async () => {
    expect((await budget.checkBudget('demo', rules)).allowed).toBe(true);
    await budget.recordSpend('demo', 10, 0.6);
    expect((await budget.checkBudget('demo', rules)).allowed).toBe(false);
  });

  it('denies once the daily token cap is spent', async () => {
    await budget.recordSpend('demo', 1000, 0.01);
    expect((await budget.checkBudget('demo', rules)).allowed).toBe(false);
  });

  it('accumulates spend across calls', async () => {
    await budget.recordSpend('demo', 100, 0.1);
    await budget.recordSpend('demo', 100, 0.1);
    expect((await budget.checkBudget('demo', rules)).allowed).toBe(true);
    await budget.recordSpend('demo', 100, 0.35);
    expect((await budget.checkBudget('demo', rules)).allowed).toBe(false);
  });

  it('matches escalation keywords case-insensitively', () => {
    expect(checkKeywords('i want to SPEAK TO A HUMAN now', rules).allowed).toBe(false);
    expect(checkKeywords('how much is the course?', rules).allowed).toBe(true);
  });

  it('caps conversation length', async () => {
    expect(checkTurnCap(25, rules).allowed).toBe(true);
    expect(checkTurnCap(26, rules).allowed).toBe(false);
  });
});
