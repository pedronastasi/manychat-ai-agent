import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDatabase } from '../helpers/db.ts';
import type { Database } from '../../src/db/client.ts';
import { TurnHandler } from '../../src/turn/handler.ts';
import type { TurnResult } from '../../src/turn/handler.ts';
import { TurnLanes } from '../../src/conversation/turns.ts';
import { LangGraphRunner } from '../../src/agent/langgraph-runner.ts';
import type { AgentResult, AgentRunner } from '../../src/agent/runner.ts';
import { RulesSchema } from '../../src/contracts/config.ts';
import type { InboundMessage } from '../../src/contracts/agent.ts';
import type { Tracing } from '../../src/observability/tracing.ts';
import { TURN_RUN } from '../../src/observability/tracing.ts';
import { FakeContactFields } from '../helpers/manychat.ts';
import { fixtureTenant, scriptedTurns } from '../helpers/conversations.ts';
import type { TurnScript } from '../helpers/conversations.ts';
import { fakeLangSmith } from '../helpers/langsmith.ts';

/**
 * specs/052-traces-carry-shape-not-text.md § Verification: identity, the
 * outcome feedback, the race, and the opt-in, through the real `TurnHandler`
 * with the LangSmith boundary faked. Every string here is invented (C1).
 */

const SUBSCRIBER = 'subscriber-4471';
const TENANT = 'tenant-invented-demo';

let db: Database;
let close: () => Promise<void>;
let contactFields: FakeContactFields;
beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
  contactFields = new FakeContactFields();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await close();
});

const rules = (foldBursts = false) =>
  RulesSchema.parse({
    ...fixtureTenant.rules,
    messages: { acknowledgement: 'One moment.', escalation: 'Passing you to a person.' },
    escalationKeywords: ['refund'],
    budget: { dailyTokenCap: 100_000, dailyCostCapUsd: 5 },
    rateLimit: { turnsPerSubscriberPerHour: 60 },
    foldBursts,
  });

