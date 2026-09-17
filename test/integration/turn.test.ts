import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDatabase } from '../helpers/db.ts';
import type { Database } from '../../src/db/client.ts';
import { TurnHandler } from '../../src/routes/turn.ts';
import type { AgentRunner, AgentResult } from '../../src/agent/runner.ts';
import { RulesSchema } from '../../src/contracts/config.ts';
import type { InboundMessage } from '../../src/contracts/agent.ts';
import { OutboxQueue } from '../../src/outbox/queue.ts';
import { BudgetGuard } from '../../src/conversation/budget.ts';

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
  messages: { acknowledgement: 'One moment.', escalation: 'Passing you to a person.' },
  escalationKeywords: ['speak to a human'],
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
  model: 'mock:demo',
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

const fast: AgentRunner = { run: () => Promise.resolve(result(['done'])) };

/** Honours the abort signal, as a real runner does (specs/004). */
const slow = (ms: number): AgentRunner => ({
  run: ({ signal }) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(result(['late but delivered'])), ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    }),
});

describe('race won', () => {
  it('answers inline and records usage', async () => {
    const out = await new TurnHandler(deps(fast)).handle(inbound('hello'));
    expect(out.outcome).toBe('answered_inline');
    expect(out.reply.messages).toEqual(['done']);

    const turns = await db.query.turns.findMany();
    expect(turns.map(turn => turn.role)).toEqual(['user', 'agent']);
    expect(turns.find(turn => turn.role === 'agent')!.cacheReadTokens).toBe(80);
    // Spend is unattributable after a model switch without this (ADR-0002).
    expect(turns.find(turn => turn.role === 'agent')!.model).toBe('mock:demo');
  });

  it('marks the conversation escalated when the model escalates', async () => {
    const escalating: AgentRunner = {
      run: () => Promise.resolve(result(['passing you over'], true)),
    };
    const out = await new TurnHandler(deps(escalating)).handle(inbound('something odd'));
    expect(out.outcome).toBe('escalated_model');
    expect((await db.query.conversations.findFirst())!.escalatedAt).toBeInstanceOf(Date);
  });

  it('records a failed model call as an error, not as an escalation', async () => {
    // The runner fails closed with the tenant's escalation message, so a dead
    // call is indistinguishable from a deliberate escalation in the chat. It
    // was indistinguishable in the turns table too, which sent a production
    // investigation after the prompt and the budget caps for hours while the
    // real cause was the model never emitting a reply.
    const failing: AgentRunner = {
      run: () =>
        Promise.resolve({
          ...result(['passing you over'], true),
          modelError: 'NoObjectGeneratedError',
          usage: {
            inputTokens: undefined,
            outputTokens: undefined,
            cacheReadTokens: undefined,
            costUsd: 0,
          },
        }),
    };
    const out = await new TurnHandler(deps(failing)).handle(inbound('hola'));
    expect(out.outcome).toBe('error');

    const agentTurn = (await db.query.turns.findMany()).find(turn => turn.role === 'agent')!;
    expect(agentTurn.outcome).toBe('error');
  });

  it('accumulates spend so the budget cap can see it', async () => {
    await new TurnHandler(deps(fast)).handle(inbound('hello'));
    const counter = await db.query.budgetCounters.findFirst();
    expect(counter!.tokens).toBe(120);
    expect(Number(counter!.costUsd)).toBeCloseTo(0.001, 6);
  });
});

