import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDatabase } from '../helpers/db.ts';
import type { Database } from '../../src/db/client.ts';
import { outbox } from '../../src/db/schema.ts';
import { OutboxQueue, MAX_ATTEMPTS } from '../../src/outbox/queue.ts';
import { OutboxWorker } from '../../src/outbox/worker.ts';
import { manychatError } from '../helpers/manychat.ts';
import type { ManyChatClient } from '../../src/channels/manychat/client.ts';
import type { AgentReply } from '../../src/contracts/agent.ts';

/**
 * specs/004-testing.md P0.
 *
 * This is the code deciding whether a contact who was told "dame un segundo"
 * ever receives an answer. Every case here is a way that silently fails.
 */

let db: Database;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
});
afterEach(async () => {
  await close();
});

const reply = (text = 'the reply'): AgentReply => ({
  messages: [text],
  escalate: false,
  escalation_reason: null,
  confidence: 0.9,
  closing_question: null,
});

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

const enqueue = (subscriberId = 's1', text?: string) =>
  new OutboxQueue(db).enqueue({
    tenantId: 'demo',
    subscriberId,
    conversationId: null,
    reply: reply(text),
  });

const rowById = async (id: string) => {
  const raw: unknown = await db.execute(
    sql`SELECT id, status, attempts, last_error, delivered_at, next_attempt_at FROM outbox WHERE id = ${id}`,
  );
  const rows = Array.isArray(raw) ? raw : ((raw as { rows: unknown[] }).rows ?? []);
  return rows[0] as {
    status: string;
    attempts: number;
    last_error: string | null;
    delivered_at: Date | null;
    next_attempt_at: Date;
  };
};

/** A client that records what it was asked to send and can be told to fail. */
function stubClient(behaviour: (subscriberId: string) => void = () => {}): ManyChatClient & {
  sent: { subscriberId: string; messages: string[] }[];
} {
  const sent: { subscriberId: string; messages: string[] }[] = [];
  return {
    sent,
    sendText: (subscriberId, messages) => {
      behaviour(subscriberId);
      sent.push({ subscriberId, messages });
      return Promise.resolve();
    },
    writeToken: () => Promise.resolve(),
    performAction: () => Promise.resolve(),
  };
}

describe('claiming', () => {
  it('claims a due row and increments its attempt count', async () => {
    const id = await enqueue();
    const claimed = await new OutboxQueue(db).claimBatch(10);
    expect(claimed.map(claim => claim.id)).toEqual([id]);
    expect(claimed[0]!.attempts).toBe(1);
    expect((await rowById(id)).status).toBe('delivering');
  });

  it('does not claim a row scheduled for the future', async () => {
    const id = await enqueue();
    await db.execute(
      sql`UPDATE outbox SET next_attempt_at = now() + interval '1 hour' WHERE id = ${id}`,
    );
    expect(await new OutboxQueue(db).claimBatch(10)).toHaveLength(0);
  });

  it('does not re-claim a row already being delivered', async () => {
    await enqueue();
    expect(await new OutboxQueue(db).claimBatch(10)).toHaveLength(1);
    expect(await new OutboxQueue(db).claimBatch(10)).toHaveLength(0);
  });

  it('respects the batch limit', async () => {
    for (let index = 0; index < 5; index++) await enqueue(`s${index}`);
    expect(await new OutboxQueue(db).claimBatch(2)).toHaveLength(2);
  });

  it('never hands the same row to two concurrent workers', async () => {
    // The guarantee FOR UPDATE SKIP LOCKED exists to provide. Without it a
    // contact receives the same reply twice.
    for (let index = 0; index < 6; index++) await enqueue(`s${index}`);
    const [first, second, third] = await Promise.all([
      new OutboxQueue(db).claimBatch(10),
      new OutboxQueue(db).claimBatch(10),
      new OutboxQueue(db).claimBatch(10),
    ]);
    const ids = [...first, ...second, ...third].map(row => row.id);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
  });
});

