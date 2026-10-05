import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '../helpers/db.ts';
import type { Database } from '../../src/db/client.ts';
import { conversations, nudges, turns } from '../../src/db/schema.ts';
import { TurnHandler } from '../../src/routes/turn.ts';
import type { AgentResult, AgentRunner, AgentTurnInput } from '../../src/agent/runner.ts';
import { ActionStage, buildTools } from '../../src/agent/tools.ts';
import { RulesSchema } from '../../src/contracts/config.ts';
import type { Rules } from '../../src/contracts/config.ts';
import type { AgentReply, InboundMessage } from '../../src/contracts/agent.ts';
import { loadTenantConfig } from '../../src/config/loader.ts';
import type { TenantConfig } from '../../src/config/loader.ts';
import { ConversationStore } from '../../src/conversation/store.ts';
import { NudgeStore } from '../../src/nudge/store.ts';
import { NudgeWorker } from '../../src/nudge/worker.ts';
import { OutboxWorker } from '../../src/outbox/worker.ts';
import { ManyChatHttpClient } from '../../src/channels/manychat/client.ts';
import type { ContactReader } from '../../src/channels/manychat/client.ts';
import type { ContactRecord } from '../../src/contracts/manychat.ts';
import { FakeActions, FakeContactFields, fakeManyChatApi } from '../helpers/manychat.ts';
import { asProspect } from '../helpers/intent.ts';

/**
 * specs/025-in-window-nudge.md § Verification items 2 (one pending row),
 * 3 (each cancellation reason), 4 (a failed read), 5 (a declined nudge) and
 * 6 (delivery through the reply field and flow, text before actions), against
 * PGlite and the fictional demo tenant in test/fixtures/config.
 */

let db: Database;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
});
afterEach(async () => {
  await close();
});

const fixture = loadTenantConfig('test/fixtures/config');
const tools = fixture.tools!;

const rulesWith = (overrides: object = {}): Rules =>
  RulesSchema.parse({
    messages: { acknowledgement: 'One moment.', escalation: 'Passing you to a person.' },
    budget: { dailyTokenCap: 100_000, dailyCostCapUsd: 5 },
    rateLimit: { turnsPerSubscriberPerHour: 60 },
    ...overrides,
  });

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const MINUTE_MS = 60_000;

const FOLLOW_UP: AgentReply = {
  messages: ['Just checking in about the class times.'],
  escalate: false,
  escalation_reason: null,
  confidence: 0.85,
  closing_question: 'Would weekday evenings suit you?',
};

const DECLINED: AgentReply = {
  messages: ['Nothing to follow up.'],
  escalate: true,
  escalation_reason: 'low_confidence',
  confidence: 0.4,
  closing_question: null,
};

/**
 * A model that stages `flow` through the real tools, then answers `reply`,
 * and records every turn it was given.
 */
function scriptedRunner(reply: AgentReply, flow?: string) {
  const inputs: AgentTurnInput[] = [];
  const runner: AgentRunner = {
    run: async input => {
      inputs.push(input);
      const stage = input.stage ?? new ActionStage();
      const built = buildTools(tools, stage, asProspect(input.contact), undefined, {
        nudgeTurn: input.nudge !== undefined,
      });
      if (flow) {
        await built?.send_flow?.execute?.(
          { flow },
          { toolCallId: 'test', messages: [], context: {} },
        );
      }
      const result: AgentResult = {
        reply,
        model: 'mock:demo',
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, costUsd: 0.001 },
        interventions: [],
        latencyMs: 5,
        toolsOffered: true,
      };
      return result;
    },
  };
  return { runner, inputs };
}

/** ManyChat's getInfo at the ContactReader port, as specs/024 parses it. */
class FakeTags implements ContactReader {
  tags: string[] = [];
  failing = false;
  reads = 0;
  readContact(): Promise<ContactRecord> {
    this.reads++;
    if (this.failing) return Promise.reject(new Error('ManyChat unavailable'));
    return Promise.resolve({ tags: this.tags, custom_fields: [] });
  }
}

const tenantWith = (rules: Rules): TenantConfig => ({ ...fixture, rules });

