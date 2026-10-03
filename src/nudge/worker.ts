import type { Database } from '../db/client.ts';
import type { AgentResult, AgentRunner } from '../agent/runner.ts';
import type { TenantConfig } from '../config/loader.ts';
import type { ContactReader } from '../channels/manychat/client.ts';
import { LINK_SENT, MAX_NUDGE_MINUTES, NO_TOOLS } from '../contracts/config.ts';
import { ActionStage, contactActionsFrom } from '../agent/tools.ts';
import { BudgetGuard, checkTurnCap } from '../conversation/budget.ts';
import { ConversationStore } from '../conversation/store.ts';
import { OutboxQueue } from '../outbox/queue.ts';
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

const MINUTE_MS = 60_000;

/**
 * No race to protect here, unlike `get_contact`'s 1500 ms (specs/024): the
 * client's own 10-second bound, so a slow read is not mistaken for a failure.
 */
const TAG_READ_TIMEOUT_MS = 10_000;
const DAY_MS = 86_400_000;

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
    const log = (fields: object) => ({ conversation: conversation.id, ...fields });
    const cancel = async (reason: CancelReason): Promise<NudgeResult> => {
      await this.nudges.cancelClaimed(nudge.id, reason);
      this.opts.logger.info(log({ reason }), 'nudge cancelled');
      return reason;
    };

    // Cheapest first; the ManyChat read last, just before the turn.
    if (conversation.escalatedAt && conversation.escalatedAt >= nudge.scheduledAt) {
      return cancel('escalated');
    }
    const historySince = new Date(now.getTime() - rules.historyDays * DAY_MS);
    const contact = {
      ...contactActionsFrom(await this.store.actionHistory(conversation.id), tools, historySince),
      // No request to carry one, so the course the conversation keeps (specs/028).
      course: conversation.course ?? undefined,
    };
    if (contact.funnelStage === LINK_SENT) return cancel('link_sent');

    const lastInbound = await this.store.lastInbound(conversation.id);
    if (!lastInbound || now.getTime() > lastInbound.getTime() + MAX_NUDGE_MINUTES * MINUTE_MS) {
      return cancel('window_closing');
    }

    // A cap never escalates a nudge: the contact asked nothing, so there is
    // nothing to hand off.
    const turnCap = checkTurnCap(conversation.turnCount + 1, rules);
    const budget = await this.budget.checkBudget(conversation.tenantId, rules, now);
    if (!turnCap.allowed || !budget.allowed) return cancel('cap_reached');

    const humanActiveTag = tools.nudge?.humanActiveTag;
    if (humanActiveTag) {
      let tags: string[];
      try {
        const record = await this.opts.contacts.readContact(
          conversation.subscriberId,
          AbortSignal.timeout(TAG_READ_TIMEOUT_MS),
        );
        tags = record.tags;
      } catch (error) {
        // An unprompted message on top of a person's conversation is worse
        // than a missed follow-up (C6).
        this.opts.logger.warn(
          log({ err: error instanceof Error ? error.name : 'unknown' }),
          'nudge tag read failed',
        );
        return cancel('read_failed');
      }
      if (tags.includes(humanActiveTag)) return cancel('human_active');
    }

    // Last, because it counts the turn against the contact's hourly limit.
    const rate = await this.budget.checkRateLimit(
      conversation.tenantId,
      conversation.subscriberId,
      rules,
      now,
    );
    if (!rate.allowed) return cancel('cap_reached');
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
      });
    } catch (error) {
      this.opts.logger.error(log({ err: String(error) }), 'nudge model call failed');
      await this.nudges.finish(nudge.id, 'skipped');
      return 'skipped';
    } finally {
      clearTimeout(abortTimer);
    }

    const tokens = (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0);
    await this.budget.recordSpend(conversation.tenantId, tokens, result.usage.costUsd, now);

    // The contact may have written while the model ran; their own turn
    // answers them, and a follow-up on top of it would talk over it.
    const latest = await this.store.lastInbound(conversation.id);
    if (latest && latest > lastInbound) return cancel('contact_replied');

    const usage = {
      model: result.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadTokens,
      costUsd: result.usage.costUsd,
      latencyMs: result.latencyMs,
    };

    // Escalating is how the model declines. The contact asked nothing, so
    // nothing is sent, no person is notified, and what it staged is dropped.
    if (result.reply.escalate) {
      await this.store.recordAgentReply(
        conversation.id,
        result.reply.messages.join('\n'),
        'nudge_skipped',
        {
          bound: true,
          usage,
          actions: result.toolsOffered ? stage.records('discarded') : null,
        },
      );
      await this.nudges.finish(nudge.id, 'skipped');
      this.opts.logger.info(
        log({ outcome: 'nudge_skipped', interventions: result.interventions }),
        'nudge skipped',
      );
      return 'skipped';
    }

    const turnId = await this.store.recordAgentReply(
      conversation.id,
      result.reply.messages.join('\n'),
      'nudge_sent',
      { bound: true, usage, actions: result.toolsOffered ? stage.records('staged') : null },
    );
    // No race and nobody waiting on a Dynamic Block: the reply goes straight
    // to the deferred path, and its actions follow its text (specs/012).
    await this.queue.enqueue({
      tenantId: conversation.tenantId,
      subscriberId: conversation.subscriberId,
      conversationId: conversation.id,
      reply: result.reply,
      actions: { staged: stage.staged, turnId },
    });
    await this.nudges.finish(nudge.id, 'sent');
    this.opts.logger.info(log({ outcome: 'nudge_sent' }), 'nudge sent');
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
