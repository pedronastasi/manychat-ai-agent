import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { createTestDatabase } from '../helpers/db.ts';
import type { Database } from '../../src/db/client.ts';
import { nudges, turns } from '../../src/db/schema.ts';
import { TurnHandler } from '../../src/turn/handler.ts';
import type { AgentResult, AgentRunner, AgentTurnInput } from '../../src/agent/runner.ts';
import { ActionStage, buildTools } from '../../src/agent/tools.ts';
import type { ContactActions } from '../../src/agent/tools.ts';
import { RulesSchema, ToolsSchema } from '../../src/contracts/config.ts';
import type { InboundMessage } from '../../src/contracts/agent.ts';
import { loadEnv, loadTenantConfig } from '../../src/config/loader.ts';
import { ConversationStore } from '../../src/conversation/store.ts';
import { ManyChatHttpClient, manychatClientFor } from '../../src/channels/manychat/client.ts';
import type { ContactReader } from '../../src/channels/manychat/client.ts';
import { NudgeStore } from '../../src/nudge/store.ts';
import { NudgeWorker } from '../../src/nudge/worker.ts';
import { OutboxWorker } from '../../src/outbox/worker.ts';
import { FakeContactFields, fakeManyChatApi } from '../helpers/manychat.ts';
import { asProspect } from '../helpers/intent.ts';

/**
 * specs/049-a-flow-is-authored-per-channel.md § Verification items 3 to 7:
 * which namespace a turn sends, and which flows the server skips on a channel
 * without them. Over the ManyChat HTTP boundary and PGlite, against the
 * fictional demo tenant in test/fixtures/config with invented flows.
 */

const HOUR_MS = 3_600_000;
const GALLERY = {
  whatsapp: 'content00000000000000_000301',
  instagram: 'content00000000000000_000302',
};
const WELCOME = 'content00000000000000_000303';
const TIED = 'content00000000000000_000304';
const EVENT = 'content00000000000000_000305';

const fixture = loadTenantConfig('test/fixtures/config');
const tools = ToolsSchema.parse({
  ...fixture.tools,
  flows: [
    {
      id: 'gallery',
      flowNs: GALLERY,
      description: 'Photos of work by invented students.',
      repeatable: false,
    },
    // Strings: WhatsApp's alone, the deployment's default channel.
    { id: 'welcome', flowNs: WELCOME, role: 'opening', description: 'An invented welcome.' },
    { id: 'tied', flowNs: TIED, onStage: 'nurturing', description: 'An invented overview.' },
  ],
  events: [{ id: 'nurtured', stage: 'nurturing', flowNs: EVENT }],
});
const funnel = tools.fields.find(field => field.funnel)!;
const intent = tools.fields.find(field => field.intent)!;

const rules = RulesSchema.parse({
  messages: { acknowledgement: 'One moment.', escalation: 'Passing you to a person.' },
  budget: { dailyTokenCap: 100_000, dailyCostCapUsd: 5 },
  rateLimit: { turnsPerSubscriberPerHour: 60 },
});
const logger = { info: () => {}, warn: () => {}, error: () => {} };

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

/** Every flow ManyChat was asked to send, by namespace. */
const flowsSent = () =>
  api.calls.filter(call => call.path === '/fb/sending/sendFlow').map(call => call.body.flow_ns);

const inbound = (subscriberId: string, channel: string): InboundMessage => ({
  tenantId: 'demo',
  subscriberId,
  text: 'An invented question.',
  channel,
  contactName: null,
  locale: null,
  contactToken: contactFields.tokenOf(subscriberId),
  receivedAt: new Date(),
});

type Call = [tool: string, input: object];

const resultOf = (): AgentResult => ({
  reply: {
    messages: ['Here it is.'],
    escalate: false,
    escalation_reason: null,
    closing_question: null,
    confidence: 0.9,
  },
  model: 'mock:demo',
  usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, costUsd: 0.001 },
  interventions: [],
  latencyMs: 5,
  toolsOffered: true,
});

/** The flow ids `send_flow` offers on a turn, or undefined when it is not offered. */
const enumOf = (built: ReturnType<typeof buildTools>) => {
  const schema = built?.send_flow?.inputSchema as z.ZodObject | undefined;
  return (schema?.shape.flow as z.ZodEnum | undefined)?.options as string[] | undefined;
};

