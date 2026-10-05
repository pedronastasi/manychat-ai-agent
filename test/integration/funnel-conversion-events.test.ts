import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDatabase } from '../helpers/db.ts';
import type { Database } from '../../src/db/client.ts';
import { TurnHandler } from '../../src/routes/turn.ts';
import type { AgentRunner, AgentResult } from '../../src/agent/runner.ts';
import { ActionStage, buildTools, MAX_ACTIONS_PER_TURN } from '../../src/agent/tools.ts';
import { RulesSchema } from '../../src/contracts/config.ts';
import type { Tools } from '../../src/contracts/config.ts';
import type { InboundMessage } from '../../src/contracts/agent.ts';
import { loadTenantConfig } from '../../src/config/loader.ts';
import { ManyChatHttpClient } from '../../src/channels/manychat/client.ts';
import { OutboxWorker } from '../../src/outbox/worker.ts';
import { FakeContactFields, fakeManyChatApi, manychatAnswer } from '../helpers/manychat.ts';
import { asProspect } from '../helpers/intent.ts';

/**
 * specs/027-funnel-conversion-events.md § Verification items 3, 4, 5 and 6:
 * the tracking flow follows the funnel write it reports, over the ManyChat
 * HTTP boundary, on both delivery paths, and is recorded beside it. The demo
 * tenant in test/fixtures/config, with an invented `events` list.
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

const QUALIFIED_NS = 'content00000000000000_000101';
const OFFERED_NS = 'content00000000000000_000102';
const CHECKOUT_NS = 'content00000000000000_000103';
const PAYMENT_LINK_NS = 'content00000000000000_000004';

const tools: Tools = {
  ...loadTenantConfig('test/fixtures/config').tools!,
  events: [
    { id: 'lead_qualified', stage: 'nurturing', flowNs: QUALIFIED_NS },
    { id: 'offer_made', stage: 'offered', flowNs: OFFERED_NS },
    { id: 'checkout_started', stage: 'link_sent', flowNs: CHECKOUT_NS },
  ],
};

const rules = RulesSchema.parse({
  messages: { acknowledgement: 'One moment.', escalation: 'Passing you to a person.' },
  budget: { dailyTokenCap: 100_000, dailyCostCapUsd: 5 },
  rateLimit: { turnsPerSubscriberPerHour: 60 },
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

type Call = [tool: string, input: object];

/**
 * A model that makes `calls` through the real tools, built for the contact
 * the turn handler read, then replies or escalates.
 */
