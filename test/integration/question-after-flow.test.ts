import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDatabase } from '../helpers/db.ts';
import type { Database } from '../../src/db/client.ts';
import { TurnHandler } from '../../src/routes/turn.ts';
import type { AgentRunner, AgentResult } from '../../src/agent/runner.ts';
import { ActionStage, buildTools } from '../../src/agent/tools.ts';
import { RulesSchema } from '../../src/contracts/config.ts';
import type { Tools } from '../../src/contracts/config.ts';
import type { InboundMessage } from '../../src/contracts/agent.ts';
import { loadTenantConfig } from '../../src/config/loader.ts';
import { ManyChatHttpClient } from '../../src/channels/manychat/client.ts';
import { OutboxWorker } from '../../src/outbox/worker.ts';
import { FakeContactFields, fakeManyChatApi, manychatAnswer } from '../helpers/manychat.ts';

/**
 * specs/029-question-after-flow.md § Verification items 3, 4 and 5: on both
 * delivery paths the closing question of a turn that sends a flow leaves the
 * response and reaches ManyChat after the flow, over the HTTP boundary. The
 * demo tenant in test/fixtures/config, with an invented settle time.
 */

let db: Database;
let close: () => Promise<void>;
let contactFields: FakeContactFields;
let api: ReturnType<typeof fakeManyChatApi>;
let client: ManyChatHttpClient;
beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
  contactFields = new FakeContactFields();
  api = fakeManyChatApi();
  client = new ManyChatHttpClient({
    apiToken: 'test-token',
    baseUrl: 'https://api.example.com',
    replyField: 'ai_message',
    replyFlowNs: 'reply_flow',
    tokenField: 'ai_token',
    fetchImpl: api.fetch,
  });
});
afterEach(async () => {
  vi.useRealTimers();
  await close();
});

const fixture = loadTenantConfig('test/fixtures/config').tools!;
const RESULTS_NS = fixture.flows.find(flow => flow.id === 'student_results')!.flowNs;

/** `student_results` takes a second to play out. */
const tools: Tools = {
  ...fixture,
  flows: fixture.flows.map(flow =>
    flow.id === 'student_results' ? { ...flow, settleSeconds: 1 } : flow,
  ),
};

const rules = RulesSchema.parse({
  messages: { acknowledgement: 'One moment.', escalation: 'Passing you to a person.' },
  budget: { dailyTokenCap: 100_000, dailyCostCapUsd: 5 },
  rateLimit: { turnsPerSubscriberPerHour: 60 },
});

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const inbound = (text: string): InboundMessage => ({
  tenantId: 'demo',
  subscriberId: 's1',
  text,
  channel: 'whatsapp',
  contactName: null,
  locale: null,
  contactToken: contactFields.tokenOf('s1'),
  receivedAt: new Date(),
});

const ANNOUNCE = 'Here is what past students made.';
const QUESTION = 'Would you like the dates?';

/**
 * A model that stages `flows` through the real tools, then replies with a
 * line and its closing question, as the guardrails deliver it.
 */
function flowRunner(flows: string[], opts: { delayMs?: number } = {}) {
  return {
    run: async ({ stage = new ActionStage(), contact }) => {
      const built = buildTools(tools, stage, contact);
      for (const flow of flows) {
        await built?.send_flow?.execute?.({ flow } as never, {
          toolCallId: 'test',
          messages: [],
          context: {},
        });
      }
      if (opts.delayMs) await new Promise(resolve => setTimeout(resolve, opts.delayMs));
      const result: AgentResult = {
        reply: {
          messages: [ANNOUNCE, QUESTION],
          escalate: false,
          escalation_reason: null,
          confidence: 0.9,
          closing_question: QUESTION,
        },
        model: 'mock:demo',
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, costUsd: 0.001 },
        interventions: [],
        latencyMs: 5,
        toolsOffered: true,
      };
      return result;
    },
  } satisfies AgentRunner;
}

const handler = (runner: AgentRunner, withQuestions = true) =>
  new TurnHandler({
    db,
    runner,
    rules,
    tools,
    logger,
    raceDeadlineMs: 200,
    modelAbortMs: 5000,
    tokenWriter: contactFields,
    tokensEnforced: true,
    actions: client,
    questions: withQuestions ? client : undefined,
  });

/** Every ManyChat request, as `endpoint target`, with when it was made. */
const timed: { request: string; at: number }[] = [];
const describeCall = (path: string, body: Record<string, unknown>) =>
  path === '/fb/sending/sendFlow'
    ? `sendFlow ${String(body.flow_ns)}`
    : `setField ${String(body.field_name)}=${String(body.field_value)}`;
