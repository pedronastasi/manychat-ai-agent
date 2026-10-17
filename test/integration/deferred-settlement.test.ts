import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '../helpers/db.ts';
import type { Database } from '../../src/db/client.ts';
import { outbox, turns } from '../../src/db/schema.ts';
import { ConversationStore } from '../../src/conversation/store.ts';
import { BudgetGuard } from '../../src/conversation/budget.ts';
import { NudgeStore } from '../../src/nudge/store.ts';
import { OutboxQueue } from '../../src/outbox/queue.ts';
import { ActionStage } from '../../src/agent/tools.ts';
import type { AgentResult } from '../../src/agent/runner.ts';
import { RulesSchema } from '../../src/contracts/config.ts';
import { ContactOutbox, ReplyDelivery } from '../../src/turn/delivery.ts';
import { DeferredSettlement } from '../../src/turn/deferred.ts';
import { TurnRecorder } from '../../src/turn/recorder.ts';
import { plainReply } from '../../src/turn/replies.ts';

/**
 * DeferredSettlement finishes a turn whose race was lost (ADR-0001): the
 * reply completes into the outbox with the actions it staged (specs/012 § The
 * whole loop runs inside the race), a silent response's held-back holding
 * line goes out when the call fails (specs/030), a superseded reply is never
 * sent (specs/046), and a reply that cannot be queued after a silent response
 * is handed to a person (C6). Every value is invented.
 */

let db: Database;
let close: () => Promise<void>;
let store: ConversationStore;
let conversationId: string;
beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
  store = new ConversationStore(db);
  const conversation = await store.startTurn(
    { tenantId: 'demo', subscriberId: 's1', channel: 'whatsapp', idleResetHours: 24 },
    new Date(),
  );
  conversationId = conversation.id;
});
afterEach(async () => {
  await close();
});

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const rules = RulesSchema.parse({
  messages: { acknowledgement: 'One moment.', escalation: 'Passing you to a person.' },
  budget: { dailyTokenCap: 100_000, dailyCostCapUsd: 5 },
  rateLimit: { turnsPerSubscriberPerHour: 60 },
});
const holding = plainReply(['One moment.']);

function settlementFor(
  options: {
    silent?: boolean;
    superseded?: boolean;
    stage?: ActionStage;
    /** The conversation the turn writes to; one that does not exist fails every write. */
    turnConversation?: string;
  } = {},
) {
  const stage = options.stage ?? new ActionStage();
  const id = options.turnConversation ?? conversationId;
  const nudges = new NudgeStore(db);
  const contactOutbox = new ContactOutbox(
    { queue: new OutboxQueue(db), store, nudges, rules, logger },
    { tenantId: 'demo', subscriberId: 's1' },
  );
  return new DeferredSettlement({
    logger,
    stage,
    recorder: new TurnRecorder(
      { store, budget: new BudgetGuard(db), nudges },
      { conversationId: id, tenantId: 'demo', bound: true, logger, stage },
    ),
    delivery: new ReplyDelivery(contactOutbox, {
      conversationId: id,
      logger,
      late: false,
      deadlineAt: Date.now(),
      flows: { playsUntil: 0 },
    }),
    outbox: contactOutbox,
    holding,
    silent: options.silent ?? false,
    superseded: () => options.superseded ?? false,
  });
}

const result = (): AgentResult => ({
  reply: { ...plainReply(['The weekend course has seats left.']), confidence: 0.9 },
  model: 'mock:demo',
  usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, costUsd: 0.001 },
  interventions: [],
  latencyMs: 9_000,
  toolsOffered: true,
});

const agentRows = () =>
  db
    .select()
    .from(turns)
    .where(eq(turns.conversationId, conversationId))
    .then(rows => rows.filter(row => row.role === 'agent'));
const queued = () => db.select().from(outbox);

describe('a deferred model reply (specs/012)', () => {
  it('is recorded as deferred and queued with the actions it staged', async () => {
    const stage = new ActionStage();
    const tag = { tool: 'add_tag', id: 'interested', tag: 'interested' } as const;
    stage.stage(tag);
    await settlementFor({ stage }).settle({
      kind: 'done',
      done: { kind: 'model', result: result() },
    });
    const [row] = await agentRows();
    expect(row?.outcome).toBe('deferred');
    const [reply] = await queued();
    expect(reply?.payload).toMatchObject({
      messages: ['The weekend course has seats left.'],
      actions: [tag],
      turnId: row?.id,
    });
  });

  it('is recorded but never sent when the contact wrote past it (specs/046)', async () => {
    await settlementFor({ superseded: true }).settle({
      kind: 'done',
      done: { kind: 'model', result: result() },
    });
    expect((await agentRows())[0]?.outcome).toBe('superseded');
    expect(await queued()).toHaveLength(0);
  });
});

describe('a reply decided without the model', () => {
  it('keeps its own outcome and is queued', async () => {
    const reply = plainReply(['Could you type that instead?']);
    await settlementFor().settle({
      kind: 'done',
      done: { kind: 'decided', reply, outcome: 'media_fallback' },
    });
    expect((await agentRows())[0]?.outcome).toBe('media_fallback');
    expect((await queued())[0]?.payload).toMatchObject({ messages: reply.messages });
  });
});

describe('a deferred call that failed (specs/030)', () => {
  it('sends the holding line a silent response held back', async () => {
    await settlementFor({ silent: true }).settle({ kind: 'error', error: new Error('aborted') });
    expect((await queued())[0]?.payload).toMatchObject({ messages: ['One moment.'] });
    // Nothing reached the contact but that line: no flow, so no row to record.
    expect(await agentRows()).toHaveLength(0);
  });

  it('sends nothing more when the response already carried the holding line', async () => {
    await settlementFor().settle({ kind: 'error', error: new Error('aborted') });
    expect(await queued()).toHaveLength(0);
  });
});

describe('a deferred reply that cannot be queued (C6)', () => {
  const missing = '00000000-0000-4000-8000-000000000009';

  it('is handed to a person when the response was silent', async () => {
    await settlementFor({ silent: true, turnConversation: missing }).settle({
      kind: 'done',
      done: { kind: 'model', result: result() },
    });
    const [handoff] = await queued();
    expect(handoff?.payload).toMatchObject({ messages: ['Passing you to a person.'] });
    expect(handoff?.conversationId).toBe(conversationId);
    expect((await store.find('demo', 's1'))?.escalatedAt).not.toBeNull();
  });

  it('is only logged when the contact already has the holding line', async () => {
    await settlementFor({ turnConversation: missing }).settle({
      kind: 'done',
      done: { kind: 'model', result: result() },
    });
    expect(await queued()).toHaveLength(0);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(String) }),
      'failed to enqueue deferred reply',
    );
  });
});
