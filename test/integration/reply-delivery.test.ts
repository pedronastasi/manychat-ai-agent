import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDatabase } from '../helpers/db.ts';
import type { Database } from '../../src/db/client.ts';
import { outbox } from '../../src/db/schema.ts';
import { ConversationStore } from '../../src/conversation/store.ts';
import { NudgeStore } from '../../src/nudge/store.ts';
import { OutboxQueue } from '../../src/outbox/queue.ts';
import { RulesSchema } from '../../src/contracts/config.ts';
import { ContactOutbox, ReplyDelivery } from '../../src/turn/delivery.ts';
import type { DeliveredTurn } from '../../src/turn/delivery.ts';
import type { TurnResult } from '../../src/turn/result.ts';
import { plainReply } from '../../src/turn/replies.ts';

/**
 * ReplyDelivery decides whether a turn's reply goes back inline or through
 * the outbox, and when. specs/030 § The reply waits for the flow to play;
 * specs/037 § A reply never overtakes an earlier one; C6: a silent response
 * that fails is handed to a person through the outbox. Every value is
 * invented.
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

const outboxOf = () =>
  new ContactOutbox(
    { queue: new OutboxQueue(db), store, nudges: new NudgeStore(db), rules, logger },
    { tenantId: 'demo', subscriberId: 's1' },
  );

const deliveryFor = (turn: Partial<DeliveredTurn> = {}) =>
  new ReplyDelivery(outboxOf(), {
    conversationId,
    logger,
    late: false,
    deadlineAt: Date.now() + 1_000,
    flows: { playsUntil: 0 },
    ...turn,
  });

const result = (): TurnResult => ({
  reply: plainReply(['The evening course runs on Tuesdays.']),
  outcome: 'answered_inline',
  conversationId,
  binding: 'bound',
});

const queued = () => db.select().from(outbox);

describe('a settled reply (specs/030)', () => {
  it('goes back inline, untouched, when no flow is playing and nothing is queued', async () => {
    const delivered = await deliveryFor().deliver(result());
    expect(delivered).toEqual(result());
    expect(await queued()).toHaveLength(0);
  });

  it('is held inline until a flow that ends before the deadline has played', async () => {
    const until = Date.now() + 60;
    const delivered = await deliveryFor({ flows: { playsUntil: until } }).deliver(result());
    // A few ms of slack: the timer and Date.now() read different clocks.
    expect(Date.now()).toBeGreaterThanOrEqual(until - 5);
    expect(delivered.silent).toBeUndefined();
    expect(await queued()).toHaveLength(0);
  });

  it('goes to the outbox, with its actions, behind a flow that plays past the deadline', async () => {
    const until = Date.now() + 5_000;
    const staged = [{ tool: 'add_tag', id: 'interested', tag: 'interested' } as const];
    const delivered = await deliveryFor({
      deadlineAt: Date.now() + 100,
      flows: { playsUntil: until },
    }).deliver(result(), { staged, turnId: '00000000-0000-4000-8000-000000000001' });
    expect(delivered.silent).toBe(true);
    const [row] = await queued();
    expect(row?.nextAttemptAt.getTime()).toBe(until);
    expect(row?.payload).toMatchObject({ actions: staged });
  });
});

describe('a reply behind a queued one (specs/037)', () => {
  it('is queued behind it, with a silent response', async () => {
    await outboxOf().enqueue({ conversationId, reply: plainReply(['An earlier reply.']) });
    const delivery = deliveryFor();
    expect(await delivery.mustQueue()).toBe(true);
    expect(await delivery.silentNow()).toBe(true);
    expect((await delivery.deliver(result())).silent).toBe(true);
    expect(await queued()).toHaveLength(2);
  });

  it('goes to the outbox on a late turn, whose response is gone, even when decided', async () => {
    const answered = await deliveryFor({ late: true }).answer(result());
    expect(answered.silent).toBe(true);
    expect(await queued()).toHaveLength(1);
  });

  it('goes back inline when decided and nothing is ahead of it', async () => {
    expect(await deliveryFor().answer(result())).toEqual(result());
    expect(await queued()).toHaveLength(0);
  });
});

describe('a reply completing after the race (specs/030)', () => {
  it('waits for the flow still playing', async () => {
    const until = Date.now() + 5_000;
    const delivery = deliveryFor({ flows: { playsUntil: until } });
    expect(await delivery.silentNow()).toBe(true);
    await delivery.queue(result().reply);
    const [row] = await queued();
    expect(row?.nextAttemptAt.getTime()).toBe(until);
  });

  it('goes out at once when no flow is playing', async () => {
    const delivery = deliveryFor();
    expect(delivery.notBefore()).toBeUndefined();
    expect(await delivery.silentNow()).toBe(false);
  });
});

describe('a failed silent turn (C6)', () => {
  it('queues the handoff and records the escalation', async () => {
    await outboxOf().handOffSilent();
    const [row] = await queued();
    expect(row?.payload).toMatchObject({ messages: ['Passing you to a person.'] });
    expect(row?.conversationId).toBe(conversationId);
    expect((await store.find('demo', 's1'))?.escalatedAt).not.toBeNull();
  });
});
