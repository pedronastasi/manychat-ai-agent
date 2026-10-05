import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '../helpers/db.ts';
import type { Database } from '../../src/db/client.ts';
import { turns } from '../../src/db/schema.ts';
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
 * specs/034-intent-before-the-sale.md § Verification items 4 and 5: the
 * opening goes out on the turn that first stages `prospect`, before the
 * model's first flow or else before a reply that does not escalate, once, and
 * never to a contact who is not a prospect; and an advert's course reaches the
 * model only when a bound request stored it. Over the ManyChat HTTP boundary,
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
const flowNs = (id: string) => tools.flows.find(flow => flow.id === id)!.flowNs;

const rules = RulesSchema.parse({
  messages: { acknowledgement: 'One moment.', escalation: 'Passing you to a person.' },
  budget: { dailyTokenCap: 100_000, dailyCostCapUsd: 5 },
  rateLimit: { turnsPerSubscriberPerHour: 60 },
  openingTrigger: { keywords: ['start workflow'], message: 'Welcome!' },
});

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const inbound = (
  text: string,
  opts: { subscriberId?: string; course?: string; unbound?: boolean } = {},
): InboundMessage => {
  const subscriberId = opts.subscriberId ?? 's1';
  return {
    tenantId: 'demo',
    subscriberId,
    text,
    channel: 'whatsapp',
    contactName: null,
    locale: null,
    contactToken: opts.unbound ? null : contactFields.tokenOf(subscriberId),
    receivedAt: new Date(),
    ...(opts.course ? { course: opts.course } : {}),
  };
};

const PROSPECT = ['set_field', { field: 'intent', value: 'prospect' }] as const;
const NOT_PROSPECT = ['set_field', { field: 'intent', value: 'not_prospect' }] as const;
const flow = (id: string) => ['send_flow', { flow: id }] as const;
type Call = readonly [tool: string, input: object];

interface Seen {
  contacts: (ContactActions | undefined)[];
  results: unknown[];
  openingsAtReply: number[];
}
const newSeen = (): Seen => ({ contacts: [], results: [], openingsAtReply: [] });

const openingSends = () =>
  api.calls.filter(call => call.path === '/fb/sending/sendFlow' && call.body.flow_ns === OPENING_NS)
    .length;
const sentFlows = () =>
  api.calls
    .filter(call => call.path === '/fb/sending/sendFlow')
    .map(call => String(call.body.flow_ns));

/**
 * A model that makes `calls` through the real tools, with the flow sender and
 * opening hook the turn handler passed, then answers or escalates.
 */
