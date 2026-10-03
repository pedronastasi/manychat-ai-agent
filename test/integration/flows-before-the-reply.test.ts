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
import { FakeContactFields, fakeManyChatApi } from '../helpers/manychat.ts';

/**
 * specs/029-flows-before-the-reply.md § Verification items 4 and 5: on an
 * inbound turn the flow's request is made during the turn, its follow-ons
 * with it, before the reply and the staged writes; an escalation does not
 * recall it. Over the ManyChat HTTP boundary, against the demo tenant in
 * test/fixtures/config with an invented event.
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

const CHECKOUT_NS = 'content00000000000000_000103';
const fixture = loadTenantConfig('test/fixtures/config').tools!;
const tools: Tools = {
  ...fixture,
  events: [{ id: 'checkout_started', stage: 'link_sent', flowNs: CHECKOUT_NS }],
};
const flowNs = (id: string) => tools.flows.find(flow => flow.id === id)!.flowNs;

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

/** Every ManyChat request, as `endpoint target`. */
const requests = () =>
  api.calls.map(call =>
    call.path === '/fb/sending/sendFlow'
      ? `sendFlow ${String(call.body.flow_ns)}`
      : call.path === '/fb/subscriber/addTagByName'
        ? `addTag ${String(call.body.tag_name)}`
        : `setField ${String(call.body.field_name)}=${String(call.body.field_value)}`,
  );

/**
 * A model that makes `calls` through the real tools, with the flow sender the
 * turn handler passed, recording which requests had been made when it wrote
 * its reply; then replies or escalates.
 */