function scriptedRunner(calls: Call[], opts: { delayMs?: number; escalate?: boolean } = {}) {
  return {
    run: async ({ stage = new ActionStage(), contact }) => {
      const built = buildTools(tools, stage, asProspect(contact));
      for (const [name, input] of calls) {
        await built?.[name]?.execute?.(input as never, {
          toolCallId: 'test',
          messages: [],
          context: {},
        });
      }
      if (opts.delayMs) await new Promise(resolve => setTimeout(resolve, opts.delayMs));
      const result: AgentResult = {
        reply: {
          messages: ['Here you go.'],
          escalate: opts.escalate ?? false,
          escalation_reason: opts.escalate ? 'out_of_scope' : null,
          confidence: 0.9,
          closing_question: null,
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

const handler = (runner: AgentRunner) =>
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
  });

/** Runs one inline turn and performs its actions, as the server does after the response. */
async function inlineTurn(calls: Call[], opts: { escalate?: boolean } = {}) {
  const out = await handler(scriptedRunner(calls, opts)).handle(inbound('hello'));
  await out.afterResponse?.();
  return out;
}

const stageTo = (value: string): Call => ['set_field', { field: 'funnel_stage', value }];

/** Every ManyChat request, as `endpoint target`. */
const requests = () =>
  api.calls.map(call =>
    call.path === '/fb/sending/sendFlow'
      ? `sendFlow ${String(call.body.flow_ns)}`
      : `setField ${String(call.body.field_name)}=${String(call.body.field_value)}`,
  );

const agentTurns = async () =>
  (await db.query.turns.findMany({ orderBy: (table, { asc }) => [asc(table.seq)] })).filter(
    turn => turn.role === 'agent',
  );

/** Answers 400 to every request `refuse` matches, as ManyChat refuses one. */
function refuse(match: (body: Record<string, unknown>) => boolean) {
  api.state.respond = init =>
    Promise.resolve(
      match(JSON.parse(String(init.body)) as Record<string, unknown>)
        ? manychatAnswer(400, '{"status":"error","message":"refused"}')
        : manychatAnswer(),
    );
}

/* -------------------------------------------------------------------------- */
/* V3 — an advancing, performed write sends its event                          */
/* -------------------------------------------------------------------------- */

describe('a performed funnel write sends its event after it (specs/027 V3)', () => {
  it('sends the tracking flow after the write, for the turn’s subscriber', async () => {
    await inlineTurn([stageTo('nurturing')]);

    expect(requests()).toEqual(['setField funnel_stage=nurturing', `sendFlow ${QUALIFIED_NS}`]);
    expect(api.calls[1]!.body).toEqual({ subscriber_id: 's1', flow_ns: QUALIFIED_NS });
  });

  it('sends none when the write fails', async () => {
    refuse(body => body.field_name === 'funnel_stage');
    await inlineTurn([stageTo('nurturing')]);

    expect(requests()).toEqual(['setField funnel_stage=nurturing']);
  });

  it('sends none when the turn escalates and the write is discarded', async () => {
    await inlineTurn([stageTo('nurturing')], { escalate: true });

    expect(requests()).toEqual([]);
    const [turn] = await agentTurns();
    expect(turn!.actions).toEqual([
      { tool: 'set_field', id: 'funnel_stage', value: 'nurturing', status: 'discarded' },
    ]);
  });

  it('sends none for a write equal to the last performed stage', async () => {
    await inlineTurn([stageTo('nurturing')]);
    api.calls.length = 0;
    await inlineTurn([stageTo('nurturing')]);

    expect(requests()).toEqual(['setField funnel_stage=nurturing']);
  });

  it('a stage with no event sends nothing beyond the write', async () => {
    await inlineTurn([stageTo('qualifying')]);

    expect(requests()).toEqual(['setField funnel_stage=qualifying']);
  });

  it('a jump fires only the event for the stage written', async () => {
    await inlineTurn([stageTo('qualifying')]);
    api.calls.length = 0;
    await inlineTurn([stageTo('offered')]);

    expect(requests()).toEqual(['setField funnel_stage=offered', `sendFlow ${OFFERED_NS}`]);
  });
});

/* -------------------------------------------------------------------------- */
/* V4 — payment flow, link_sent write, event                                   */
/* -------------------------------------------------------------------------- */

describe('the payment-link flow fires its event last (specs/027 V4)', () => {
  const sendLink: Call = ['send_flow', { flow: 'enrolment_link', contactAsked: true }];

  it('makes three requests in order: flow, link_sent write, event', async () => {
    await inlineTurn([sendLink]);

    expect(requests()).toEqual([
      `sendFlow ${PAYMENT_LINK_NS}`,
      'setField funnel_stage=link_sent',
      `sendFlow ${CHECKOUT_NS}`,
    ]);
  });

  it('makes none after the first when the flow fails', async () => {
    refuse(body => body.flow_ns === PAYMENT_LINK_NS);
    await inlineTurn([sendLink]);

    expect(requests()).toEqual([`sendFlow ${PAYMENT_LINK_NS}`]);
  });

  it('a second link to a contact already at link_sent fires no event', async () => {
    await inlineTurn([sendLink]);
    api.calls.length = 0;
    await inlineTurn([sendLink]);

    expect(requests()).toEqual([`sendFlow ${PAYMENT_LINK_NS}`, 'setField funnel_stage=link_sent']);
  });
});

/* -------------------------------------------------------------------------- */
/* V5 — outside the per-turn cap                                               */
/* -------------------------------------------------------------------------- */

describe('an event follow-on does not count against the cap (specs/027 V5)', () => {
  it('performs eight staged actions and the event, and drops the ninth', async () => {
    const calls: Call[] = [
      stageTo('nurturing'),
      ['set_field', { field: 'prior_experience', value: 'none' }],
      ['set_field', { field: 'preferred_schedule', value: 'weekends' }],
      ['add_tag', { tag: 'interested_foundation' }],
      ['send_flow', { flow: 'fitting_it_in' }],
      ['write_note', { note: 'goal', text: 'Wants a new skill.' }],
      ['write_note', { note: 'objections', text: 'Unsure about time.' }],
      ['write_note', { note: 'handoff_summary', text: 'Ready for the offer.' }],
      ['send_flow', { flow: 'student_results' }],
    ];
    expect(calls).toHaveLength(MAX_ACTIONS_PER_TURN + 1);
    await inlineTurn(calls);

    expect(api.calls).toHaveLength(MAX_ACTIONS_PER_TURN + 1);
    expect(requests().slice(0, 2)).toEqual([
      'setField funnel_stage=nurturing',
      `sendFlow ${QUALIFIED_NS}`,
    ]);
    const [turn] = await agentTurns();
    const actions = turn!.actions!;
    expect(actions.filter(action => action.status === 'performed')).toHaveLength(
      MAX_ACTIONS_PER_TURN + 1,
    );
    expect(actions[1]).toEqual({ tool: 'send_event', id: 'lead_qualified', status: 'performed' });
    expect(actions.at(-1)).toEqual({
      tool: 'send_flow',
      id: 'student_results',
      status: 'dropped_over_cap',
    });
  });
});

/* -------------------------------------------------------------------------- */
/* V6 — recorded beside the write, on both paths                               */
/* -------------------------------------------------------------------------- */

describe('the send_event entry is recorded beside its write (specs/027 V6)', () => {
  const WRITE = { tool: 'set_field', id: 'funnel_stage', value: 'nurturing', status: 'performed' };

  it('inline: records the configured id and its status', async () => {
    await inlineTurn([stageTo('nurturing')]);

    const [turn] = await agentTurns();
    expect(turn!.actions).toEqual([
      WRITE,
      { tool: 'send_event', id: 'lead_qualified', status: 'performed' },
    ]);
  });

  it('inline: records a failed event, and never retries it', async () => {
    refuse(body => body.flow_ns === QUALIFIED_NS);
    await inlineTurn([stageTo('nurturing')]);

    const [turn] = await agentTurns();
    expect(turn!.actions).toEqual([
      WRITE,
      expect.objectContaining({ tool: 'send_event', id: 'lead_qualified', status: 'failed' }),
    ]);
    expect(requests().filter(entry => entry.endsWith(QUALIFIED_NS))).toHaveLength(1);
    // The record holds the id, never the flow it was sent with (C5).
    expect(JSON.stringify(turn!.actions)).not.toContain(QUALIFIED_NS);
  });

  /** A turn that loses the race and is left in the outbox. */
  async function deferredTurn() {
    const out = await handler(scriptedRunner([stageTo('nurturing')], { delayMs: 400 })).handle(
      inbound('hello'),
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

  it('deferred: the worker delivers the text, the write, then the event, and records both', async () => {
    await deferredTurn();
    await new OutboxWorker({ db, client, logger }).drainOnce();

    expect(
      requests().filter(entry => !entry.includes('ai_message') && entry !== 'sendFlow reply_flow'),
    ).toEqual(['setField funnel_stage=nurturing', `sendFlow ${QUALIFIED_NS}`]);
    expect(requests()[0]).toBe('setField ai_message=Here you go.');
    const [turn] = await agentTurns();
    expect(turn!.actions).toEqual([
      WRITE,
      { tool: 'send_event', id: 'lead_qualified', status: 'performed' },
    ]);
  });

  it('dead-lettered: no event is sent and none is recorded', async () => {
    await deferredTurn();
    refuse(body => body.field_name === 'ai_message');
    const result = await new OutboxWorker({ db, client, logger }).drainOnce();

    expect(result.deadLettered).toBe(1);
    expect(requests()).toEqual(['setField ai_message=Here you go.']);
    const [turn] = await agentTurns();
    expect(turn!.actions).toEqual([
      { tool: 'set_field', id: 'funnel_stage', value: 'nurturing', status: 'dead_lettered' },
    ]);
  });
});