/**
 * A model that makes `calls` through the real tools of the turn it is given,
 * on the turn's channel, as the runner builds them; and records what it saw.
 */
function scriptedRunner(
  calls: Call[],
  seen: { inputs: AgentTurnInput[]; offered: (string[] | undefined)[] },
  prospect = true,
): AgentRunner {
  return {
    run: async input => {
      seen.inputs.push(input);
      const stage = input.stage ?? new ActionStage();
      const contact: ContactActions | undefined = prospect
        ? asProspect(input.contact)
        : input.contact;
      const built = buildTools(tools, stage, contact, undefined, {
        flows: input.flows,
        beforeFlow: input.beforeFlow,
        nudgeTurn: input.nudge !== undefined,
        channel: input.channel,
        defaultChannel: 'whatsapp',
      });
      seen.offered.push(enumOf(built));
      for (const [name, args] of calls) {
        await built?.[name]?.execute?.(args as never, {
          toolCallId: 'test',
          messages: [],
          context: {},
        });
      }
      return resultOf();
    },
  };
}

const handler = (runner: AgentRunner) =>
  new TurnHandler({
    db,
    runner,
    rules,
    tools,
    logger,
    raceDeadlineMs: 2000,
    modelAbortMs: 5000,
    tokenWriter: contactFields,
    tokensEnforced: true,
    actions: client,
    defaultChannel: 'whatsapp',
  });

/** Runs one turn and the actions it left for after the response. */
async function turn(runner: AgentRunner, subscriberId: string, channel: string) {
  const out = await handler(runner).handle(inbound(subscriberId, channel));
  await out.afterResponse?.();
  return out;
}

const seenFresh = () => ({
  inputs: [] as AgentTurnInput[],
  offered: [] as (string[] | undefined)[],
});

describe("a flow is sent through the turn's channel's namespace (specs/049 V3)", () => {
  it('sends the instagram value on an Instagram turn, never the whatsapp one', async () => {
    await turn(
      scriptedRunner([['send_flow', { flow: 'gallery' }]], seenFresh()),
      's1',
      'instagram',
    );

    expect(flowsSent()).toEqual([GALLERY.instagram]);
  });

  it('sends the whatsapp value on a WhatsApp turn', async () => {
    await turn(scriptedRunner([['send_flow', { flow: 'gallery' }]], seenFresh()), 's2', 'whatsapp');

    expect(flowsSent()).toEqual([GALLERY.whatsapp]);
  });
});

describe('sent once per contact, on any channel (specs/049 V4)', () => {
  it('does not offer on Instagram a flow performed on WhatsApp, and lists it as performed', async () => {
    await turn(scriptedRunner([['send_flow', { flow: 'gallery' }]], seenFresh()), 's3', 'whatsapp');
    const seen = seenFresh();
    await turn(scriptedRunner([], seen), 's3', 'instagram');

    expect(flowsSent()).toEqual([GALLERY.whatsapp]);
    expect(seen.inputs[0]!.contact!.sentFlows.has('gallery')).toBe(true);
    expect(seen.offered[0] ?? []).not.toContain('gallery');
    // The history note of the WhatsApp turn names the flow it performed (specs/012).
    const agentTurn = seen.inputs[0]!.history.find(entry => entry.role === 'agent');
    expect(agentTurn?.actions).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'gallery', status: 'performed' })]),
    );
  });
});

describe('an opening authored for another channel is not sent (specs/049 V5)', () => {
  const prospectWrite: Call = ['set_field', { field: intent.id, value: 'prospect' }];

  it('claims and sends nothing on an Instagram prospect turn, and tells the model nothing', async () => {
    const seen = seenFresh();
    await turn(scriptedRunner([prospectWrite], seen, false), 's4', 'instagram');

    expect(seen.inputs[0]!.contact?.openingDue).toBe(false);
    expect(seen.inputs[0]!.beforeFlow).toBeUndefined();
    expect(flowsSent()).toEqual([]);
    const [conversation] = await db.query.conversations.findMany();
    expect(conversation!.openingSentAt).toBeNull();
  });

  it('sends none later on WhatsApp either', async () => {
    await turn(scriptedRunner([prospectWrite], seenFresh(), false), 's5', 'instagram');
    const seen = seenFresh();
    await turn(scriptedRunner([['send_flow', { flow: 'gallery' }]], seen), 's5', 'whatsapp');

    expect(seen.inputs[0]!.contact?.openingDue).toBe(false);
    expect(flowsSent()).toEqual([GALLERY.whatsapp]);
  });

  it('sends it on a WhatsApp prospect turn, which has it', async () => {
    const seen = seenFresh();
    await turn(scriptedRunner([prospectWrite], seen, false), 's6', 'whatsapp');

    expect(seen.inputs[0]!.contact?.openingDue).toBe(true);
    await seen.inputs[0]!.beforeFlow?.();
    expect(flowsSent()).toEqual([WELCOME]);
  });
});