function scriptedRunner(
  calls: Call[],
  opts: { escalate?: boolean; delayMs?: number } = {},
  seen: { atReply?: string[] } = {},
) {
  return {
    run: async ({ stage = new ActionStage(), contact, flows }) => {
      const built = buildTools(tools, stage, contact, undefined, { flows });
      for (const [name, input] of calls) {
        await built?.[name]?.execute?.(input as never, {
          toolCallId: 'test',
          messages: [],
          context: {},
        });
      }
      seen.atReply = requests();
      if (opts.delayMs) await new Promise(resolve => setTimeout(resolve, opts.delayMs));
      const result: AgentResult = {
        reply: {
          messages: ['Here it is.', 'Would you like the dates?'],
          escalate: opts.escalate ?? false,
          escalation_reason: opts.escalate ? 'out_of_scope' : null,
          confidence: 0.9,
          closing_question: 'Would you like the dates?',
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

const handler = (runner: AgentRunner, timing = { raceDeadlineMs: 200, modelAbortMs: 5000 }) =>
  new TurnHandler({
    db,
    runner,
    rules,
    tools,
    logger,
    ...timing,
    tokenWriter: contactFields,
    tokensEnforced: true,
    actions: client,
  });

const agentTurns = async () =>
  (await db.query.turns.findMany({ orderBy: (table, { asc }) => [asc(table.seq)] })).filter(
    turn => turn.role === 'agent',
  );

describe('an inbound turn sends its flow before the reply (specs/029 V4)', () => {
  it('makes the flow request before the model writes its reply', async () => {
    const seen: { atReply?: string[] } = {};
    const out = await handler(
      scriptedRunner([['send_flow', { flow: 'student_results' }]], {}, seen),
    ).handle(inbound('can I learn it?'));

    expect(seen.atReply).toEqual([`sendFlow ${flowNs('student_results')}`]);
    // The whole reply stays in the response, question last.
    expect(out.reply.messages).toEqual(['Here it is.', 'Would you like the dates?']);
    expect(out.afterResponse).toBeUndefined();
    const [turn] = await agentTurns();
    expect(turn!.actions).toEqual([
      { tool: 'send_flow', id: 'student_results', status: 'performed' },
    ]);
  });

  it('sends the payment link’s link_sent write and event with it', async () => {
    const seen: { atReply?: string[] } = {};
    await handler(scriptedRunner([['send_flow', { flow: 'enrolment_link' }]], {}, seen)).handle(
      inbound('send me the link'),
    );

    expect(seen.atReply).toEqual([
      `sendFlow ${flowNs('enrolment_link')}`,
      'setField funnel_stage=link_sent',
      `sendFlow ${CHECKOUT_NS}`,
    ]);
    const [turn] = await agentTurns();
    expect(turn!.actions).toEqual([
      { tool: 'send_flow', id: 'enrolment_link', status: 'performed' },
      { tool: 'set_field', id: 'funnel_stage', value: 'link_sent', status: 'performed' },
      { tool: 'send_event', id: 'checkout_started', status: 'performed' },
    ]);
  });

  it('a payment link takes the turn’s earlier stage write with it, and link_sent is last', async () => {
    const seen: { atReply?: string[] } = {};
    const out = await handler(
      scriptedRunner(
        [
          ['set_field', { field: 'funnel_stage', value: 'offered' }],
          ['send_flow', { flow: 'enrolment_link' }],
          // A later write may not walk the stage back from link_sent.
          ['set_field', { field: 'funnel_stage', value: 'nurturing' }],
        ],
        {},
        seen,
      ),
    ).handle(inbound('ok, send me the link'));
    await out.afterResponse?.();

    expect(seen.atReply).toEqual([
      'setField funnel_stage=offered',
      `sendFlow ${flowNs('enrolment_link')}`,
      'setField funnel_stage=link_sent',
      `sendFlow ${CHECKOUT_NS}`,
    ]);
    // Nothing reaches ManyChat after the response to move it back.
    expect(requests()).toEqual(seen.atReply);
    const [turn] = await agentTurns();
    expect(turn!.actions).toEqual([
      { tool: 'set_field', id: 'funnel_stage', value: 'offered', status: 'performed' },
      { tool: 'send_flow', id: 'enrolment_link', status: 'performed' },
      { tool: 'set_field', id: 'funnel_stage', value: 'link_sent', status: 'performed' },
      { tool: 'send_event', id: 'checkout_started', status: 'performed' },
    ]);
  });

  it('performs the staged writes after the response, the flow already sent', async () => {
    const seen: { atReply?: string[] } = {};
    const out = await handler(
      scriptedRunner(
        [
          ['add_tag', { tag: 'interested_foundation' }],
          ['send_flow', { flow: 'student_results' }],
        ],
        {},
        seen,
      ),
    ).handle(inbound('can I learn it?'));

    expect(seen.atReply).toEqual([`sendFlow ${flowNs('student_results')}`]);
    await out.afterResponse!();
    expect(requests()).toEqual([
      `sendFlow ${flowNs('student_results')}`,
      'addTag interested-foundation-course',
    ]);
    const [turn] = await agentTurns();
    expect(turn!.actions).toEqual([
      { tool: 'add_tag', id: 'interested_foundation', status: 'performed' },
      { tool: 'send_flow', id: 'student_results', status: 'performed' },
    ]);
  });

  it('a deferred turn has sent its flow before the outbox delivers the reply', async () => {
    const out = await handler(
      scriptedRunner([['send_flow', { flow: 'student_results' }]], { delayMs: 400 }),
    ).handle(inbound('can I learn it?'));
    expect(out.outcome).toBe('deferred');
    await vi.waitFor(
      async () =>
        expect((await db.query.outbox.findMany()).filter(row => row.kind === 'reply')).toHaveLength(
          1,
        ),
      { timeout: 3000 },
    );
    await new OutboxWorker({ db, client, logger }).drainOnce();

    expect(requests()).toEqual([
      `sendFlow ${flowNs('student_results')}`,
      'setField ai_message=Here it is.',
      'sendFlow reply_flow',
      'setField ai_message=Would you like the dates?',
      'sendFlow reply_flow',
    ]);
  });
});

describe('an escalation does not recall a sent flow (specs/029 V5)', () => {
  it('the flow went out and is recorded; the staged writes are discarded', async () => {
    const out = await handler(
      scriptedRunner(
        [
          ['send_flow', { flow: 'student_results' }],
          ['add_tag', { tag: 'interested_foundation' }],
        ],
        { escalate: true },
      ),
    ).handle(inbound('can I learn it?'));

    expect(out.reply.escalate).toBe(true);
    expect(requests()).toEqual([`sendFlow ${flowNs('student_results')}`]);
    const [turn] = await agentTurns();
    expect(turn!.actions).toEqual([
      { tool: 'send_flow', id: 'student_results', status: 'performed' },
      { tool: 'add_tag', id: 'interested_foundation', status: 'discarded' },
    ]);
  });

  it('records a flow sent before a deferred call hit MODEL_ABORT_MS', async () => {
    // Sends the flow, then never answers until the abort fires.
    const runner: AgentRunner = {
      run: async ({ stage = new ActionStage(), contact, flows, signal }) => {
        const built = buildTools(tools, stage, contact, undefined, { flows });
        await built?.send_flow?.execute?.({ flow: 'student_results' } as never, {
          toolCallId: 'test',
          messages: [],
          context: {},
        });
        return new Promise<AgentResult>((_resolve, reject) =>
          signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        );
      },
    };
    const out = await handler(runner, { raceDeadlineMs: 50, modelAbortMs: 150 }).handle(
      inbound('can I learn it?'),
    );
    expect(out.outcome).toBe('deferred');

    await vi.waitFor(async () => expect(await agentTurns()).toHaveLength(1), { timeout: 3000 });
    const [turn] = await agentTurns();
    expect(turn!.outcome).toBe('error');
    expect(turn!.text).toBe('One moment.');
    expect(turn!.actions).toEqual([
      { tool: 'send_flow', id: 'student_results', status: 'performed' },
    ]);
    // So the next turn knows it went out, and does not send it again.
    expect(requests()).toEqual([`sendFlow ${flowNs('student_results')}`]);
  });

  it('waits for a flow request still in flight when the call is aborted', async () => {
    // ManyChat answers after the abort has fired.
    api.state.respond = () =>
      new Promise(resolve =>
        setTimeout(() => resolve(new Response('{"status":"success"}', { status: 200 })), 300),
      );
    const runner: AgentRunner = {
      run: ({ stage = new ActionStage(), contact, flows, signal }) => {
        const built = buildTools(tools, stage, contact, undefined, { flows });
        // Called and not awaited, as a tool still running when the abort lands.
        void built?.send_flow?.execute?.({ flow: 'student_results' } as never, {
          toolCallId: 'test',
          messages: [],
          context: {},
        });
        return new Promise<AgentResult>((_resolve, reject) =>
          signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        );
      },
    };
    await handler(runner, { raceDeadlineMs: 50, modelAbortMs: 120 }).handle(
      inbound('can I learn it?'),
    );

    await vi.waitFor(async () => expect(await agentTurns()).toHaveLength(1), { timeout: 3000 });
    const [turn] = await agentTurns();
    expect(turn!.actions).toEqual([
      { tool: 'send_flow', id: 'student_results', status: 'performed' },
    ]);
  });
});
