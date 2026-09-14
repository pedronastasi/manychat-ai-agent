import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDatabase } from '../helpers/db.ts';
import type { Database } from '../../src/db/client.ts';
import { handleTurn, ACK_MESSAGE } from '../../src/routes/turn.ts';
import type { AgentRunner, AgentResult } from '../../src/agent/runner.ts';
import { RulesSchema } from '../../src/contracts/config.ts';
import type { InboundMessage } from '../../src/contracts/agent.ts';
import { claimBatch } from '../../src/outbox/queue.ts';
import { recordSpend } from '../../src/conversation/budget.ts';

/** specs/004-testing.md P2 — the untested branches of the race. */

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
  maxTurnsPerConversation: 5,
  budget: { dailyTokenCap: 10_000, dailyCostCapUsd: 1 },
  rateLimit: { turnsPerSubscriberPerHour: 3 },
});

const logger = { info: vi.fn(), error: vi.fn() };

const inbound = (text: string, subscriberId = 's1'): InboundMessage => ({
  tenantId: 'demo',
  subscriberId,
  text,
  channel: 'whatsapp',
  contactName: null,
  locale: null,
  receivedAt: new Date(),
});

const result = (messages: string[], escalate = false): AgentResult => ({
  reply: {
    messages,
    escalate,
    escalation_reason: escalate ? 'out_of_scope' : null,
    confidence: 0.9,
  },
  usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, costUsd: 0.001 },
  interventions: [],
  latencyMs: 5,
});

const deps = (
  runner: AgentRunner,
  over: Partial<{ raceDeadlineMs: number; modelAbortMs: number }> = {},
) => ({
  db,
  runner,
  rules,
  logger,
  raceDeadlineMs: over.raceDeadlineMs ?? 200,
  modelAbortMs: over.modelAbortMs ?? 5000,
});

const fast: AgentRunner = { run: () => Promise.resolve(result(['listo'])) };

/** Honours the abort signal, as a real runner does (specs/004). */
const slow = (ms: number): AgentRunner => ({
  run: ({ signal }) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve(result(['tarde pero llego'])), ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(t);
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    }),
});

describe('race won', () => {
  it('answers inline and records usage', async () => {
    const out = await handleTurn(deps(fast), inbound('hola'));
    expect(out.outcome).toBe('answered_inline');
    expect(out.reply.messages).toEqual(['listo']);

    const turns = await db.query.turns.findMany();
    expect(turns.map(t => t.role)).toEqual(['user', 'agent']);
    expect(turns.find(t => t.role === 'agent')!.cacheReadTokens).toBe(80);
  });

  it('marks the conversation escalated when the model escalates', async () => {
    const escalating: AgentRunner = { run: () => Promise.resolve(result(['te paso'], true)) };
    const out = await handleTurn(deps(escalating), inbound('algo raro'));
    expect(out.outcome).toBe('escalated_model');
    expect((await db.query.conversations.findFirst())!.escalatedAt).toBeInstanceOf(Date);
  });

  it('accumulates spend so the budget cap can see it', async () => {
    await handleTurn(deps(fast), inbound('hola'));
    const counter = await db.query.budgetCounters.findFirst();
    expect(counter!.tokens).toBe(120);
    expect(Number(counter!.costUsd)).toBeCloseTo(0.001, 6);
  });
});

describe('race lost', () => {
  it('acknowledges, then delivers the real answer via the outbox', async () => {
    const out = await handleTurn(deps(slow(600)), inbound('lento'));
    expect(out.outcome).toBe('deferred');
    expect(out.reply.messages).toEqual([ACK_MESSAGE]);

    await vi.waitFor(async () => expect(await claimBatch(db, 10)).toHaveLength(1), {
      timeout: 3000,
    });
  });

  it('does not cancel the in-flight call when the deadline passes', async () => {
    // ADR-0001: those tokens are already paid for and the answer is still
    // wanted. Cancelling here is what makes the deferred path pointless.
    let completed = false;
    const runner: AgentRunner = {
      run: () =>
        new Promise(resolve =>
          setTimeout(() => {
            completed = true;
            resolve(result(['x']));
          }, 500),
        ),
    };
    await handleTurn(deps(runner), inbound('lento'));
    await vi.waitFor(() => expect(completed).toBe(true), { timeout: 3000 });
  });

  it('records the deferred turn and its spend once the model finishes', async () => {
    await handleTurn(deps(slow(500)), inbound('lento'));
    await vi.waitFor(
      async () => {
        const agentTurn = (await db.query.turns.findMany()).find(t => t.role === 'agent');
        expect(agentTurn?.outcome).toBe('deferred');
      },
      { timeout: 3000 },
    );
  });

  it('logs rather than crashing when the deferred model call fails', async () => {
    const failing: AgentRunner = {
      run: () => new Promise((_r, reject) => setTimeout(() => reject(new Error('late boom')), 400)),
    };
    const out = await handleTurn(deps(failing), inbound('lento'));
    expect(out.outcome).toBe('deferred');

    await vi.waitFor(() => expect(logger.error).toHaveBeenCalled(), { timeout: 3000 });
    expect(await claimBatch(db, 10)).toHaveLength(0);
  });
});

describe('failing closed', () => {
  it('escalates before the model on a keyword, without calling it', async () => {
    const spy = vi.fn();
    const out = await handleTurn(
      deps({
        run: () => {
          spy();
          return Promise.resolve(result(['no']));
        },
      }),
      inbound('quiero hablar con una persona'),
    );
    expect(out.outcome).toBe('escalated_precheck');
    expect(spy).not.toHaveBeenCalled();
  });

  it('escalates when the conversation exceeds its turn cap', async () => {
    for (let i = 0; i < 5; i++) await handleTurn(deps(fast), inbound(`m${i}`, 'capped'));
    const out = await handleTurn(deps(fast), inbound('one too many', 'capped'));
    expect(out.outcome).toBe('escalated_precheck');
  });

  it('escalates when the daily budget is already spent', async () => {
    await recordSpend(db, 'demo', 0, 2);
    const out = await handleTurn(deps(fast), inbound('hola', 'broke'));
    expect(out.outcome).toBe('escalated_precheck');
  });

  it('escalates to a human when the model throws immediately', async () => {
    const boom: AgentRunner = { run: () => Promise.reject(new Error('provider down')) };
    const out = await handleTurn(deps(boom), inbound('hola'));
    expect(out.outcome).toBe('error');
    expect(out.reply.escalate).toBe(true);
    expect((await db.query.conversations.findFirst())!.escalatedAt).toBeInstanceOf(Date);
  });

  it('treats an abort as an error rather than a silent success', async () => {
    const out = await handleTurn(
      deps(slow(10_000), { raceDeadlineMs: 5000, modelAbortMs: 100 }),
      inbound('hola'),
    );
    expect(out.outcome).toBe('error');
    expect(out.reply.escalate).toBe(true);
  });
});

describe('history', () => {
  it('passes prior turns to the model without duplicating the current message', async () => {
    const seen: { role: string; text: string }[][] = [];
    const recording: AgentRunner = {
      run: ({ history }) => {
        seen.push(history);
        return Promise.resolve(result(['ok']));
      },
    };
    await handleTurn(deps(recording), inbound('primera', 'hist'));
    await handleTurn(deps(recording), inbound('segunda', 'hist'));

    expect(seen[0]).toEqual([]);
    expect(seen[1]!.map(h => h.text)).toEqual(['primera', 'ok']);
  });
});
