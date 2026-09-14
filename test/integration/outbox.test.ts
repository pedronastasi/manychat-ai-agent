import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDatabase } from '../helpers/db.ts';
import type { Database } from '../../src/db/client.ts';
import {
  enqueueReply,
  claimBatch,
  markDelivered,
  markFailed,
  MAX_ATTEMPTS,
} from '../../src/outbox/queue.ts';
import { drainOnce, startWorker } from '../../src/outbox/worker.ts';
import { ManyChatApiError } from '../../src/channels/manychat/client.ts';
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

const reply = (text = 'la respuesta'): AgentReply => ({
  messages: [text],
  escalate: false,
  escalation_reason: null,
  confidence: 0.9,
});

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

const enqueue = (subscriberId = 's1', text?: string) =>
  enqueueReply(db, { tenantId: 'demo', subscriberId, conversationId: null, reply: reply(text) });

const rowById = async (id: string) => {
  const r: unknown = await db.execute(
    sql`SELECT id, status, attempts, last_error, delivered_at, next_attempt_at FROM outbox WHERE id = ${id}`,
  );
  const rows = Array.isArray(r) ? r : ((r as { rows: unknown[] }).rows ?? []);
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
  };
}

describe('claiming', () => {
  it('claims a due row and increments its attempt count', async () => {
    const id = await enqueue();
    const claimed = await claimBatch(db, 10);
    expect(claimed.map(c => c.id)).toEqual([id]);
    expect(claimed[0]!.attempts).toBe(1);
    expect((await rowById(id)).status).toBe('delivering');
  });

  it('does not claim a row scheduled for the future', async () => {
    const id = await enqueue();
    await db.execute(
      sql`UPDATE outbox SET next_attempt_at = now() + interval '1 hour' WHERE id = ${id}`,
    );
    expect(await claimBatch(db, 10)).toHaveLength(0);
  });

  it('does not re-claim a row already being delivered', async () => {
    await enqueue();
    expect(await claimBatch(db, 10)).toHaveLength(1);
    expect(await claimBatch(db, 10)).toHaveLength(0);
  });

  it('respects the batch limit', async () => {
    for (let i = 0; i < 5; i++) await enqueue(`s${i}`);
    expect(await claimBatch(db, 2)).toHaveLength(2);
  });

  it('never hands the same row to two concurrent workers', async () => {
    // The guarantee FOR UPDATE SKIP LOCKED exists to provide. Without it a
    // contact receives the same reply twice.
    for (let i = 0; i < 6; i++) await enqueue(`s${i}`);
    const [a, b, c] = await Promise.all([
      claimBatch(db, 10),
      claimBatch(db, 10),
      claimBatch(db, 10),
    ]);
    const ids = [...a, ...b, ...c].map(r => r.id);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
  });
});