function worker(runner: AgentRunner, contacts: ContactReader, rules = rulesWith()) {
  return new NudgeWorker({
    db,
    runner,
    config: () => tenantWith(rules),
    contacts,
    logger,
    modelAbortMs: 5000,
  });
}

/**
 * A contact who last wrote `minutesAgo` minutes ago, with a nudge that fell
 * due a minute ago.
 */
async function quietContact(opts: { minutesAgo?: number; subscriberId?: string } = {}) {
  const minutesAgo = opts.minutesAgo ?? 120;
  const store = new ConversationStore(db);
  const wroteAt = new Date(Date.now() - minutesAgo * MINUTE_MS);
  const conversation = await store.startTurn(
    {
      tenantId: 'demo',
      subscriberId: opts.subscriberId ?? 's1',
      channel: 'whatsapp',
      idleResetHours: 24,
    },
    wroteAt,
  );
  await db.insert(turns).values([
    {
      conversationId: conversation.id,
      role: 'user',
      text: 'when are the classes?',
      createdAt: wroteAt,
    },
    {
      conversationId: conversation.id,
      role: 'agent',
      text: 'Tuesdays and Thursdays.',
      outcome: 'answered_inline',
      createdAt: new Date(wroteAt.getTime() + 1000),
    },
  ]);
  await new NudgeStore(db).schedule(conversation.id, minutesAgo - 1, wroteAt);
  return conversation.id;
}

const nudgeRows = (conversationId?: string) =>
  db.query.nudges.findMany({
    ...(conversationId ? { where: eq(nudges.conversationId, conversationId) } : {}),
    orderBy: (table, { asc }) => [asc(table.createdAt)],
  });

const agentTurns = async (conversationId: string) =>
  (
    await db.query.turns.findMany({
      where: eq(turns.conversationId, conversationId),
      orderBy: (table, { asc }) => [asc(table.seq)],
    })
  ).filter(turn => turn.role === 'agent');

/* -------------------------------------------------------------------------- */
/* V2                                                                          */
/* -------------------------------------------------------------------------- */