describe('race lost', () => {
  it('acknowledges, then delivers the real answer via the outbox', async () => {
    const out = await new TurnHandler(deps(slow(600))).handle(inbound('slow'));
    expect(out.outcome).toBe('deferred');
    expect(out.reply.messages).toEqual([rules.messages.acknowledgement]);

    await vi.waitFor(async () => expect(await new OutboxQueue(db).claimBatch(10)).toHaveLength(1), {
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
    await new TurnHandler(deps(runner)).handle(inbound('slow'));
    await vi.waitFor(() => expect(completed).toBe(true), { timeout: 3000 });
  });

  it('records the deferred turn and its spend once the model finishes', async () => {
    await new TurnHandler(deps(slow(500))).handle(inbound('slow'));
    await vi.waitFor(
      async () => {
        const agentTurn = (await db.query.turns.findMany()).find(turn => turn.role === 'agent');
        expect(agentTurn?.outcome).toBe('deferred');
      },
      { timeout: 3000 },
    );
  });

  it('still bounds the deferred call by MODEL_ABORT_MS', async () => {
    // Losing the race must not cancel the call, but it must not disarm the
    // outer bound either: the deferred path is the only place a call outlives
    // its request, so it is the only place the bound can matter. Clearing the
    // abort timer alongside the deadline timer let a runaway call run forever.
    const out = await new TurnHandler(
      deps(slow(60_000), { raceDeadlineMs: 200, modelAbortMs: 500 }),
    ).handle(inbound('slow'));
    expect(out.outcome).toBe('deferred');

    await vi.waitFor(() => expect(logger.error).toHaveBeenCalled(), { timeout: 3000 });
    expect(await new OutboxQueue(db).claimBatch(10)).toHaveLength(0);
  });

  it('records which model produced the deferred answer', async () => {
    await new TurnHandler(deps(slow(500))).handle(inbound('slow'));
    await vi.waitFor(
      async () => {
        const agentTurn = (await db.query.turns.findMany()).find(turn => turn.role === 'agent');
        expect(agentTurn?.model).toBe('mock:demo');
      },
      { timeout: 3000 },
    );
  });

  it('logs rather than crashing when the deferred model call fails', async () => {
    const failing: AgentRunner = {
      run: () => new Promise((_r, reject) => setTimeout(() => reject(new Error('late boom')), 400)),
    };
    const out = await new TurnHandler(deps(failing)).handle(inbound('slow'));
    expect(out.outcome).toBe('deferred');

    await vi.waitFor(() => expect(logger.error).toHaveBeenCalled(), { timeout: 3000 });
    expect(await new OutboxQueue(db).claimBatch(10)).toHaveLength(0);
  });
});

/** specs/001-agent-behavior.md — "Scripted opening". */
describe('opening trigger', () => {
  const OPENING = 'Welcome! Would you like the course prices?';
  const withTrigger = RulesSchema.parse({
    ...rules,
    openingTrigger: { keywords: ['start workflow', 'iniciar'], message: OPENING },
  });
  const triggerDeps = (runner: AgentRunner) => ({ ...deps(runner), rules: withTrigger });

  it('returns the scripted opening without calling the model', async () => {
    const spy = vi.fn();
    const out = await new TurnHandler(
      triggerDeps({
        run: () => {
          spy();
          return Promise.resolve(result(['no']));
        },
      }),
    ).handle(inbound('start workflow'));

    expect(out.outcome).toBe('answered_scripted');
    expect(out.reply.messages).toEqual([OPENING]);
    expect(out.reply.escalate).toBe(false);
    // The whole point: a determined case must not spend tokens or latency.
    expect(spy).not.toHaveBeenCalled();
  });

  it('spends nothing, so the budget cap cannot be moved by a scripted reply', async () => {
    await new TurnHandler(triggerDeps(fast)).handle(inbound('start workflow'));
    expect(await db.query.budgetCounters.findFirst()).toBeUndefined();
  });

  it('matches the whole message, so a contact cannot replay it by mentioning it', async () => {
    // escalationKeywords match substrings; this deliberately does not, because
    // the sentinel comes from the flow rather than from the contact.
    const out = await new TurnHandler(triggerDeps(fast)).handle(
      inbound('should I start workflow or wait?'),
    );
    expect(out.outcome).toBe('answered_inline');
    expect(out.reply.messages).toEqual(['done']);
  });

  it('ignores case and surrounding whitespace', async () => {
    const out = await new TurnHandler(triggerDeps(fast)).handle(inbound('  Start Workflow  '));
    expect(out.outcome).toBe('answered_scripted');
  });

  it('is inert when no trigger is configured', async () => {
    const out = await new TurnHandler(deps(fast)).handle(inbound('start workflow'));
    expect(out.outcome).toBe('answered_inline');
  });

  it('records the scripted turn so history stays complete', async () => {
    await new TurnHandler(triggerDeps(fast)).handle(inbound('iniciar', 'scripted'));
    const turns = await db.query.turns.findMany();
    expect(turns.map(turn => turn.role)).toEqual(['user', 'agent']);
    const agentTurn = turns.find(turn => turn.role === 'agent')!;
    expect(agentTurn.outcome).toBe('answered_scripted');
    expect(agentTurn.model).toBeNull();
  });
});

describe('failing closed', () => {
  it('escalates before the model on a keyword, without calling it', async () => {
    const spy = vi.fn();
    const out = await new TurnHandler(
      deps({
        run: () => {
          spy();
          return Promise.resolve(result(['no']));
        },
      }),
    ).handle(inbound('i want to speak to a human'));
    expect(out.outcome).toBe('escalated_precheck');
    expect(spy).not.toHaveBeenCalled();
  });

  it('escalates when the conversation exceeds its turn cap', async () => {
    for (let index = 0; index < 5; index++)
      await new TurnHandler(deps(fast)).handle(inbound(`m${index}`, 'capped'));
    const out = await new TurnHandler(deps(fast)).handle(inbound('one too many', 'capped'));
    expect(out.outcome).toBe('escalated_precheck');
  });

  it('escalates when the daily budget is already spent', async () => {
    await new BudgetGuard(db).recordSpend('demo', 0, 2);
    const out = await new TurnHandler(deps(fast)).handle(inbound('hello', 'broke'));
    expect(out.outcome).toBe('escalated_precheck');
  });

  it('escalates to a human when the model throws immediately', async () => {
    const boom: AgentRunner = { run: () => Promise.reject(new Error('provider down')) };
    const out = await new TurnHandler(deps(boom)).handle(inbound('hello'));
    expect(out.outcome).toBe('error');
    expect(out.reply.escalate).toBe(true);
    expect((await db.query.conversations.findFirst())!.escalatedAt).toBeInstanceOf(Date);
  });

  it('treats an abort as an error rather than a silent success', async () => {
    const out = await new TurnHandler(
      deps(slow(10_000), { raceDeadlineMs: 5000, modelAbortMs: 100 }),
    ).handle(inbound('hello'));
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
    await new TurnHandler(deps(recording)).handle(inbound('first', 'hist'));
    await new TurnHandler(deps(recording)).handle(inbound('second', 'hist'));

    expect(seen[0]).toEqual([]);
    expect(seen[1]!.map(entry => entry.text)).toEqual(['first', 'ok']);
  });
});
