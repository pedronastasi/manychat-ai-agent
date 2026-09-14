import type { Database } from '../db/client.ts';
import type { ManyChatClient } from '../channels/manychat/client.ts';
import { ManyChatApiError } from '../channels/manychat/client.ts';
import { claimBatch, markDelivered, markFailed } from './queue.ts';

export interface WorkerLogger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

export interface WorkerOptions {
  db: Database;
  client: ManyChatClient;
  logger: WorkerLogger;
  batchSize?: number;
  pollIntervalMs?: number;
}

export interface DrainResult {
  claimed: number;
  delivered: number;
  retrying: number;
  deadLettered: number;
}

/**
 * Processes one batch. Separated from the loop so tests can drive it directly
 * and so a deployment can run a single drain as a one-shot job.
 */
export async function drainOnce(opts: WorkerOptions): Promise<DrainResult> {
  const rows = await claimBatch(opts.db, opts.batchSize ?? 10);
  const result: DrainResult = {
    claimed: rows.length,
    delivered: 0,
    retrying: 0,
    deadLettered: 0,
  };

  for (const row of rows) {
    try {
      await opts.client.sendText(row.subscriberId, row.payload.messages);
      await markDelivered(opts.db, row.id);
      result.delivered++;
    } catch (error) {
      const retryable = error instanceof ManyChatApiError ? error.retryable : true;
      const message = error instanceof Error ? error.message : String(error);
      const outcome = await markFailed(opts.db, row.id, row.attempts, message, retryable);
      if (outcome === 'dead-lettered') {
        result.deadLettered++;
        // Dead letters are the signal that a contact never got their reply.
        opts.logger.error({ outboxId: row.id, attempts: row.attempts }, 'outbox dead-lettered');
      } else {
        result.retrying++;
        opts.logger.warn({ outboxId: row.id, attempts: row.attempts }, 'outbox delivery retrying');
      }
    }
  }
  return result;
}

/** Polling loop. Returns a stop function that finishes the in-flight batch. */
export function startWorker(opts: WorkerOptions): () => Promise<void> {
  const interval = opts.pollIntervalMs ?? 1000;
  let running = true;
  let settled: Promise<void> = Promise.resolve();

  const loop = async () => {
    while (running) {
      try {
        settled = drainOnce(opts).then(r => {
          if (r.claimed > 0) opts.logger.info({ ...r }, 'outbox batch processed');
        });
        await settled;
      } catch (error) {
        // A failure here is the database, not a delivery. Keep polling: the
        // alternative is a silently dead worker and undelivered replies.
        opts.logger.error(
          { err: error instanceof Error ? error.message : String(error) },
          'outbox worker iteration failed',
        );
      }
      await new Promise(r => setTimeout(r, interval));
    }
  };

  void loop();

  return async () => {
    running = false;
    await settled;
  };
}