describe('at most one nudge waits per contact (specs/025 V2)', () => {
  it('scheduling twice leaves one pending row, due at the later delay', async () => {
    const id = await quietContact();
    const store = new NudgeStore(db);
    const now = new Date();
    await store.schedule(id, 120, now);
    await store.schedule(id, 1200, now);

    const rows = await nudgeRows(id);
    expect(rows.filter(row => row.status === 'pending')).toHaveLength(1);
    expect(rows[0]!.dueAt.getTime()).toBe(now.getTime() + 1200 * MINUTE_MS);
  });

  it('the database refuses a second pending row, whoever inserts it', async () => {
    const id = await quietContact();
    await expect(
      db.insert(nudges).values({ conversationId: id, dueAt: new Date() }),
    ).rejects.toThrow();
  });

  it('a staged schedule_nudge is performed as a row once the reply is out', async () => {
    const actions = new FakeActions();
    const contactFields = new FakeContactFields();
    const runner: AgentRunner = {
      run: async ({ stage = new ActionStage() }) => {
        const built = buildTools(tools, stage, asProspect());
        await built!.schedule_nudge!.execute!({ delay: 'later_today' } as never, {
          toolCallId: 'test',
          messages: [],
          context: {},
        });
        return {
          reply: FOLLOW_UP,
          model: 'mock:demo',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, costUsd: 0 },
          interventions: [],
          latencyMs: 1,
          toolsOffered: true,
        };
      },
    };
    const handler = new TurnHandler({
      db,
      runner,
      rules: rulesWith(),
      tools,
      logger,
      raceDeadlineMs: 1000,
      modelAbortMs: 5000,
      tokenWriter: contactFields,
      tokensEnforced: false,
      actions,
    });
    const inbound: InboundMessage = {
      tenantId: 'demo',
      subscriberId: 's9',
      text: 'when are the classes?',
      channel: 'whatsapp',
      contactName: null,
      locale: null,
      contactToken: null,
      receivedAt: new Date(),
    };
    const out = await handler.handle(inbound);
    expect(await nudgeRows(out.conversationId)).toHaveLength(0);
    await out.afterResponse!();

    const [row] = await nudgeRows(out.conversationId);
    expect(row).toMatchObject({ status: 'pending' });
    // Never a ManyChat request.
    expect(actions.performed).toHaveLength(0);
    const [turn] = await agentTurns(out.conversationId);
    expect(turn!.actions).toEqual([
      { tool: 'schedule_nudge', id: 'later_today', status: 'performed' },
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* V3, V4                                                                      */
/* -------------------------------------------------------------------------- */

describe('each cancellation reason cancels without a model call (specs/025 V3)', () => {
  const expectCancelled = async (id: string, reason: string, inputs: unknown[]) => {
    const [row] = await nudgeRows(id);
    expect(row).toMatchObject({ status: 'cancelled', cancelReason: reason });
    expect(inputs).toHaveLength(0);
    expect(await agentTurns(id)).toHaveLength(1);
  };

  it('contact_replied: any inbound message cancels at the start of the turn', async () => {
    const id = await quietContact();
    const { runner, inputs } = scriptedRunner(FOLLOW_UP);
    const handler = new TurnHandler({
      db,
      runner: scriptedRunner(FOLLOW_UP).runner,
      rules: rulesWith(),
      tools,
      logger,
      raceDeadlineMs: 1000,
      modelAbortMs: 5000,
      tokenWriter: new FakeContactFields(),
      tokensEnforced: false,
      actions: new FakeActions(),
    });
    await handler.handle({
      tenantId: 'demo',
      subscriberId: 's1',
      text: 'thanks',
      channel: 'whatsapp',
      contactName: null,
      locale: null,
      contactToken: null,
      receivedAt: new Date(),
    });
    const [row] = await nudgeRows(id);
    expect(row).toMatchObject({ status: 'cancelled', cancelReason: 'contact_replied' });
    expect(await worker(runner, new FakeTags()).drainOnce()).toEqual([]);
    expect(inputs).toHaveLength(0);
  });

  it('contact_replied: a message that lands while the model runs sends nothing', async () => {
    const id = await quietContact();
    const inputs: AgentTurnInput[] = [];
    const runner: AgentRunner = {
      run: async input => {
        inputs.push(input);
        await db.insert(turns).values({ conversationId: id, role: 'user', text: 'hello again' });
        return scriptedRunner(FOLLOW_UP).runner.run(input);
      },
    };
    expect(await worker(runner, new FakeTags()).drainOnce()).toEqual(['contact_replied']);
    expect((await nudgeRows(id))[0]).toMatchObject({ cancelReason: 'contact_replied' });
    expect(await db.query.outbox.findMany()).toHaveLength(0);
  });

  it('escalated: a turn that escalates cancels the pending nudge', async () => {
    const id = await quietContact();
    const { runner, inputs } = scriptedRunner(FOLLOW_UP);
    // As the turn handler's escalation records it, after the nudge was scheduled.
    await new ConversationStore(db).markEscalated(id);
    expect(await worker(runner, new FakeTags()).drainOnce()).toEqual(['escalated']);
    await expectCancelled(id, 'escalated', inputs);
  });

  it('escalated: an escalating turn cancels a nudge that landed during it', async () => {
    const id = await quietContact();
    // Another turn's staged schedule_nudge is performed while this one runs.
    const runner: AgentRunner = {
      run: async input => {
        await new NudgeStore(db).schedule(id, 60);
        return scriptedRunner(DECLINED).runner.run(input);
      },
    };
    const handler = new TurnHandler({
      db,
      runner,
      rules: rulesWith(),
      tools,
      logger,
      raceDeadlineMs: 1000,
      modelAbortMs: 5000,
      tokenWriter: new FakeContactFields(),
      tokensEnforced: false,
      actions: new FakeActions(),
    });
    const out = await handler.handle({
      tenantId: 'demo',
      subscriberId: 's1',
      text: 'i want my money back',
      channel: 'whatsapp',
      contactName: null,
      locale: null,
      contactToken: null,
      receivedAt: new Date(),
    });
    expect(out.outcome).toBe('escalated_model');
    const rows = await nudgeRows(id);
    expect(rows.map(row => [row.status, row.cancelReason])).toEqual([
      ['cancelled', 'contact_replied'],
      ['cancelled', 'escalated'],
    ]);
  });

  it('link_sent: performing the payment-link flow cancels the pending nudge', async () => {
    const id = await quietContact();
    const conversation = await db.query.conversations.findFirst({
      where: eq(conversations.id, id),
    });
    // The deferred path: the outbox performs the flow, then the server's write.
    const api = fakeManyChatApi();
    const client = new ManyChatHttpClient({
      apiToken: 'test-token',
      baseUrl: 'https://api.example.com',
      replyField: 'ai_message',
      replyFlowNs: 'reply_flow',
      tokenField: 'ai_token',
      fetchImpl: api.fetch,
    });
    const stage = new ActionStage();
    await buildTools(tools, stage, asProspect())!.send_flow!.execute!(
      { flow: 'enrolment_link', contactAsked: true } as never,
      {
        toolCallId: 'test',
        messages: [],
        context: {},
      },
    );
    const turnId = await new ConversationStore(db).recordAgentReply(id, 'Here it is.', 'deferred', {
      bound: true,
      actions: stage.records('staged'),
    });
    const { OutboxQueue } = await import('../../src/outbox/queue.ts');
    await new OutboxQueue(db).enqueue({
      tenantId: 'demo',
      subscriberId: conversation!.subscriberId,
      conversationId: id,
      reply: FOLLOW_UP,
      actions: { staged: stage.staged, turnId },
    });
    await new OutboxWorker({ db, client, logger }).drainOnce();

    const [row] = await nudgeRows(id);
    expect(row).toMatchObject({ status: 'cancelled', cancelReason: 'link_sent' });
  });

  it('link_sent: a funnel already at link_sent cancels at due time', async () => {
    const id = await quietContact();
    await new ConversationStore(db).recordAgentReply(id, 'Here it is.', 'answered_inline', {
      bound: true,
      actions: [
        { tool: 'send_flow', id: 'enrolment_link', status: 'performed', contactAsked: true },
        { tool: 'set_field', id: 'funnel_stage', value: 'link_sent', status: 'performed' },
      ],
    });
    const { runner, inputs } = scriptedRunner(FOLLOW_UP);
    expect(await worker(runner, new FakeTags()).drainOnce()).toEqual(['link_sent']);
    const [row] = await nudgeRows(id);
    expect(row).toMatchObject({ status: 'cancelled', cancelReason: 'link_sent' });
    expect(inputs).toHaveLength(0);
  });

  it('window_closing: past the last inbound + 1380 minutes', async () => {
    const id = await quietContact({ minutesAgo: 1381 });
    const { runner, inputs } = scriptedRunner(FOLLOW_UP);
    expect(await worker(runner, new FakeTags()).drainOnce()).toEqual(['window_closing']);
    await expectCancelled(id, 'window_closing', inputs);
  });

  it('human_active: the contact has the humanActiveTag', async () => {
    const id = await quietContact();
    const { runner, inputs } = scriptedRunner(FOLLOW_UP);
    const tags = new FakeTags();
    tags.tags = ['interested-foundation-course', tools.nudge!.humanActiveTag!];
    expect(await worker(runner, tags).drainOnce()).toEqual(['human_active']);
    await expectCancelled(id, 'human_active', inputs);
  });

  it('cap_reached: the turn cap would refuse the turn', async () => {
    const id = await quietContact();
    const { runner, inputs } = scriptedRunner(FOLLOW_UP);
    const rules = rulesWith({ maxTurnsPerConversation: 1 });
    expect(await worker(runner, new FakeTags(), rules).drainOnce()).toEqual(['cap_reached']);
    await expectCancelled(id, 'cap_reached', inputs);
  });

  it('cap_reached: the daily budget is spent', async () => {
    const id = await quietContact();
    const { runner, inputs } = scriptedRunner(FOLLOW_UP);
    const rules = rulesWith({ budget: { dailyTokenCap: 10, dailyCostCapUsd: 5 } });
    const { BudgetGuard } = await import('../../src/conversation/budget.ts');
    await new BudgetGuard(db).recordSpend('demo', 10, 0);
    expect(await worker(runner, new FakeTags(), rules).drainOnce()).toEqual(['cap_reached']);
    await expectCancelled(id, 'cap_reached', inputs);
  });

  it('cap_reached: the contact is over the hourly rate', async () => {
    const id = await quietContact();
    const { runner, inputs } = scriptedRunner(FOLLOW_UP);
    const rules = rulesWith({ rateLimit: { turnsPerSubscriberPerHour: 1 } });
    const { BudgetGuard } = await import('../../src/conversation/budget.ts');
    await new BudgetGuard(db).checkRateLimit('demo', 's1', rules);
    expect(await worker(runner, new FakeTags(), rules).drainOnce()).toEqual(['cap_reached']);
    await expectCancelled(id, 'cap_reached', inputs);
  });

  it('a nudge not yet due is not claimed', async () => {
    const id = await quietContact();
    await new NudgeStore(db).schedule(id, 60);
    const { runner, inputs } = scriptedRunner(FOLLOW_UP);
    expect(await worker(runner, new FakeTags()).drainOnce()).toEqual([]);
    expect((await nudgeRows(id))[0]).toMatchObject({ status: 'pending' });
    expect(inputs).toHaveLength(0);
  });
});

describe('a failed read cancels the nudge (specs/025 V4)', () => {
  it('records read_failed and makes no model call', async () => {
    const id = await quietContact();
    const { runner, inputs } = scriptedRunner(FOLLOW_UP);
    const tags = new FakeTags();
    tags.failing = true;
    expect(await worker(runner, tags).drainOnce()).toEqual(['read_failed']);
    expect(tags.reads).toBe(1);
    const [row] = await nudgeRows(id);
    expect(row).toMatchObject({ status: 'cancelled', cancelReason: 'read_failed' });
    expect(inputs).toHaveLength(0);
  });

  it('makes no read when the tenant sets no humanActiveTag', async () => {
    const id = await quietContact();
    const { runner } = scriptedRunner(FOLLOW_UP);
    const tags = new FakeTags();
    tags.failing = true;
    const untagged: TenantConfig = {
      ...fixture,
      rules: rulesWith(),
      tools: { ...tools, nudge: { delays: tools.nudge!.delays } },
    };
    const nudgeWorker = new NudgeWorker({
      db,
      runner,
      config: () => untagged,
      contacts: tags,
      logger,
      modelAbortMs: 5000,
    });
    expect(await nudgeWorker.drainOnce()).toEqual(['sent']);
    expect(tags.reads).toBe(0);
    expect((await nudgeRows(id))[0]).toMatchObject({ status: 'sent' });
  });
});

/* -------------------------------------------------------------------------- */
/* V5                                                                          */
/* -------------------------------------------------------------------------- */

describe('a nudge the model declines sends nothing (specs/025 V5)', () => {
  it('records nudge_skipped, discards what it staged, enqueues nothing', async () => {
    const id = await quietContact();
    const { runner, inputs } = scriptedRunner(DECLINED, 'student_results');
    expect(await worker(runner, new FakeTags()).drainOnce()).toEqual(['skipped']);

    expect(inputs).toHaveLength(1);
    expect((await nudgeRows(id))[0]).toMatchObject({ status: 'skipped', cancelReason: null });
    const turnsNow = await agentTurns(id);
    expect(turnsNow.at(-1)).toMatchObject({
      outcome: 'nudge_skipped',
      actions: [{ tool: 'send_flow', id: 'student_results', status: 'discarded' }],
    });
    expect(await db.query.outbox.findMany()).toHaveLength(0);
    // No person is notified: the conversation is not marked escalated.
    const conversation = await db.query.conversations.findFirst({
      where: eq(conversations.id, id),
    });
    expect(conversation!.escalatedAt).toBeNull();
    // And what was never sent never enters the model's history.
    const history = await new ConversationStore(db).recentTurns(id, new Date(0));
    expect(history.map(turn => turn.text)).not.toContain('Nothing to follow up.');
  });
});

/* -------------------------------------------------------------------------- */
/* V6                                                                          */
/* -------------------------------------------------------------------------- */

describe('a sent nudge is delivered through the reply field and flow (specs/025 V6)', () => {
  it('runs on a system note, then delivers text before actions', async () => {
    const id = await quietContact();
    const { runner, inputs } = scriptedRunner(FOLLOW_UP, 'student_results');
    expect(await worker(runner, new FakeTags()).drainOnce()).toEqual(['sent']);

    // A nudge turn: no contact text, the silence's start, no schedule_nudge.
    expect(inputs[0]).toMatchObject({ text: '', nudge: { since: expect.any(Date) } });
    expect(inputs[0]!.history.map(turn => turn.role)).toEqual(['user', 'agent']);

    const [turn] = (await agentTurns(id)).slice(-1);
    expect(turn).toMatchObject({
      outcome: 'nudge_sent',
      actions: [{ tool: 'send_flow', id: 'student_results', status: 'staged' }],
    });
    const conversation = await db.query.conversations.findFirst({
      where: eq(conversations.id, id),
    });
    // Counted toward the turn cap like any model turn.
    expect(conversation!.turnCount).toBe(2);

    const api = fakeManyChatApi();
    const client = new ManyChatHttpClient({
      apiToken: 'test-token',
      baseUrl: 'https://api.example.com',
      replyField: 'ai_message',
      replyFlowNs: 'reply_flow',
      tokenField: 'ai_token',
      fetchImpl: api.fetch,
    });
    await new OutboxWorker({ db, client, logger }).drainOnce();

    expect(api.calls.map(call => [call.path, call.body.field_name ?? call.body.flow_ns])).toEqual([
      ['/fb/subscriber/setCustomFieldByName', 'ai_message'],
      ['/fb/sending/sendFlow', 'reply_flow'],
      ['/fb/sending/sendFlow', 'content00000000000000_000002'],
    ]);
    expect((await agentTurns(id)).at(-1)!.actions).toEqual([
      { tool: 'send_flow', id: 'student_results', status: 'performed' },
    ]);
    expect((await nudgeRows(id))[0]).toMatchObject({ status: 'sent' });
  });

  it('a nudge turn never schedules another', async () => {
    const id = await quietContact();
    const offered: string[][] = [];
    const runner: AgentRunner = {
      run: async input => {
        const built = buildTools(
          tools,
          input.stage ?? new ActionStage(),
          asProspect(input.contact),
          undefined,
          {
            nudgeTurn: input.nudge !== undefined,
          },
        );
        offered.push(Object.keys(built ?? {}));
        return scriptedRunner(FOLLOW_UP).runner.run(input);
      },
    };
    await worker(runner, new FakeTags()).drainOnce();
    expect(offered[0]).not.toContain('schedule_nudge');
    expect(await nudgeRows(id)).toHaveLength(1);
  });
});

describe('a nudge whose model call fails sends nothing (specs/025 § A nudge turn)', () => {
  it('ends skipped with no turn and nothing enqueued', async () => {
    const id = await quietContact();
    const runner: AgentRunner = { run: () => Promise.reject(new Error('provider down')) };
    expect(await worker(runner, new FakeTags()).drainOnce()).toEqual(['skipped']);
    expect((await nudgeRows(id))[0]).toMatchObject({ status: 'skipped' });
    expect(await agentTurns(id)).toHaveLength(1);
    expect(await db.query.outbox.findMany()).toHaveLength(0);
  });

  it('the polling loop runs a due nudge and stops cleanly', async () => {
    const id = await quietContact();
    const { runner } = scriptedRunner(FOLLOW_UP);
    const nudgeWorker = new NudgeWorker({
      db,
      runner,
      config: () => tenantWith(rulesWith()),
      contacts: new FakeTags(),
      logger,
      modelAbortMs: 5000,
      pollIntervalMs: 10,
    });
    const stop = nudgeWorker.start();
    await vi.waitFor(async () => {
      expect((await nudgeRows(id))[0]).toMatchObject({ status: 'sent' });
    });
    await stop();
  });
});

describe('a nudge turn keeps its flows staged (specs/029 V5)', () => {
  it('is given no flow sender, so its flow follows its text', async () => {
    const id = await quietContact();
    const { runner, inputs } = scriptedRunner(FOLLOW_UP, 'student_results');
    expect(await worker(runner, new FakeTags()).drainOnce()).toEqual(['sent']);

    expect(inputs[0]!.flows).toBeUndefined();
    const [, nudgeTurn] = await agentTurns(id);
    expect(nudgeTurn!.actions).toEqual([
      { tool: 'send_flow', id: 'student_results', status: 'staged' },
    ]);
  });
});