describe('outcomes', () => {
  it('marks a delivered row and stamps delivered_at', async () => {
    const id = await enqueue();
    await new OutboxQueue(db).claimBatch(10);
    await new OutboxQueue(db).markDelivered(id);
    const row = await rowById(id);
    expect(row.status).toBe('delivered');
    expect(row.delivered_at).not.toBeNull();
  });

  it('reschedules a retryable failure into the future, still claimable', async () => {
    const id = await enqueue();
    const [claimed] = await new OutboxQueue(db).claimBatch(10);
    const before = (await rowById(id)).next_attempt_at;

    const outcome = await new OutboxQueue(db).markFailed(id, claimed!.attempts, 'boom', true);

    expect(outcome).toBe('retrying');
    const row = await rowById(id);
    expect(row.status).toBe('pending');
    expect(row.last_error).toBe('boom');
    // Backoff must actually move the row forward, or the worker hot-loops on it.
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(new Date(before).getTime());
    expect(await new OutboxQueue(db).claimBatch(10)).toHaveLength(0);
  });

  it('backs off for longer on each successive attempt', async () => {
    const id = await enqueue();
    const at = async (attempts: number) => {
      await new OutboxQueue(db).markFailed(id, attempts, 'x', true);
      const row = await rowById(id);
      return new Date(row.next_attempt_at).getTime() - Date.now();
    };
    const first = await at(1);
    const later = await at(4);
    expect(later).toBeGreaterThan(first);
  });

  it('dead-letters a non-retryable failure on the FIRST attempt', async () => {
    // A malformed request will never succeed; retrying it five times only
    // delays the alert that a contact got nothing.
    const id = await enqueue();
    await new OutboxQueue(db).claimBatch(10);
    const outcome = await new OutboxQueue(db).markFailed(id, 1, 'HTTP 400', false);
    expect(outcome).toBe('dead-lettered');
    expect((await rowById(id)).status).toBe('failed');
  });

  it('dead-letters once attempts are exhausted', async () => {
    const id = await enqueue();
    expect(await new OutboxQueue(db).markFailed(id, MAX_ATTEMPTS - 1, 'x', true)).toBe('retrying');
    expect(await new OutboxQueue(db).markFailed(id, MAX_ATTEMPTS, 'x', true)).toBe('dead-lettered');
    expect((await rowById(id)).status).toBe('failed');
  });
});

