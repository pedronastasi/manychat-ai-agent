import type { Database } from '../db/client.ts';
import type { ManyChatClient } from '../channels/manychat/client.ts';
import { ManyChatApiError } from '../channels/manychat/client.ts';
import { OutboxQueue } from './queue.ts';

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

export class OutboxWorker {
  private readonly opts: WorkerOptions;
  private readonly queue: OutboxQueue;
  private running = false;
  private settled: Promise<void> = Promise.resolve();

  constructor(opts: WorkerOptions) {
    this.opts = opts;
    this.queue = new OutboxQueue(opts.db);
  }

  /**
   * Processes one batch. Separated from the loop so tests can drive it directly
   * and so a deployment can run a single drain as a one-shot job.
   */
  async drainOnce(): Promise<DrainResult> {
    const { client, logger } = this.opts;
    const rows = await this.queue.claimBatch(this.opts.batchSize ?? 10);
    const result: DrainResult = {
      claimed: rows.length,
      delivered: 0,
      retrying: 0,
      deadLettered: 0,
    };

    for (const row of rows) {
      try {
        await client.sendText(row.subscriberId, row.payload.messages);
        await this.queue.markDelivered(row.id);
        result.delivered++;
      } catch (error) {
        const retryable = error instanceof ManyChatApiError ? error.retryable : true;
        const message = error instanceof Error ? error.message : String(error);
        const outcome = await this.queue.markFailed(row.id, row.attempts, message, retryable);
        if (outcome === 'dead-lettered') {
          result.deadLettered++;
          // Dead letters are the signal that a contact never got their reply.
          logger.error({ outboxId: row.id, attempts: row.attempts }, 'outbox dead-lettered');
        } else {
          result.retrying++;
          logger.warn({ outboxId: row.id, attempts: row.attempts }, 'outbox delivery retrying');
        }
      }
    }
    return result;
  }

  /** Polling loop. Returns a stop function that finishes the in-flight batch. */
  start(): () => Promise<void> {
    const interval = this.opts.pollIntervalMs ?? 1000;
    this.running = true;

    const loop = async () => {
      while (this.running) {
        try {
          this.settled = this.drainOnce().then(batch => {
            if (batch.claimed > 0) this.opts.logger.info({ ...batch }, 'outbox batch processed');
          });
          await this.settled;
        } catch (error) {
          // A failure here is the database, not a delivery. Keep polling: the
          // alternative is a silently dead worker and undelivered replies.
          this.opts.logger.error(
            { err: error instanceof Error ? error.message : String(error) },
            'outbox worker iteration failed',
          );
        }
        await new Promise(resolve => setTimeout(resolve, interval));
      }
    };

    void loop();

    return async () => {
      this.running = false;
      await this.settled;
    };
  }
}