const inbound = (text: string, subscriberId = SUBSCRIBER): InboundMessage => ({
  tenantId: TENANT,
  subscriberId,
  text,
  channel: 'whatsapp',
  contactName: null,
  locale: null,
  contactToken: contactFields.tokenOf(subscriberId),
  receivedAt: new Date(),
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function scriptedRunner(script: TurnScript[]) {
  return new LangGraphRunner({
    model: scriptedTurns(script).model,
    modelSpec: 'mock:demo',
    config: () => fixtureTenant,
    maxOutputTokens: 400,
    temperature: 0.3,
  });
}

function handler(
  runner: AgentRunner,
  tracing: Tracing | undefined,
  opts: { raceDeadlineMs?: number; lanes?: TurnLanes; foldBursts?: boolean } = {},
) {
  return new TurnHandler({
    db,
    runner,
    rules: rules(opts.foldBursts),
    tools: fixtureTenant.tools,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    raceDeadlineMs: opts.raceDeadlineMs ?? 2_000,
    modelAbortMs: 10_000,
    tokenWriter: contactFields,
    tokensEnforced: false,
    actions: { performAction: () => Promise.resolve() },
    lanes: opts.lanes,
    tracing,
  });
}

/** Waits until `ready` holds, as a deferred reply settles on its own time. */
async function until(ready: () => boolean | Promise<boolean>, tries = 150) {
  for (let attempt = 0; attempt < tries && !(await ready()); attempt++) await sleep(20);
}

describe('a trace names a turn by its conversation ID (specs/052 V6)', () => {
  it('carries no subscriber ID and no TENANT_ID, and the conversation of the turn', async () => {
    const langsmith = fakeLangSmith();
    const out = await handler(
      scriptedRunner([{ reply: { messages: ['The evening group has places.'] } }]),
      langsmith.tracing(),
    ).handle(inbound('Is the evening group full?'));
    expect(out.outcome).toBe('answered_inline');
    await langsmith.settle();

    const sent = langsmith.bytes();
    expect(sent).not.toContain(SUBSCRIBER);
    expect(sent).not.toContain(TENANT);
    const conversation = await db.query.conversations.findFirst();
    expect(langsmith.runs().length).toBeGreaterThan(0);
    for (const run of langsmith.runs()) {
      expect(run.extra.metadata.conversation).toBe(conversation!.id);
      expect(run.extra.metadata.turn_kind).toBe('inbound');
    }
  });
});

describe('how the turn ended is one feedback on its root run (specs/052 V8)', () => {
  it('sends answered_inline on the root run the service named', async () => {
    const langsmith = fakeLangSmith();
    await handler(scriptedRunner([{}]), langsmith.tracing()).handle(inbound('hello'));
    await langsmith.settle();

    const root = langsmith.runs().find(run => run.parent_run_id === undefined);
    expect(root?.name).toBe(TURN_RUN);
    expect(langsmith.feedback()).toEqual([
      { run_id: root!.id, key: 'outcome', value: 'answered_inline' },
    ]);
    // The body carries no field but these three.
    expect(Object.keys(langsmith.feedback()[0]!).sort()).toEqual(['key', 'run_id', 'value']);
  });

  it('sends deferred once the graph has finished, for a turn that lost the race', async () => {
    const langsmith = fakeLangSmith();
    const out = await handler(scriptedRunner([{ delayMs: 300 }]), langsmith.tracing(), {
      raceDeadlineMs: 100,
    }).handle(inbound('hello'));
    expect(out.outcome).toBe('deferred');
    await langsmith.settle();
    expect(langsmith.feedback()).toEqual([]);

    await until(async () => {
      await langsmith.settle();
      return langsmith.feedback().length > 0;
    });
    expect(langsmith.feedback().map(entry => entry.value)).toEqual(['deferred']);
  });

  it('sends superseded and nothing else for a reply the contact wrote past', async () => {
    const langsmith = fakeLangSmith();
    const tracing = langsmith.tracing();
    const lanes = new TurnLanes(20_000);
    // The graph's part of the runner contract, played by a runner whose first
    // reply is slow enough for the contact to write again (specs/046).
    const runner: AgentRunner = {
      run: async input => {
        await input.trace?.open([]);
        try {
          await sleep(input.text === 'hi' ? 300 : 0);
          return reply(`reply to ${input.text}`);
        } finally {
          await input.trace?.close();
        }
      },
    };
    const pending: Promise<TurnResult>[] = [];
    for (const text of ['hi', 'I wanted to ask', 'about the evening course']) {
      pending.push(handler(runner, tracing, { lanes, foldBursts: true }).handle(inbound(text)));
      await sleep(20);
    }
    const results = await Promise.all(pending);
    expect(results.map(found => found.outcome)).toEqual([
      'superseded',
      'folded',
      'answered_inline',
    ]);
    await langsmith.settle();

    // One per turn whose model ran: the superseded one and the last; the
    // folded bubble ran nothing and sends nothing.
    expect(langsmith.feedback().map(entry => entry.value)).toEqual([
      'superseded',
      'answered_inline',
    ]);
    const roots = new Set(langsmith.feedback().map(entry => entry.run_id));
    expect(roots.size).toBe(2);
  });

  it('sends no trace and no feedback for a precheck escalation', async () => {
    const langsmith = fakeLangSmith();
    const out = await handler(scriptedRunner([{}]), langsmith.tracing()).handle(
      inbound('I want a refund'),
    );
    expect(out.outcome).toBe('escalated_precheck');
    await langsmith.settle();
    expect(langsmith.requests).toEqual([]);
  });
});

function reply(text: string): AgentResult {
  return {
    reply: {
      messages: [text],
      escalate: false,
      escalation_reason: null,
      confidence: 0.9,
      closing_question: null,
    },
    model: 'mock:demo',
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, costUsd: 0.001 },
    interventions: [],
    latencyMs: 5,
  };
}

describe('the uploader never holds a turn (specs/052 V11)', () => {
  const REPLY = 'The weekend group meets on Saturdays.';

  /** A first turn of a contact of its own, so neither run sees the other's history. */
  async function timedTurn(tracing: Tracing | undefined, subscriber: string) {
    const started = Date.now();
    const out = await handler(scriptedRunner([{ reply: { messages: [REPLY] } }]), tracing, {
      raceDeadlineMs: 1_000,
    }).handle(inbound('When does the weekend group meet?', subscriber));
    return { out, ms: Date.now() - started };
  }

  it.each([
    // Honours the upload's timeout, as a real endpoint's connection does.
    [
      'never answers',
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('timed out')));
        }),
    ],
    ['answers 500', () => new Response('internal error', { status: 500 })],
  ])('answers the same when the endpoint %s', async (_label, answer) => {
    const untraced = await timedTurn(undefined, 'subscriber-untraced');
    const langsmith = fakeLangSmith(answer);
    const traced = await timedTurn(langsmith.tracing(), 'subscriber-traced');

    expect(traced.out.outcome).toBe('answered_inline');
    expect(traced.out.reply.messages).toEqual(untraced.out.reply.messages);
    expect(traced.out.reply.messages).toEqual([REPLY]);
    // Inside the deadline an untraced turn meets, with room for a slow runner.
    expect(traced.ms).toBeLessThan(1_000);
    expect(traced.ms).toBeLessThan(untraced.ms + 500);
  });

  it('logs a failed upload by its status, once, and drops it', async () => {
    const langsmith = fakeLangSmith(
      () => new Response('a body the log must not carry', { status: 500 }),
    );
    await timedTurn(langsmith.tracing(), 'subscriber-traced');
    await langsmith.settle();
    expect(langsmith.warnings.length).toBeGreaterThan(0);
    for (const warning of langsmith.warnings) {
      expect(warning.fields).toMatchObject({ status: 500 });
      expect(JSON.stringify(warning)).not.toContain('a body the log must not carry');
    }
    const sent = langsmith.requests.length;
    await sleep(50);
    await langsmith.settle();
    // Dropped, never retried.
    expect(langsmith.requests.length).toBe(sent);
  });
});

describe('TRACE_TURNS unset makes no request to the endpoint (specs/052 V4)', () => {
  it('sends nothing during a turn', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const out = await handler(scriptedRunner([{}]), undefined).handle(inbound('hello'));
    expect(out.outcome).toBe('answered_inline');
    await sleep(50);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