function runner(
  calls: readonly Call[],
  opts: { escalate?: boolean; delayMs?: number } = {},
  seen: Seen = newSeen(),
) {
  return {
    run: async ({ stage = new ActionStage(), contact, flows, beforeFlow }) => {
      seen.contacts.push(contact);
      const built = buildTools(tools, stage, contact, undefined, { flows, beforeFlow });
      for (const [name, input] of calls) {
        seen.results.push(
          await built?.[name]?.execute?.(input as never, {
            toolCallId: 'test',
            messages: [],
            context: {},
          }),
        );
      }
      if (opts.delayMs) await new Promise(resolve => setTimeout(resolve, opts.delayMs));
      seen.openingsAtReply.push(openingSends());
      const result: AgentResult = {
        reply: {
          messages: ['Here you are.'],
          escalate: opts.escalate ?? false,
          escalation_reason: opts.escalate ? 'payment_reported' : null,
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

const handler = (agent: AgentRunner, raceDeadlineMs = 2000) =>
  new TurnHandler({
    db,
    runner: agent,
    rules,
    tools,
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

/** Runs a turn and its after-response work, so staged writes are performed. */
async function turn(agent: AgentRunner, message: InboundMessage) {
  const out = await handler(agent).handle(message);
  await out.afterResponse?.();
  return out;
}

/* -------------------------------------------------------------------------- */
/* V4 — the opening goes out on the prospect turn                             */
/* -------------------------------------------------------------------------- */

describe('the opening goes out on the prospect turn (specs/034 V4)', () => {
  it('on a first turn with no flow: after the model answers, before the turn returns', async () => {
    const seen = newSeen();
    await turn(runner([PROSPECT], {}, seen), inbound('how much is it?'));

    // Not before the model decided: an escalation must be able to stop it.
    expect(seen.openingsAtReply).toEqual([0]);
    expect(openingSends()).toBe(1);
    // The write names the opening, so the reply neither greets nor repeats it.
    expect(seen.results[0]).toEqual({
      staged: true,
      openingQueued: { flow: 'welcome_note', description: expect.any(String) },
    });
    const [agent] = await agentTurns();
    // In the order things happened: the write was staged, then the opening sent.
    expect(agent!.actions).toEqual([
      { tool: 'set_field', id: 'intent', value: 'prospect', status: 'performed' },
      { tool: 'send_flow', id: 'welcome_note', status: 'performed', origin: 'opening' },
    ]);
  });

  it('just before the model’s first flow, and still sent when the turn escalates', async () => {
    await turn(runner([PROSPECT, flow('student_results')], { escalate: true }), inbound('hey'));

    expect(sentFlows()).toEqual([OPENING_NS, flowNs('student_results')]);
    const [agent] = await agentTurns();
    expect(agent!.actions).toEqual([
      { tool: 'set_field', id: 'intent', value: 'prospect', status: 'discarded' },
      { tool: 'send_flow', id: 'welcome_note', status: 'performed', origin: 'opening' },
      { tool: 'send_flow', id: 'student_results', status: 'performed' },
    ]);
  });

  it('on a later turn, once the contact first stages prospect', async () => {
    await turn(runner([]), inbound('hi'));
    expect(openingSends()).toBe(0);

    await turn(runner([PROSPECT]), inbound('actually, I would like to enrol'));
    expect(openingSends()).toBe(1);
  });

  it('never on an unknown or not_prospect turn', async () => {
    const seen = newSeen();
    await turn(runner([], {}, seen), inbound('hi'));
    await turn(runner([NOT_PROSPECT, flow('student_results')], {}, seen), inbound('I sell kits'));

    expect(openingSends()).toBe(0);
    expect(sentFlows()).toEqual([]);
    expect(seen.contacts.map(contact => contact?.openingDue)).toEqual([true, true]);
  });

  it('not on an escalated prospect turn with no flow, nor on any turn after it', async () => {
    await turn(runner([PROSPECT], { escalate: true }), inbound('I already paid'));
    expect(openingSends()).toBe(0);
    expect((await agentTurns())[0]!.actions).toEqual([
      { tool: 'set_field', id: 'intent', value: 'prospect', status: 'discarded' },
    ]);

    const seen = newSeen();
    await turn(runner([PROSPECT], {}, seen), inbound('when does it start?'));
    expect(seen.contacts[0]?.openingDue).toBe(false);
    expect(openingSends()).toBe(0);
  });

  it('not to a prospect by the rollout rule, who never staged the write', async () => {
    await turn(runner([]), inbound('hi'));
    // A stage past new, performed before the gate existed.
    const [first] = await agentTurns();
    await db
      .update(turns)
      .set({
        actions: [
          { tool: 'set_field', id: 'funnel_stage', value: 'nurturing', status: 'performed' },
        ],
      })
      .where(eq(turns.id, first!.id));

    const seen = newSeen();
    await turn(runner([flow('student_results')], {}, seen), inbound('can I see some work?'));
    expect(seen.contacts[0]).toMatchObject({ intent: 'prospect', openingDue: false });
    expect(sentFlows()).toEqual([flowNs('student_results')]);
  });

  it('not a second time', async () => {
    await turn(runner([PROSPECT]), inbound('how much is it?'));
    const seen = newSeen();
    await turn(runner([PROSPECT], {}, seen), inbound('and when does it start?'));

    expect(seen.contacts[0]).toMatchObject({ intent: 'prospect', openingDue: false });
    expect(seen.results[0]).toEqual({ staged: true });
    expect(openingSends()).toBe(1);
  });

  it('not on a scripted opening, which is no model turn', async () => {
    const out = await turn(runner([PROSPECT]), inbound('start workflow'));
    expect(out.outcome).toBe('answered_scripted');
    expect(openingSends()).toBe(0);

    await turn(runner([PROSPECT]), inbound('yes, the prices please'));
    expect(openingSends()).toBe(1);
  });

  it('once, when three prospect messages arrive together', async () => {
    const agent = runner([PROSPECT], { delayMs: 20 });
    await Promise.all(
      ['how much?', 'when does it start?', 'is it online?'].map(text =>
        handler(agent).handle(inbound(text)),
      ),
    );
    expect(openingSends()).toBe(1);
  });

  it('by a deferred call, after the holding line, recorded on its turn', async () => {
    const out = await handler(runner([PROSPECT], { delayMs: 300 }), 100).handle(
      inbound('how much?'),
    );
    expect(out.outcome).toBe('deferred');
    expect(out.reply.messages).toEqual(['One moment.']);

    await vi.waitFor(async () => expect(await agentTurns()).toHaveLength(1), { timeout: 3000 });
    expect(openingSends()).toBe(1);
    expect((await agentTurns())[0]!.actions).toContainEqual({
      tool: 'send_flow',
      id: 'welcome_note',
      status: 'performed',
      origin: 'opening',
    });
  });

  it('to each contact once, independently', async () => {
    await turn(runner([PROSPECT]), inbound('how much?', { subscriberId: 's1' }));
    await turn(runner([PROSPECT]), inbound('how much?', { subscriberId: 's2' }));
    expect(openingSends()).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* V5 — an advert's course is one a bound request stored                      */
/* -------------------------------------------------------------------------- */

describe('an advert’s course reaches the model only from a bound request (specs/034 V5)', () => {
  it('passes a course a bound request stored as the advert’s', async () => {
    const seen = newSeen();
    await turn(runner([], {}, seen), inbound('hi', { course: 'advanced' }));
    expect(seen.contacts[0]?.advertCourse).toBe('advanced');
  });

  it('keeps it on a later turn that carries no course', async () => {
    await turn(runner([]), inbound('hi', { course: 'advanced' }));
    const seen = newSeen();
    await turn(runner([], {}, seen), inbound('hello?'));
    expect(seen.contacts[0]?.advertCourse).toBe('advanced');
  });

  it('passes none for a course on an unbound request, which is not stored', async () => {
    await turn(runner([]), inbound('hi'));
    const seen = newSeen();
    await turn(runner([], {}, seen), inbound('hi again', { course: 'advanced', unbound: true }));

    // It still narrows the turn's flows (specs/028); it is not the contact's advert.
    expect(seen.contacts[0]?.course).toBe('advanced');
    expect(seen.contacts[0]?.advertCourse).toBeUndefined();
  });

  it('passes none for a course the agent wrote', async () => {
    await turn(
      runner([PROSPECT, ['set_field', { field: 'course', value: 'foundation' }]]),
      inbound('the foundation one, please'),
    );
    const seen = newSeen();
    await turn(runner([], {}, seen), inbound('ok'));
    expect(seen.contacts[0]?.course).toBe('foundation');
    expect(seen.contacts[0]?.advertCourse).toBeUndefined();
  });
});
