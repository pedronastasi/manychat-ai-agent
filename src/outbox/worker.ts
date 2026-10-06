import type { Database } from '../db/client.ts';
import type { ManyChatClient } from '../channels/manychat/client.ts';
import { ManyChatApiError, ManyChatError } from '../channels/manychat/client.ts';
import { OutboxQueue } from './queue.ts';
import type { OutboxRow } from './queue.ts';
import { ContactTokens } from '../conversation/tokens.ts';
import { ConversationStore } from '../conversation/store.ts';
import { performActions, performedCourse } from '../conversation/actions.ts';
import { recordOf } from '../agent/tools.ts';
import { NudgeStore } from '../nudge/store.ts';
import { NudgingPerformer } from '../nudge/performer.ts';

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
  /** Claimed, then handed back unattempted because the worker is stopping. */
  released: number;
}

export class OutboxWorker {
  private readonly opts: WorkerOptions;
  private readonly queue: OutboxQueue;
  private readonly tokens: ContactTokens;
  private readonly store: ConversationStore;
  private readonly nudges: NudgeStore;
  private running = false;
  /**
   * Set by the stop function. A contact's rows after the one being sent go
   * back to the queue, so a stop waits for one reply per contact, not a
   * contact's whole paced chain (specs/002 § Messages to one contact are paced).
   */
  private stopping = false;
  private settled: Promise<void> = Promise.resolve();

  constructor(opts: WorkerOptions) {
    this.opts = opts;
    this.queue = new OutboxQueue(opts.db);
    this.tokens = new ContactTokens(opts.db, opts.client);
    this.store = new ConversationStore(opts.db);
    this.nudges = new NudgeStore(opts.db);
  }

  /**
   * The actions deferred with a reply, performed once, after its first
   * successful delivery (specs/012 § A failed action is logged, never
   * retried). The row is already marked delivered, so a crash here loses the
   * actions rather than sending the text again.
   */
  private async performDeferred(row: Extract<OutboxRow, { kind: 'reply' }>): Promise<void> {
    const { actions, turnId } = row.payload;
    if (!actions || actions.length === 0) return;
    try {
      const performer = row.conversationId
        ? new NudgingPerformer(this.opts.client, this.nudges, row.conversationId)
        : this.opts.client;
      const outcomes = await performActions(performer, row.subscriberId, actions, this.opts.logger);
      if (turnId) await this.store.resolveStaged(turnId, outcomes);
      // The contact's course follows a write to it that ManyChat accepted (specs/028).
      const course = performedCourse(actions, outcomes);
      if (course !== undefined && row.conversationId) {
        await this.store.setCourse(row.conversationId, course);
      }
    } catch (error) {
      this.opts.logger.error(
        { outboxId: row.id, err: error instanceof Error ? error.message : String(error) },
        'deferred actions not recorded',
      );
    }
  }

  /** Media without the reply that introduces it is worse than neither. */
  private async dropDeferred(row: OutboxRow): Promise<void> {
    if (row.kind !== 'reply' || !row.payload.actions || !row.payload.turnId) return;
    try {
      await this.store.resolveStaged(
        row.payload.turnId,
        row.payload.actions.map(action => [recordOf(action, 'dead_lettered')]),
      );
    } catch (error) {
      this.opts.logger.error(
        { outboxId: row.id, err: error instanceof Error ? error.message : String(error) },
        'dropped actions not recorded',
      );
    }
  }

  private async deliver(row: OutboxRow): Promise<void> {
    if (row.kind === 'reply') {
      await this.opts.client.sendText(row.subscriberId, row.payload.messages);
      return;
    }
    // The token that failed to land was never stored, so a fresh one replaces
    // it. Null means a newer token was issued since, with a write of its own.
    const token = row.conversationId
      ? await this.tokens.replaceUnwritten(row.conversationId, row.payload.generation)
      : null;
    if (token) await this.opts.client.writeToken(row.subscriberId, token);
  }

  /**
   * Processes one batch. Separated from the loop so tests can drive it directly
   * and so a deployment can run a single drain as a one-shot job.
   */
  async drainOnce(): Promise<DrainResult> {
    const rows = await this.queue.claimBatch(this.opts.batchSize ?? 10);
    const result: DrainResult = {
      claimed: rows.length,
      delivered: 0,
      retrying: 0,
      deadLettered: 0,
      released: 0,
    };

    // One contact's rows in the order claimed, so their replies arrive in
    // order; different contacts at once, so one contact's paced reply does not
    // hold up everyone else's (specs/002 § Messages to one contact are paced).
    const byContact = new Map<string, OutboxRow[]>();
    for (const row of rows) {
      byContact.set(row.subscriberId, [...(byContact.get(row.subscriberId) ?? []), row]);
    }
    const contacts = await Promise.allSettled(
      [...byContact.values()].map(async contactRows => {
        for (const [index, row] of contactRows.entries()) {
          if (this.stopping) {
            const rest = contactRows.slice(index).map(unsent => unsent.id);
            await this.queue.release(rest);
            result.released += rest.length;
            return;
          }
          const outcome = await this.process(row, result);
          // A reply going back for a retry holds the contact's later rows
          // back with it, so none of them overtakes it (specs/037).
          if (outcome === 'retrying' && row.kind === 'reply') {
            const rest = contactRows.slice(index + 1).map(unsent => unsent.id);
            await this.queue.release(rest);
            result.released += rest.length;
            return;
          }
        }
      }),
    );
    // Every contact's chain has settled, finished or handed back, before a
    // failure is reported, so no row is left delivering when a stop returns.
    const failed = contacts.find(contact => contact.status === 'rejected');
    if (failed) throw failed.reason;
    return result;
  }

  private async process(
    row: OutboxRow,
    result: DrainResult,
  ): Promise<'delivered' | 'retrying' | 'dead-lettered'> {
    const { logger } = this.opts;
    try {
      await this.deliver(row);
      await this.queue.markDelivered(row.id);
      result.delivered++;
      if (row.kind === 'reply') await this.performDeferred(row);
      return 'delivered';
    } catch (error) {
      // ManyChat's own verdict when it is ManyChat's error, and a retry
      // otherwise: an unknown failure, such as the database, must not
      // discard a reply (specs/022 § Retries follow the SDK's retryable).
      const retryable = error instanceof ManyChatError ? error.retryable : true;
      // A token write's error is kept to its status: ManyChat's answer to it
      // could quote the value it was sent (specs/019).
      const message =
        row.kind === 'contact_token'
          ? `contact token write failed${error instanceof ManyChatApiError ? `: ${error.status}` : ''}`
          : error instanceof Error
            ? error.message
            : String(error);
      const outcome = await this.queue.markFailed(row.id, row.attempts, message, retryable);
      if (outcome === 'dead-lettered') {
        result.deadLettered++;
        await this.dropDeferred(row);
        // Dead letters are the signal that a contact never got their reply.
        logger.error(
          { outboxId: row.id, kind: row.kind, attempts: row.attempts },
          'outbox dead-lettered',
        );
      } else {
        result.retrying++;
        logger.warn(
          { outboxId: row.id, kind: row.kind, attempts: row.attempts },
          'outbox delivery retrying',
        );
      }
      return outcome;
    }
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
      this.stopping = true;
      await this.settled;
    };
  }
}
