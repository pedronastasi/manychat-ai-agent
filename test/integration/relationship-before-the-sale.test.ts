import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDatabase } from '../helpers/db.ts';
import type { Database } from '../../src/db/client.ts';
import { TurnHandler } from '../../src/routes/turn.ts';
import type { AgentRunner, AgentResult } from '../../src/agent/runner.ts';
import { ActionStage, buildTools } from '../../src/agent/tools.ts';
import type { ContactActions } from '../../src/agent/tools.ts';
import { RulesSchema, ToolsSchema } from '../../src/contracts/config.ts';
import type { Tools } from '../../src/contracts/config.ts';
import type { InboundMessage } from '../../src/contracts/agent.ts';
import { loadTenantConfig } from '../../src/config/loader.ts';
import { ManyChatHttpClient } from '../../src/channels/manychat/client.ts';
import { FakeContactFields, fakeManyChatApi } from '../helpers/manychat.ts';

/**
 * specs/032-relationship-before-the-sale.md § Verification item 2: the
 * opening flow goes out on the contact's first model turn, before the reply,
 * once, and not when that turn escalates. Over the ManyChat HTTP boundary,
 * against the demo tenant in test/fixtures/config with an invented opening.
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
  await close();
});

const OPENING_NS = 'content00000000000000_000201';
const fixture = loadTenantConfig('test/fixtures/config').tools!;
const tools: Tools = ToolsSchema.parse({
  ...fixture,
  flows: [
    ...fixture.flows,
    {
      id: 'welcome_note',
      flowNs: OPENING_NS,
      description: 'A short welcome voice note that asks whether the contact has studied before.',
      role: 'opening',
    },
  ],
});

const rules = RulesSchema.parse({
  messages: { acknowledgement: 'One moment.', escalation: 'Passing you to a person.' },
  budget: { dailyTokenCap: 100_000, dailyCostCapUsd: 5 },
  rateLimit: { turnsPerSubscriberPerHour: 60 },
  openingTrigger: { keywords: ['start workflow'], message: 'Welcome!' },
});

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const inbound = (text: string, subscriberId = 's1'): InboundMessage => ({
  tenantId: 'demo',
  subscriberId,
  text,
  channel: 'whatsapp',
  contactName: null,
  locale: null,
  contactToken: contactFields.tokenOf(subscriberId),
  receivedAt: new Date(),
});

const openingSends = () =>
  api.calls.filter(call => call.path === '/fb/sending/sendFlow' && call.body.flow_ns === OPENING_NS)
    .length;

/** A model that answers or escalates, recording what it was told and what had been sent. */
function runner(
  opts: { escalate?: boolean; delayMs?: number } = {},
  seen: { contacts: (ContactActions | undefined)[]; sentAtReply: number[] } = {
    contacts: [],
    sentAtReply: [],
  },
) {
  return {
    run: async ({ contact }) => {
      seen.contacts.push(contact);
      if (opts.delayMs) await new Promise(resolve => setTimeout(resolve, opts.delayMs));
      seen.sentAtReply.push(openingSends());
      const result: AgentResult = {
        reply: {
          messages: ['Hello!'],
          escalate: opts.escalate ?? false,
          escalation_reason: opts.escalate ? 'payment_reported' : null,
          confidence: 0.9,
          closing_question: 'Have you studied this before?',
        },
        ...(opts.escalate ? { escalatedBy: 'model' as const } : {}),
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

/** A model that sends `flow` through the real tools mid-call, then answers or escalates. */
function flowRunner(flow: string, opts: { escalate?: boolean } = {}) {
  return {
    run: async ({ stage = new ActionStage(), contact, flows, beforeFlow }) => {
      const built = buildTools(tools, stage, contact, undefined, { flows, beforeFlow });
      await built?.send_flow?.execute?.({ flow } as never, {
        toolCallId: 'test',
        messages: [],
        context: {},
      });
      const result: AgentResult = {
        reply: {
          messages: ['Here it is.'],
          escalate: opts.escalate ?? false,
          escalation_reason: opts.escalate ? 'out_of_scope' : null,
          confidence: 0.9,
          closing_question: null,
        },
        ...(opts.escalate ? { escalatedBy: 'model' as const } : {}),
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

const sentFlows = () =>
  api.calls
    .filter(call => call.path === '/fb/sending/sendFlow')
    .map(call => String(call.body.flow_ns));

const handler = (agent: AgentRunner, raceDeadlineMs = 2000, config: Tools = tools) =>
  new TurnHandler({
    db,
    runner: agent,
    rules,
    tools: config,
    logger,
    raceDeadlineMs,
    modelAbortMs: 5000,
    tokenWriter: contactFields,
    tokensEnforced: true,
    actions: client,
  });

const agentTurns = async () =>
  (await db.query.turns.findMany({ orderBy: (table, { asc }) => [asc(table.seq)] })).filter(
    turn => turn.role === 'agent',
  );

describe('the opening flow goes out on the first model turn (specs/032 V2)', () => {
  it('is sent after the model answers and before the turn returns, and recorded', async () => {
    const seen = { contacts: [] as (ContactActions | undefined)[], sentAtReply: [] as number[] };
    const out = await handler(runner({}, seen)).handle(inbound('hi'));

    expect(seen.contacts[0]?.firstModelTurn).toBe(true);
    // Not before the model decided: an escalation must be able to stop it.
    expect(seen.sentAtReply).toEqual([0]);
    expect(openingSends()).toBe(1);
    expect(out.reply.messages).toEqual(['Hello!']);
    const [turn] = await agentTurns();
    expect(turn!.actions).toEqual([
      { tool: 'send_flow', id: 'welcome_note', status: 'performed', origin: 'opening' },
    ]);
  });

  it('is not sent on a later turn, and the model is not told it is', async () => {
    await handler(runner()).handle(inbound('hi'));
    const seen = { contacts: [] as (ContactActions | undefined)[], sentAtReply: [] as number[] };
    await handler(runner({}, seen)).handle(inbound('what does it cost?'));

    expect(seen.contacts[0]?.firstModelTurn).toBe(false);
    expect(openingSends()).toBe(1);
  });

  it('is not sent when the first model turn escalates, then or later', async () => {
    await handler(runner({ escalate: true })).handle(inbound('I already paid'));
    expect(openingSends()).toBe(0);
    expect((await agentTurns())[0]!.actions).toEqual([]);

    await handler(runner()).handle(inbound('when does it start?'));
    expect(openingSends()).toBe(0);
  });

  it('is sent on the first model turn after a scripted opening', async () => {
    const out = await handler(runner()).handle(inbound('start workflow'));
    expect(out.outcome).toBe('answered_scripted');
    expect(openingSends()).toBe(0);

    await handler(runner()).handle(inbound('tell me more'));
    expect(openingSends()).toBe(1);
  });

  it('is sent once when three first messages arrive together', async () => {
    const agent = runner({ delayMs: 20 });
    await Promise.all(
      ['hi', 'I saw your advert', 'is it online?'].map(text =>
        handler(agent).handle(inbound(text)),
      ),
    );
    expect(openingSends()).toBe(1);
  });

  it('is sent by a deferred call, after the holding line, and recorded on its turn', async () => {
    const out = await handler(runner({ delayMs: 300 }), 100).handle(inbound('hi'));
    expect(out.outcome).toBe('deferred');
    expect(out.reply.messages).toEqual(['One moment.']);

    await vi.waitFor(async () => expect(await agentTurns()).toHaveLength(1), { timeout: 3000 });
    expect(openingSends()).toBe(1);
    expect((await agentTurns())[0]!.actions).toEqual([
      { tool: 'send_flow', id: 'welcome_note', status: 'performed', origin: 'opening' },
    ]);
  });

  it('goes out before a flow the model sends on the same turn', async () => {
    const brochure = tools.flows.find(flow => flow.id === 'student_results')!.flowNs;
    await handler(flowRunner('student_results')).handle(inbound('can I really learn this?'));

    expect(sentFlows()).toEqual([OPENING_NS, brochure]);
    expect((await agentTurns())[0]!.actions).toEqual([
      { tool: 'send_flow', id: 'welcome_note', status: 'performed', origin: 'opening' },
      { tool: 'send_flow', id: 'student_results', status: 'performed' },
    ]);
  });

  it('has gone out with a model flow even when that turn then escalates', async () => {
    await handler(flowRunner('student_results', { escalate: true })).handle(inbound('hello'));
    expect(openingSends()).toBe(1);
  });

  it('is recorded when it is the tenant’s only flow, and no tool is offered', async () => {
    const onlyOpening = ToolsSchema.parse({
      flows: tools.flows.filter(flow => flow.role === 'opening'),
    });
    const agent = {
      run: async () => ({ ...(await runner().run({} as never)), toolsOffered: false }),
    } satisfies AgentRunner;
    await handler(agent, 2000, onlyOpening).handle(inbound('hi'));

    expect(openingSends()).toBe(1);
    expect((await agentTurns())[0]!.actions).toEqual([
      { tool: 'send_flow', id: 'welcome_note', status: 'performed', origin: 'opening' },
    ]);
  });

  it('goes to each contact once, independently', async () => {
    await handler(runner()).handle(inbound('hi', 's1'));
    await handler(runner()).handle(inbound('hi', 's2'));
    expect(openingSends()).toBe(2);
  });
});
