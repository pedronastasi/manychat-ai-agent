import type { Database } from '../db/client.ts';
import type { AgentResult, AgentRunner } from '../agent/runner.ts';
import type { TenantConfig } from '../config/loader.ts';
import type { ContactReader } from '../channels/manychat/client.ts';
import { NO_TOOLS } from '../contracts/config.ts';
import { ActionStage } from '../agent/tools.ts';
import { BudgetGuard } from '../conversation/budget.ts';
import { ConversationStore } from '../conversation/store.ts';
import { OutboxQueue } from '../outbox/queue.ts';
import { ContactOutbox } from '../turn/delivery.ts';
import { withConversation } from '../turn/logger.ts';
import { TurnRecorder } from '../turn/recorder.ts';
import { NudgeChecks } from './checks.ts';
import { NudgeStore } from './store.ts';
import type { CancelReason, ClaimedNudge } from './store.ts';

export interface NudgeLogger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

export interface NudgeWorkerOptions {
  db: Database;
  runner: AgentRunner;
  /** Read per nudge, so a SIGHUP reload reaches the worker as it reaches turns. */
  config: () => TenantConfig;
  /** The `human_active` check's read: the specs/024 read path (specs/025). */
  contacts: ContactReader;
  logger: NudgeLogger;
  /** The outer bound on the model call; there is no race to lose. */
  modelAbortMs: number;
  batchSize?: number;
  pollIntervalMs?: number;
}

export type NudgeResult = 'sent' | 'skipped' | CancelReason;

/**
 * Runs the follow-ups the agent scheduled, once they are due and only while
 * they are still allowed (specs/025). Every check that fails cancels the
 * nudge, recorded with its reason, before the model is called.
 */
export class NudgeWorker {
  private readonly opts: NudgeWorkerOptions;
  private readonly nudges: NudgeStore;
  private readonly store: ConversationStore;
  private readonly budget: BudgetGuard;
  private readonly queue: OutboxQueue;
  private running = false;
  private settled: Promise<void> = Promise.resolve();

  constructor(opts: NudgeWorkerOptions) {
    this.opts = opts;
    this.nudges = new NudgeStore(opts.db);
    this.store = new ConversationStore(opts.db);
    this.budget = new BudgetGuard(opts.db);
    this.queue = new OutboxQueue(opts.db);
  }

  /** Claims and runs one batch. Separated from the loop so tests can drive it. */
  async drainOnce(now = new Date()): Promise<NudgeResult[]> {
    const claimed = await this.nudges.claimDue(this.opts.batchSize ?? 10);
    const results: NudgeResult[] = [];
    for (const nudge of claimed) {
      try {
        results.push(await this.runOne(nudge, now));
      } catch (error) {
        // Nothing was sent, and nothing will be: the row is past `pending`.
        this.opts.logger.error(
          {
            conversation: nudge.conversationId,
            err: error instanceof Error ? error.message : String(error),
          },
          'nudge failed',
        );
        await this.nudges.finish(nudge.id, 'skipped');
        results.push('skipped');
      }
    }
    return results;
  }

  private async runOne(nudge: ClaimedNudge, now: Date): Promise<NudgeResult> {
    const { rules, tools = NO_TOOLS } = this.opts.config();
    const conversation = await this.store.byId(nudge.conversationId);
    if (!conversation) {
      await this.nudges.finish(nudge.id, 'skipped');
      return 'skipped';
    }
    // The conversation's random id, never the subscriber (ADR-0014).
    const logger = withConversation(this.opts.logger, conversation.id);
    const cancel = async (reason: CancelReason): Promise<NudgeResult> => {
      await this.nudges.cancelClaimed(nudge.id, reason);
      logger.info({ reason }, 'nudge cancelled');
      return reason;
    };

    const checks = new NudgeChecks({
      store: this.store,
      budget: this.budget,
      contacts: this.opts.contacts,
      rules,
      tools,
      warn: (fields, message) => this.opts.logger.warn(fields, message),
    });
    const checked = await checks.check(nudge, conversation, now);
    if ('cancel' in checked) return cancel(checked.cancel);
    const { contact, lastInbound, historySince } = checked.allowed;
    // Any channel: a contact who answered on another has answered (specs/048).
    const answeredBefore = await this.store.lastInbound(conversation.id);
    await this.store.countTurn(conversation.id);

    const history = await this.store.recentTurns(conversation.id, historySince, 10);
    const stage = new ActionStage();
    const abort = new AbortController();
    const abortTimer = setTimeout(() => abort.abort(), this.opts.modelAbortMs);
    let result: AgentResult;
    try {
      result = await this.opts.runner.run({
        text: '',
        history,
        signal: abort.signal,
        stage,
        contact,
        nudge: { since: lastInbound },
        // Its flows are the nudge channel's own (specs/049).
        channel: nudge.channel ?? undefined,
      });
    } catch (error) {
      logger.error({ err: String(error) }, 'nudge model call failed');
      await this.nudges.finish(nudge.id, 'skipped');
      return 'skipped';
    } finally {
      clearTimeout(abortTimer);
    }

    // The same recorder an inbound turn ends through (ADR-0024). A nudge is
    // always bound: it was scheduled by a bound turn of this contact.
    const recorder = new TurnRecorder(
      { store: this.store, budget: this.budget, nudges: this.nudges },
      {
        conversationId: conversation.id,
        tenantId: conversation.tenantId,
        bound: true,
        logger,
        stage,
      },
    );
    // Spent whether or not anything is sent: the call was made.
    await recorder.spend(result, now);

    // The contact may have written while the model ran; their own turn
    // answers them, and a follow-up on top of it would talk over it.
    const latest = await this.store.lastInbound(conversation.id);
    if (latest && answeredBefore && latest > answeredBefore) return cancel('contact_replied');

    // Escalating is how the model declines. The contact asked nothing, so
    // nothing is sent, no person is notified, and what it staged is dropped.
    if (result.reply.escalate) {
      await recorder.declined(result);
      await this.nudges.finish(nudge.id, 'skipped');
      logger.info(
        { outcome: 'nudge_skipped', interventions: result.interventions },
        'nudge skipped',
      );
      return 'skipped';
    }

    const turnId = await recorder.recordReply(result, 'nudge_sent');
    // No race and nobody waiting on a Dynamic Block: the reply goes straight
    // to the deferred path, and its actions follow its text (specs/012).
    const outbox = new ContactOutbox(
      {
        queue: this.queue,
        store: this.store,
        nudges: this.nudges,
        rules,
        logger,
        // On the channel it was scheduled for (specs/048).
        manychatChannel: nudge.channel ?? undefined,
      },
      { tenantId: conversation.tenantId, subscriberId: conversation.subscriberId },
    );
    await outbox.enqueue({
      conversationId: conversation.id,
      reply: result.reply,
      actions: { staged: stage.staged, turnId },
    });
    await this.nudges.finish(nudge.id, 'sent');
    logger.info({ outcome: 'nudge_sent' }, 'nudge sent');
    return 'sent';
  }

  /** Polling loop. Returns a stop function that finishes the in-flight batch. */
  start(): () => Promise<void> {
    const interval = this.opts.pollIntervalMs ?? 15_000;
    this.running = true;

    const loop = async () => {
      while (this.running) {
        try {
          this.settled = this.drainOnce().then(() => undefined);
          await this.settled;
        } catch (error) {
          // The database, not a nudge. Keep polling.
          this.opts.logger.error(
            { err: error instanceof Error ? error.message : String(error) },
            'nudge worker iteration failed',
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