describe('drainOnce', () => {
  it('delivers a pending reply and reports it', async () => {
    await enqueue('sub-9', 'hi!');
    const client = stubClient();
    const result = await new OutboxWorker({ db, client, logger: silentLogger }).drainOnce();

    expect(result).toMatchObject({ claimed: 1, delivered: 1, retrying: 0, deadLettered: 0 });
    expect(client.sent).toEqual([{ subscriberId: 'sub-9', messages: ['hi!'] }]);
  });

  it('is a no-op when the queue is empty', async () => {
    const result = await new OutboxWorker({
      db,
      client: stubClient(),
      logger: silentLogger,
    }).drainOnce();
    expect(result.claimed).toBe(0);
  });

  it('retries a 5xx and dead-letters a 4xx', async () => {
    await enqueue('retry-me');
    await enqueue('give-up');
    const client: ManyChatClient = {
      sendText: subscriberId =>
        Promise.reject(
          subscriberId === 'retry-me'
            ? manychatError(503, 'unavailable')
            : manychatError(400, 'bad request'),
        ),
      writeToken: () => Promise.resolve(),
      performAction: () => Promise.resolve(),
    };

    const result = await new OutboxWorker({ db, client, logger: silentLogger }).drainOnce();
    expect(result).toMatchObject({ claimed: 2, delivered: 0, retrying: 1, deadLettered: 1 });
  });

  it('treats an unknown error as retryable rather than discarding the reply', async () => {
    await enqueue();
    const client: ManyChatClient = {
      sendText: () => Promise.reject(new Error('socket hang up')),
      writeToken: () => Promise.resolve(),
      performAction: () => Promise.resolve(),
    };
    const result = await new OutboxWorker({ db, client, logger: silentLogger }).drainOnce();
    expect(result.retrying).toBe(1);
    expect(result.deadLettered).toBe(0);
  });

  it('logs dead letters at error level, since a contact got nothing', async () => {
    await enqueue();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const client: ManyChatClient = {
      sendText: () => Promise.reject(manychatError(401, 'unauthorized')),
      writeToken: () => Promise.resolve(),
      performAction: () => Promise.resolve(),
    };
    await new OutboxWorker({ db, client, logger }).drainOnce();
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('keeps delivering the rest of the batch when one row fails', async () => {
    await enqueue('bad');
    await enqueue('good');
    const client = stubClient(subscriberId => {
      if (subscriberId === 'bad') throw manychatError(400, 'nope');
    });
    const result = await new OutboxWorker({ db, client, logger: silentLogger }).drainOnce();
    expect(result.delivered).toBe(1);
    expect(result.deadLettered).toBe(1);
    expect(client.sent.map(sent => sent.subscriberId)).toEqual(['good']);
  });
});

describe('specs/002 § Messages to one contact are paced', () => {
  it("delivers one contact's replies in the order written, and other contacts alongside", async () => {
    await enqueue('paced', 'first');
    await enqueue('other', 'for someone else');
    await enqueue('paced', 'second');

    // The paced contact's first send hangs, as a reply waiting out its gap does.
    let release!: () => void;
    const held = new Promise<void>(resolve => (release = resolve));
    const started: string[] = [];
    const client: ManyChatClient = {
      sendText: (_subscriberId, messages) => {
        started.push(messages[0]!);
        return messages[0] === 'first' ? held : Promise.resolve();
      },
      writeToken: () => Promise.resolve(),
      performAction: () => Promise.resolve(),
    };

    const drained = new OutboxWorker({ db, client, logger: silentLogger }).drainOnce();
    await vi.waitFor(() => expect(started).toContain('for someone else'));
    expect(started).not.toContain('second');

    release();
    const result = await drained;
    expect(result.delivered).toBe(3);
    expect(started.filter(text => text !== 'for someone else')).toEqual(['first', 'second']);
  });

  it("on stop, sends each contact's current reply and hands the rest back", async () => {
    const first = await enqueue('paced', 'first');
    const second = await enqueue('paced', 'second');

    let release!: () => void;
    const held = new Promise<void>(resolve => (release = resolve));
    const started: string[] = [];
    const client: ManyChatClient = {
      sendText: (_subscriberId, messages) => {
        started.push(messages[0]!);
        return messages[0] === 'first' ? held : Promise.resolve();
      },
      writeToken: () => Promise.resolve(),
      performAction: () => Promise.resolve(),
    };

    const stop = new OutboxWorker({ db, client, logger: silentLogger, pollIntervalMs: 10 }).start();
    await vi.waitFor(() => expect(started).toEqual(['first']));
    const stopped = stop();
    release();
    await stopped;

    // A paced chain would hold the stop for a gap per reply; the next worker
    // sends the rest, as if this one had never claimed it.
    expect(started).toEqual(['first']);
    expect(await rowById(first)).toMatchObject({ status: 'delivered' });
    expect(await rowById(second)).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('reads a batch back in the order its rows were written', async () => {
    const ids: string[] = [];
    for (const text of ['a', 'b', 'c', 'd', 'e']) ids.push(await enqueue('s1', text));
    const claimed = await new OutboxQueue(db).claimBatch(10);
    expect(claimed.map(row => row.id)).toEqual(ids);
  });
});

describe('specs/037 § A reply never overtakes an earlier one (V5)', () => {
  const dueAt = async (id: string) => (await rowById(id)).next_attempt_at;
  const later = new Date(Date.now() + 60_000);
  const queue = () => new OutboxQueue(db);
  const held = () =>
    queue().enqueue({
      tenantId: 'demo',
      subscriberId: 's1',
      conversationId: null,
      reply: reply('held for a flow'),
      notBefore: later,
    });

  it('is due no earlier than a reply already queued for the contact', async () => {
    await held();
    const next = await enqueue('s1', 'the next reply');
    expect(new Date(await dueAt(next)).getTime()).toBe(later.getTime());
    expect(await queue().hasQueuedReply('demo', 's1')).toBe(true);
  });

  it('is held back by nothing delivered, failed, or for another contact', async () => {
    const delivered = await held();
    await queue().markDelivered(delivered);
    const failed = await held();
    await queue().markFailed(failed, MAX_ATTEMPTS, 'gone', false);
    await enqueue('s2', 'for someone else');
    await db.insert(outbox).values({
      tenantId: 'demo',
      subscriberId: 's1',
      conversationId: null,
      kind: 'contact_token',
      payload: { generation: 1 },
      nextAttemptAt: later,
    });

    const next = await enqueue('s1', 'the next reply');
    expect(new Date(await dueAt(next)).getTime()).toBeLessThan(later.getTime());
    expect(await queue().hasQueuedReply('demo', 's1')).toBe(true);
  });

  it("holds a contact's later reply back while an earlier one waits out a retry", async () => {
    const first = await enqueue('s1', 'first');
    const second = await enqueue('s1', 'second');
    await enqueue('s2', 'for someone else');
    const [claimed] = await queue().claimBatch(1);
    expect(claimed?.id).toBe(first);
    await queue().markFailed(first, 1, 'upstream', true);

    // Due, but behind a reply backing off: another contact's goes, it does not.
    const due = await queue().claimBatch(10);
    expect(due.map(row => row.subscriberId)).toEqual(['s2']);
    expect(await rowById(second)).toMatchObject({ status: 'pending' });
  });

  it('keeps a retried reply ahead once it comes due, however full the batch', async () => {
    const first = await enqueue('s1', 'first');
    const second = await enqueue('s1', 'second');
    await queue().claimBatch(1);
    await queue().markFailed(first, 1, 'upstream', true);
    const due = async (id: string) => new Date((await rowById(id)).next_attempt_at).getTime();
    expect(await due(second)).toBeGreaterThanOrEqual(await due(first));

    // Time passes: both are due, and the batch has room for one.
    await db.execute(sql`UPDATE outbox SET next_attempt_at = next_attempt_at - interval '1 hour'`);
    const [claimed] = await queue().claimBatch(1);
    expect(claimed?.id).toBe(first);
  });

  it("holds a contact's later reply back while an earlier one is being sent", async () => {
    await enqueue('s1', 'first');
    await queue().claimBatch(1);
    await enqueue('s1', 'second');
    expect(await queue().claimBatch(10)).toEqual([]);
  });

  it("a retried reply takes the rest of its contact's batch back with it", async () => {
    const first = await enqueue('s1', 'first');
    const second = await enqueue('s1', 'second');
    const client = stubClient();
    client.sendText = (subscriberId, messages) =>
      messages[0] === 'first'
        ? Promise.reject(manychatError(503, 'unavailable'))
        : Promise.resolve(void client.sent.push({ subscriberId, messages }));

    const result = await new OutboxWorker({ db, client, logger: silentLogger }).drainOnce();
    expect(result).toMatchObject({ retrying: 1, released: 1, delivered: 0 });
    expect(client.sent).toEqual([]);
    expect(await rowById(first)).toMatchObject({ status: 'pending', attempts: 1 });
    expect(await rowById(second)).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('finds no queued reply once the last one is delivered', async () => {
    const only = await enqueue('s1', 'only');
    expect(await queue().hasQueuedReply('demo', 's1')).toBe(true);
    await queue().markDelivered(only);
    expect(await queue().hasQueuedReply('demo', 's1')).toBe(false);
  });
});

describe('startWorker', () => {
  it('drains the queue while running and stops cleanly', async () => {
    await enqueue('polled');
    const client = stubClient();
    const stop = new OutboxWorker({ db, client, logger: silentLogger, pollIntervalMs: 10 }).start();

    await vi.waitFor(() => expect(client.sent).toHaveLength(1), { timeout: 3000 });
    await stop();

    const before = client.sent.length;
    await enqueue('after-stop');
    await new Promise(resolve => setTimeout(resolve, 100));
    // A stopped worker must stay stopped.
    expect(client.sent).toHaveLength(before);
  });

  it('survives a database failure instead of dying silently', async () => {
    // A worker that exits on one bad query leaves every later reply undelivered
    // with nothing to indicate why.
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    let calls = 0;
    const flaky = {
      ...db,
      execute: (...args: unknown[]) => {
        calls++;
        if (calls === 1) return Promise.reject(new Error('connection lost'));
        return (db.execute as (...params: unknown[]) => unknown)(...args);
      },
    } as unknown as Database;

    const stop = new OutboxWorker({
      db: flaky,
      client: stubClient(),
      logger,
      pollIntervalMs: 10,
    }).start();
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalled(), { timeout: 3000 });

    await enqueue('after-error');
    await vi.waitFor(() => expect(calls).toBeGreaterThan(2), { timeout: 3000 });
    await stop();
  });
});
