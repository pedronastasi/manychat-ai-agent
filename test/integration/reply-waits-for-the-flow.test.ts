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
import { FakeContactFields, fakeManyChatApi } from '../helpers/manychat.ts';
import { asProspect } from '../helpers/intent.ts';

/**
 * specs/030-reply-waits-for-the-flow.md § Verification items 4 and 5: a reply
 * after a flow is held until the flow has played, inline before the deadline
 * and from the outbox after it, with a silent response meanwhile. Over the
 * ManyChat HTTP boundary, against the demo tenant in test/fixtures/config with
 * invented play times and one invented flow.
 */

let db: Database;
let close: () => Promise<void>;
let contactFields: FakeContactFields;
let client: ManyChatHttpClient;
beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
  contactFields = new FakeContactFields();
  client = new ManyChatHttpClient({
    apiToken: 'test-token',
    baseUrl: 'https://api.example.com',
    replyField: 'ai_message',
    replyFlowNs: 'reply_flow',
    tokenField: 'ai_token',
    fetchImpl: fakeManyChatApi().fetch,
  });
});
afterEach(async () => {
  await close();
});

const fixture = loadTenantConfig('test/fixtures/config').tools!;
const tools: Tools = {
  ...fixture,
  flows: [
    ...fixture.flows.map(flow =>
      flow.id === 'student_results' ? { ...flow, settleSeconds: 1 } : flow,
    ),
    {
      id: 'studio_tour',
      flowNs: 'content00000000000000_000190',
      description: 'A long tour of the studio.',
      settleSeconds: 2,
    },
  ],
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

type Call = [tool: string, input: object];

/** A model that makes `calls` through the real tools, then replies, or throws. */
function scriptedRunner(calls: Call[], opts: { delayMs?: number; fail?: boolean } = {}) {
  return {
    run: async ({ stage = new ActionStage(), contact, flows }) => {
      const built = buildTools(tools, stage, asProspect(contact), undefined, { flows });
      for (const [name, input] of calls) {
        await built?.[name]?.execute?.(input as never, {
          toolCallId: 'test',
          messages: [],
          context: {},
        });
      }
      if (opts.delayMs) await new Promise(resolve => setTimeout(resolve, opts.delayMs));
      if (opts.fail) throw new Error('model unavailable');
      const result: AgentResult = {
        reply: {
          messages: ['Here it is.', 'Would you like the dates?'],
          escalate: false,
          escalation_reason: null,
          confidence: 0.9,
          closing_question: 'Would you like the dates?',
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

const handler = (runner: AgentRunner, raceDeadlineMs: number) =>
  new TurnHandler({
    db,
    runner,
    rules,
    tools,
    logger,
    raceDeadlineMs,
    modelAbortMs: 10_000,
    tokenWriter: contactFields,
    tokensEnforced: true,
    actions: client,
  });

const replyRows = async () =>
  (await db.query.outbox.findMany()).filter(row => row.kind === 'reply');

/** Waits for the deferred call to settle into the outbox. */
async function queued(count = 1) {
  for (let tries = 0; tries < 100; tries++) {
    const rows = await replyRows();
    if (rows.length >= count) return rows;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('nothing was queued');
}

describe('a reply waits for the flow it follows (specs/030 V4)', () => {
  it('holds an inline reply until the flow has played', async () => {
    const started = Date.now();
    const out = await handler(
      scriptedRunner([['send_flow', { flow: 'student_results' }]]),
      3000,
    ).handle(inbound('can I learn it?'));

    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    expect(out.silent).toBeUndefined();
    expect(out.outcome).toBe('answered_inline');
    expect(out.reply.messages).toEqual(['Here it is.', 'Would you like the dates?']);
    expect(await replyRows()).toEqual([]);
  });

  it('queues a reply that would pass the deadline, with its staged actions, and says nothing now', async () => {
    const started = Date.now();
    const out = await handler(
      scriptedRunner([
        ['send_flow', { flow: 'studio_tour' }],
        ['add_tag', { tag: 'interested_foundation' }],
      ]),
      500,
    ).handle(inbound('show me the studio'));

    expect(Date.now() - started).toBeLessThan(1000);
    expect(out.silent).toBe(true);
    expect(out.afterResponse).toBeUndefined();
    const [row] = await replyRows();
    expect(row!.payload).toMatchObject({
      messages: ['Here it is.', 'Would you like the dates?'],
      actions: [{ tool: 'add_tag', id: 'interested_foundation' }],
    });
    // Due when the tour has played, two seconds after ManyChat's answer.
    expect(row!.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(started + 2000);
    expect(row!.nextAttemptAt.getTime()).toBeLessThan(Date.now() + 2000 + 100);
    // The turn settled as the model wrote it; the log tells the path apart.
    const turns = await db.query.turns.findMany();
    expect(turns.find(turn => turn.role === 'agent')!.outcome).toBe('answered_inline');
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'outbox' }),
      'reply held for flow',
    );
  });

  it('does not hold a turn with no flow, or a flow with no settle time', async () => {
    for (const calls of [[], [['send_flow', { flow: 'fitting_it_in' }]]] as Call[][]) {
      const started = Date.now();
      const out = await handler(scriptedRunner(calls), 3000).handle(inbound('how long is it?'));
      expect(Date.now() - started).toBeLessThan(500);
      expect(out.silent).toBeUndefined();
    }
    expect(await replyRows()).toEqual([]);
  });
});

describe('a flow still playing is the holding line (specs/030 V5)', () => {
  it('a race lost while a flow plays answers silently, and the reply is due when it ends', async () => {
    const started = Date.now();
    const out = await handler(
      scriptedRunner([['send_flow', { flow: 'studio_tour' }]], { delayMs: 400 }),
      200,
    ).handle(inbound('show me the studio'));

    expect(out.outcome).toBe('deferred');
    expect(out.silent).toBe(true);
    const [row] = await queued();
    expect(row!.payload).toMatchObject({ messages: ['Here it is.', 'Would you like the dates?'] });
    expect(row!.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(started + 2000);
  });

  it('a race lost with no flow playing still sends the holding line', async () => {
    const out = await handler(scriptedRunner([], { delayMs: 300 }), 100).handle(inbound('hello?'));
    expect(out.silent).toBeUndefined();
    expect(out.reply.messages).toEqual(['One moment.']);
    const [row] = await queued();
    // Nothing to wait for: due at once.
    expect(row!.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('a deferred call that fails after a silent response queues the holding line', async () => {
    const out = await handler(
      scriptedRunner([['send_flow', { flow: 'studio_tour' }]], { delayMs: 300, fail: true }),
      100,
    ).handle(inbound('show me the studio'));

    expect(out.silent).toBe(true);
    const [row] = await queued();
    expect(row!.payload).toMatchObject({ messages: ['One moment.'] });
    expect(row!.payload).not.toHaveProperty('actions');
  });
});
