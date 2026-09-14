import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDatabase } from '../helpers/db.ts';
import type { Database } from '../../src/db/client.ts';
import {
  startTurn,
  recordUserMessage,
  recordAgentReply,
  recentTurns,
  markEscalated,
  findConversation,
} from '../../src/conversation/store.ts';
import {
  checkRateLimit,
  checkBudget,
  recordSpend,
  checkKeywords,
  checkTurnCap,
} from '../../src/conversation/budget.ts';
import { RulesSchema } from '../../src/contracts/config.ts';

let db: Database;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
});
afterEach(async () => {
  await close();
});

const rules = RulesSchema.parse({
  escalationKeywords: ['hablar con una persona'],
  budget: { dailyTokenCap: 1000, dailyCostCapUsd: 0.5 },
  rateLimit: { turnsPerSubscriberPerHour: 3 },
});

describe('conversation store', () => {
  it('creates once and increments turn count thereafter', async () => {
    const a = await startTurn(db, { tenantId: 'demo', subscriberId: 's1', channel: 'whatsapp' });
    const b = await startTurn(db, { tenantId: 'demo', subscriberId: 's1', channel: 'whatsapp' });
    expect(a.id).toBe(b.id);
    expect(a.turnCount).toBe(1);
    expect(b.turnCount).toBe(2);
  });

  it('isolates subscribers and tenants', async () => {
    const a = await startTurn(db, { tenantId: 'demo', subscriberId: 's1', channel: 'whatsapp' });
    const b = await startTurn(db, { tenantId: 'other', subscriberId: 's1', channel: 'whatsapp' });
    expect(a.id).not.toBe(b.id);
  });

  it('survives concurrent turns from the same subscriber', async () => {
    // People send three messages in a row; ManyChat delivers them concurrently.
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        startTurn(db, { tenantId: 'demo', subscriberId: 's1', channel: 'whatsapp' }),
      ),
    );
    expect(new Set(results.map(r => r.id)).size).toBe(1);
    const found = await findConversation(db, 'demo', 's1');
    expect(found?.turnCount).toBe(5);
  });

  it('returns history oldest-first', async () => {
    const c = await startTurn(db, { tenantId: 'demo', subscriberId: 's1', channel: 'whatsapp' });
    await recordUserMessage(db, c.id, 'primera');
    await recordAgentReply(db, c.id, 'respuesta', 'answered_inline', {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 8,
      costUsd: 0.0001,
      model: 'anthropic:claude-haiku-4-5',
    });
    await recordUserMessage(db, c.id, 'segunda');
    const h = await recentTurns(db, c.id);
    expect(h.map(t => t.text)).toEqual(['primera', 'respuesta', 'segunda']);
  });

  it('records escalation', async () => {
    const c = await startTurn(db, { tenantId: 'demo', subscriberId: 's1', channel: 'whatsapp' });
    await markEscalated(db, c.id);
    expect((await findConversation(db, 'demo', 's1'))?.escalatedAt).toBeInstanceOf(Date);
  });
});

describe('guards', () => {
  it('allows up to the rate limit then denies', async () => {
    for (let i = 0; i < 3; i++) {
      expect((await checkRateLimit(db, 'demo', 's1', rules)).allowed).toBe(true);
    }
    const denied = await checkRateLimit(db, 'demo', 's1', rules);
    expect(denied.allowed).toBe(false);
  });

  it('counts concurrent turns without losing increments', async () => {
    const out = await Promise.all(
      Array.from({ length: 6 }, () => checkRateLimit(db, 'demo', 's2', rules)),
    );
    expect(out.filter(r => r.allowed).length).toBe(3);
  });

  it('denies once the daily cost cap is spent', async () => {
    expect((await checkBudget(db, 'demo', rules)).allowed).toBe(true);
    await recordSpend(db, 'demo', 10, 0.6);
    expect((await checkBudget(db, 'demo', rules)).allowed).toBe(false);
  });

  it('denies once the daily token cap is spent', async () => {
    await recordSpend(db, 'demo', 1000, 0.01);
    expect((await checkBudget(db, 'demo', rules)).allowed).toBe(false);
  });

  it('accumulates spend across calls', async () => {
    await recordSpend(db, 'demo', 100, 0.1);
    await recordSpend(db, 'demo', 100, 0.1);
    expect((await checkBudget(db, 'demo', rules)).allowed).toBe(true);
    await recordSpend(db, 'demo', 100, 0.35);
    expect((await checkBudget(db, 'demo', rules)).allowed).toBe(false);
  });

  it('matches escalation keywords case-insensitively', () => {
    expect(checkKeywords('quiero HABLAR CON UNA PERSONA ya', rules).allowed).toBe(false);
    expect(checkKeywords('cuanto sale el curso?', rules).allowed).toBe(true);
  });

  it('caps conversation length', async () => {
    expect(checkTurnCap(25, rules).allowed).toBe(true);
    expect(checkTurnCap(26, rules).allowed).toBe(false);
  });
});