describe('outcomes', () => {
  it('marks a delivered row and stamps delivered_at', async () => {
    const id = await enqueue();
    await claimBatch(db, 10);
    await markDelivered(db, id);
    const row = await rowById(id);
    expect(row.status).toBe('delivered');
    expect(row.delivered_at).not.toBeNull();
  });

  it('reschedules a retryable failure into the future, still claimable', async () => {
    const id = await enqueue();
    const [claimed] = await claimBatch(db, 10);
    const before = (await rowById(id)).next_attempt_at;

    const outcome = await markFailed(db, id, claimed!.attempts, 'boom', true);

    expect(outcome).toBe('retrying');
    const row = await rowById(id);
    expect(row.status).toBe('pending');
    expect(row.last_error).toBe('boom');
    // Backoff must actually move the row forward, or the worker hot-loops on it.
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(new Date(before).getTime());
    expect(await claimBatch(db, 10)).toHaveLength(0);
  });

  it('backs off for longer on each successive attempt', async () => {
    const id = await enqueue();
    const at = async (attempts: number) => {
      await markFailed(db, id, attempts, 'x', true);
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
    await claimBatch(db, 10);
    const outcome = await markFailed(db, id, 1, 'HTTP 400', false);
    expect(outcome).toBe('dead-lettered');
    expect((await rowById(id)).status).toBe('failed');
  });

  it('dead-letters once attempts are exhausted', async () => {
    const id = await enqueue();
    expect(await markFailed(db, id, MAX_ATTEMPTS - 1, 'x', true)).toBe('retrying');
    expect(await markFailed(db, id, MAX_ATTEMPTS, 'x', true)).toBe('dead-lettered');
    expect((await rowById(id)).status).toBe('failed');
  });
});

describe('drainOnce', () => {
  it('delivers a pending reply and reports it', async () => {
    await enqueue('sub-9', 'hola!');
    const client = stubClient();
    const result = await drainOnce({ db, client, logger: silentLogger });

    expect(result).toMatchObject({ claimed: 1, delivered: 1, retrying: 0, deadLettered: 0 });
    expect(client.sent).toEqual([{ subscriberId: 'sub-9', messages: ['hola!'] }]);
  });

  it('is a no-op when the queue is empty', async () => {
    const result = await drainOnce({ db, client: stubClient(), logger: silentLogger });
    expect(result.claimed).toBe(0);
  });

  it('retries a 5xx and dead-letters a 4xx', async () => {
    await enqueue('retry-me');
    await enqueue('give-up');
    const client: ManyChatClient = {
      sendText: subscriberId =>
        Promise.reject(
          subscriberId === 'retry-me'
            ? new ManyChatApiError(503, 'unavailable', true)
            : new ManyChatApiError(400, 'bad request', false),
        ),
    };

    const result = await drainOnce({ db, client, logger: silentLogger });
    expect(result).toMatchObject({ claimed: 2, delivered: 0, retrying: 1, deadLettered: 1 });
  });

  it('treats an unknown error as retryable rather than discarding the reply', async () => {
    await enqueue();
    const client: ManyChatClient = { sendText: () => Promise.reject(new Error('socket hang up')) };
    const result = await drainOnce({ db, client, logger: silentLogger });
    expect(result.retrying).toBe(1);
    expect(result.deadLettered).toBe(0);
  });

  it('logs dead letters at error level, since a contact got nothing', async () => {
    await enqueue();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const client: ManyChatClient = {
      sendText: () => Promise.reject(new ManyChatApiError(401, 'unauthorized', false)),
    };
    await drainOnce({ db, client, logger });
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('keeps delivering the rest of the batch when one row fails', async () => {
    await enqueue('bad');
    await enqueue('good');
    const client = stubClient(subscriberId => {
      if (subscriberId === 'bad') throw new ManyChatApiError(400, 'nope', false);
    });
    const result = await drainOnce({ db, client, logger: silentLogger });
    expect(result.delivered).toBe(1);
    expect(result.deadLettered).toBe(1);
    expect(client.sent.map(s => s.subscriberId)).toEqual(['good']);
  });
});

describe('startWorker', () => {
  it('drains the queue while running and stops cleanly', async () => {
    await enqueue('polled');
    const client = stubClient();
    const stop = startWorker({ db, client, logger: silentLogger, pollIntervalMs: 10 });

    await vi.waitFor(() => expect(client.sent).toHaveLength(1), { timeout: 3000 });
    await stop();

    const before = client.sent.length;
    await enqueue('after-stop');
    await new Promise(r => setTimeout(r, 100));
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
        return (db.execute as (...a: unknown[]) => unknown)(...args);
      },
    } as unknown as Database;

    const stop = startWorker({ db: flaky, client: stubClient(), logger, pollIntervalMs: 10 });
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalled(), { timeout: 3000 });

    await enqueue('after-error');
    await vi.waitFor(() => expect(calls).toBeGreaterThan(2), { timeout: 3000 });
    await stop();
  });
});