beforeEach(() => {
  timed.length = 0;
  const original = api.fetch;
  api.fetch = ((url: string, init: RequestInit) => {
    if (init.body !== undefined) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      timed.push({ request: describeCall(new URL(url).pathname, body), at: Date.now() });
    }
    return original(url, init);
  }) as typeof fetch;
  client = new ManyChatHttpClient({
    apiToken: 'test-token',
    baseUrl: 'https://api.example.com',
    replyField: 'ai_message',
    replyFlowNs: 'reply_flow',
    tokenField: 'ai_token',
    fetchImpl: api.fetch,
  });
});
const requests = () => timed.map(entry => entry.request);

const agentTurns = async () =>
  (await db.query.turns.findMany({ orderBy: (table, { asc }) => [asc(table.seq)] })).filter(
    turn => turn.role === 'agent',
  );

describe('race won: the question follows the flow (specs/029 V3)', () => {
  it('leaves the question out of the response and records the whole reply', async () => {
    const out = await handler(flowRunner(['student_results'])).handle(inbound('can I learn it?'));

    expect(out.reply.messages).toEqual([ANNOUNCE]);
    const [turn] = await agentTurns();
    expect(turn!.text).toBe(`${ANNOUNCE}\n${QUESTION}`);
  });

  it('sends the flow, waits its settle time, then the question', async () => {
    const out = await handler(flowRunner(['student_results'])).handle(inbound('can I learn it?'));
    await out.afterResponse!();

    expect(requests()).toEqual([
      `sendFlow ${RESULTS_NS}`,
      `setField ai_message=${QUESTION}`,
      'sendFlow reply_flow',
    ]);
    expect(timed[1]!.at - timed[0]!.at).toBeGreaterThanOrEqual(950);
  });

  it('holds nothing on a turn that sends no flow', async () => {
    const out = await handler(flowRunner([])).handle(inbound('hello'));
    expect(out.reply.messages).toEqual([ANNOUNCE, QUESTION]);
    expect(out.afterResponse).toBeUndefined();
  });

  it('holds nothing when there is no way to send it later', async () => {
    const out = await handler(flowRunner(['student_results']), false).handle(inbound('hi'));
    await out.afterResponse!();

    expect(out.reply.messages).toEqual([ANNOUNCE, QUESTION]);
    expect(requests()).toEqual([`sendFlow ${RESULTS_NS}`]);
  });

  it('still sends the question when the flow fails (specs/029 V5)', async () => {
    api.state.respond = init =>
      Promise.resolve(
        String(init.body).includes(RESULTS_NS)
          ? manychatAnswer(400, '{"status":"error","message":"refused"}')
          : manychatAnswer(),
      );
    const out = await handler(flowRunner(['student_results'])).handle(inbound('can I learn it?'));
    await out.afterResponse!();

    expect(requests()).toEqual([
      `sendFlow ${RESULTS_NS}`,
      `setField ai_message=${QUESTION}`,
      'sendFlow reply_flow',
    ]);
  });
});

describe('race lost: the outbox sends the question after the flow (specs/029 V4)', () => {
  /** A turn that loses the race and is left in the outbox. */
  async function deferredTurn() {
    const out = await handler(flowRunner(['student_results'], { delayMs: 400 })).handle(
      inbound('can I learn it?'),
    );
    expect(out.outcome).toBe('deferred');
    await vi.waitFor(
      async () =>
        expect((await db.query.outbox.findMany()).filter(row => row.kind === 'reply')).toHaveLength(
          1,
        ),
      { timeout: 3000 },
    );
  }

  it('delivers the text, the flow, then the question after its wait', async () => {
    await deferredTurn();
    const sleep = vi.fn(() => Promise.resolve());
    const worker = new OutboxWorker({ db, client, logger, sleep });
    await worker.drainOnce();
    await worker.questionsSent();

    expect(requests()).toEqual([
      `setField ai_message=${ANNOUNCE}`,
      'sendFlow reply_flow',
      `sendFlow ${RESULTS_NS}`,
      `setField ai_message=${QUESTION}`,
      'sendFlow reply_flow',
    ]);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it('does not hold the batch while the question waits', async () => {
    await deferredTurn();
    let release!: () => void;
    const sleep = () => new Promise<void>(resolve => (release = resolve));
    const worker = new OutboxWorker({ db, client, logger, sleep });

    const result = await worker.drainOnce();
    expect(result.delivered).toBe(1);
    expect(requests()).not.toContain(`setField ai_message=${QUESTION}`);

    release();
    await worker.questionsSent();
    expect(requests().at(-2)).toBe(`setField ai_message=${QUESTION}`);
  });

  it('sends no question for a dead-lettered row', async () => {
    await deferredTurn();
    api.state.respond = init =>
      Promise.resolve(
        String(init.body).includes('ai_message')
          ? manychatAnswer(400, '{"status":"error","message":"refused"}')
          : manychatAnswer(),
      );
    const worker = new OutboxWorker({ db, client, logger, sleep: () => Promise.resolve() });
    const result = await worker.drainOnce();
    await worker.questionsSent();

    expect(result.deadLettered).toBe(1);
    expect(requests()).toEqual([`setField ai_message=${ANNOUNCE}`]);
  });
});