describe('the server skips a stage flow and event the channel lacks (specs/049 V6)', () => {
  const advance: Call = ['set_field', { field: funnel.id, value: 'nurturing' }];

  it('sends neither the tied flow nor the event on an Instagram turn', async () => {
    await turn(scriptedRunner([advance], seenFresh()), 's7', 'instagram');

    expect(flowsSent()).toEqual([]);
    const agent = (await db.select().from(turns).where(eq(turns.role, 'agent')))[0]!;
    const records = agent.actions ?? [];
    expect(records).toContainEqual(
      expect.objectContaining({ tool: 'set_field', id: funnel.id, value: 'nurturing' }),
    );
    expect(records.map(record => record.tool)).not.toContain('send_event');
    expect(records.map(record => record.id)).not.toContain('tied');
  });

  it('sends both on a WhatsApp turn, which has them', async () => {
    await turn(scriptedRunner([advance], seenFresh()), 's8', 'whatsapp');

    expect(flowsSent()).toEqual(expect.arrayContaining([TIED, EVENT]));
  });
});

describe("a nudge's flow is resolved on the nudge's channel (specs/049 V7)", () => {
  const noTags: ContactReader = {
    readContact: () => Promise.resolve({ tags: [], custom_fields: [] }),
  };

  it('performs a flow staged on an Instagram nudge with the instagram value', async () => {
    const store = new ConversationStore(db);
    const conversation = await store.startTurn({
      tenantId: 'demo',
      subscriberId: 's9',
      channel: 'instagram',
      idleResetHours: 24,
    });
    const userTurn = await store.recordUserMessage(conversation.id, 'An invented question.', {
      bound: true,
      channel: 'instagram',
    });
    await db
      .update(turns)
      .set({ createdAt: new Date(Date.now() - 2 * HOUR_MS) })
      .where(eq(turns.id, userTurn));
    await new NudgeStore(db).schedule(
      conversation.id,
      1,
      new Date(Date.now() - HOUR_MS),
      'instagram',
    );
    await db
      .update(nudges)
      .set({ dueAt: new Date(Date.now() - 60_000) })
      .where(eq(nudges.conversationId, conversation.id));

    const seen = seenFresh();
    const worker = new NudgeWorker({
      db,
      runner: scriptedRunner([['send_flow', { flow: 'gallery' }]], seen),
      config: () => ({ ...fixture, rules, tools }),
      contacts: noTags,
      logger,
      modelAbortMs: 5000,
    });
    expect(await worker.drainOnce()).toEqual(['sent']);
    expect(seen.inputs[0]!.channel).toBe('instagram');

    const env = loadEnv({
      AGENT_MODEL: 'anthropic:claude-haiku-4-5',
      PUBLIC_BASE_URL: 'https://agent.example.com',
      MANYCHAT_SHARED_SECRET: 'a'.repeat(32),
      MANYCHAT_API_TOKEN: 'tok',
      MANYCHAT_REPLY_FLOW_NS: 'content_whatsapp_reply',
      MANYCHAT_REPLY_FLOW_NS_INSTAGRAM: 'content_instagram_reply',
      CHANNELS: 'whatsapp,instagram',
      DATABASE_URL: 'postgres://unused',
    });
    await new OutboxWorker({
      db,
      client: manychatClientFor(env, api.fetch),
      logger,
      channel: 'whatsapp',
    }).drainOnce();

    expect(flowsSent()).toContain(GALLERY.instagram);
    expect(flowsSent()).not.toContain(GALLERY.whatsapp);
  });
});
