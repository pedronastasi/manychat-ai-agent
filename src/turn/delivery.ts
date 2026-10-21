import { escalationReply } from '../agent/guardrails.ts';
import type { FlowSends } from '../agent/flows.ts';
import type { AgentReply, StagedAction } from '../contracts/agent.ts';
import type { Rules } from '../contracts/config.ts';
import type { ConversationStore } from '../conversation/store.ts';
import type { NudgeStore } from '../nudge/store.ts';
import type { OutboxQueue } from '../outbox/queue.ts';
import type { TurnLogger } from './logger.ts';
import type { TurnResult } from './result.ts';

/** Staged actions that go to the outbox with their reply (specs/012). */
export type DeferredActions = { staged: readonly StagedAction[]; turnId: string };

export interface ContactOutboxDeps {
  queue: OutboxQueue;
  store: ConversationStore;
  nudges: NudgeStore;
  rules: Rules;
  logger: TurnLogger;
  /** The plugin channel the turn arrived on (specs/038); ManyChat when absent. */
  channel?: string | undefined;
  /** On ManyChat, the channel the turn arrived on, whose flow delivers its reply (specs/048). */
  manychatChannel?: string | undefined;
}

/** A contact's queued replies, on the channel their turn arrived on. */
export class ContactOutbox {
  private readonly deps: ContactOutboxDeps;
  private readonly contact: { tenantId: string; subscriberId: string };

  constructor(deps: ContactOutboxDeps, contact: { tenantId: string; subscriberId: string }) {
    this.deps = deps;
    this.contact = contact;
  }

  /** Queues a reply for the turn's channel: ManyChat, or a plugin's (specs/038). */
  enqueue(input: {
    conversationId: string | null;
    reply: AgentReply;
    actions?: DeferredActions | undefined;
    notBefore?: Date | undefined;
  }): Promise<string> {
    const { channel, manychatChannel } = this.deps;
    return this.deps.queue.enqueue({ ...this.contact, ...input, channel, manychatChannel });
  }

  hasQueuedReply(): Promise<boolean> {
    return this.deps.queue.hasQueuedReply(this.contact.tenantId, this.contact.subscriberId);
  }

  /**
   * A turn that failed after a silent response, which no error handler can
   * answer any more: the handoff goes through the outbox instead, as the
   * route's error handler would have sent it (C6, specs/037).
   */
  async handOffSilent(): Promise<void> {
    const { rules, logger, store, nudges } = this.deps;
    let conversation;
    try {
      conversation = await store.find(this.contact.tenantId, this.contact.subscriberId);
      await this.enqueue({
        conversationId: conversation?.id ?? null,
        reply: escalationReply('low_confidence', rules.messages.escalation),
      });
    } catch (error) {
      logger.error({ err: String(error) }, 'silent turn handoff not queued');
      return;
    }
    if (!conversation) return;
    try {
      await store.markEscalated(conversation.id);
      await nudges.cancel(conversation.id, 'escalated');
    } catch (error) {
      logger.error(
        { conversation: conversation.id, err: String(error) },
        'silent turn handoff queued, escalation not recorded',
      );
    }
  }
}

/** The turn whose reply is delivered. */
export interface DeliveredTurn {
  conversationId: string;
  logger: TurnLogger;
  /** Its response was already sent, silent: every reply goes to the outbox. */
  late: boolean;
  /** The race deadline, from the request's arrival (specs/002). */
  deadlineAt: number;
  /** When the flows this turn sent finish playing; its reply waits for them (specs/030). */
  flows: Pick<FlowSends, 'playsUntil'>;
}

/**
 * Decides whether a turn's reply goes back inline or through the outbox, and
 * when: behind a reply to the contact that is still queued (specs/037), and
 * after the flows the turn sent have played (specs/030).
 */
export class ReplyDelivery {
  private readonly outbox: ContactOutbox;
  private readonly turn: DeliveredTurn;

  constructor(outbox: ContactOutbox, turn: DeliveredTurn) {
    this.outbox = outbox;
    this.turn = turn;
  }

  /**
   * Whether this turn's reply has to go through the outbox behind the
   * contact's: a reply to them is still queued, or this turn's response was
   * already sent (specs/037 § A reply never overtakes an earlier one).
   */
  async mustQueue(): Promise<boolean> {
    return this.turn.late || (await this.outbox.hasQueuedReply());
  }

  /**
   * Whether the response to a lost race carries no holding line. A flow still
   * playing is the contact's wait: a holding line now would land inside it
   * (specs/030 § A flow still playing is the holding line). So would one
   * while a reply to the contact is still queued: it is on its way
   * (specs/037).
   */
  async silentNow(): Promise<boolean> {
    return this.turn.flows.playsUntil > Date.now() || (await this.mustQueue());
  }

  /** When a reply queued now may go out: once the turn's flows have played. */
  notBefore(): Date | undefined {
    const until = this.turn.flows.playsUntil;
    return until > Date.now() ? new Date(until) : undefined;
  }

  /**
   * Queues a reply that completed after the race, behind the flows the call
   * sent, before or after the deadline.
   */
  async queue(reply: AgentReply, actions?: DeferredActions): Promise<void> {
    await this.outbox.enqueue({
      conversationId: this.turn.conversationId,
      reply,
      actions,
      notBefore: this.notBefore(),
    });
  }

  /**
   * Answers a turn decided without the model: inline, or behind the
   * contact's queued reply with a silent response.
   */
  async answer(result: TurnResult): Promise<TurnResult> {
    const { logger, late, conversationId } = this.turn;
    if (!(await this.mustQueue())) return result;
    try {
      await this.outbox.enqueue({ conversationId, reply: result.reply });
    } catch (error) {
      // A late turn's response is gone, so its reply has nowhere else to go.
      if (late) throw error;
      // Early is better than never: the reply goes out now.
      logger.error({ err: String(error) }, 'failed to queue reply behind the previous one');
      return result;
    }
    logger.info({ path: 'outbox' }, 'reply queued behind the previous one');
    return { ...result, silent: true };
  }

  /**
   * Delivers a settled turn's reply after the flows it sent have played
   * (specs/030 § The reply waits for the flow to play): inline once they
   * end, when that is before the deadline, and otherwise from the outbox at
   * that time, with a silent response now. `actions` go with it to the
   * outbox, in place of `afterResponse`.
   */
  async deliver(result: TurnResult, actions?: DeferredActions): Promise<TurnResult> {
    const { logger, deadlineAt, conversationId, flows } = this.turn;
    const until = flows.playsUntil;
    const now = Date.now();
    const queue = await this.mustQueue();
    if (until <= now && !queue) return result;
    if (until <= deadlineAt && !queue) {
      logger.info({ heldMs: until - now, path: 'inline' }, 'reply held for flow');
      await new Promise(resolve => setTimeout(resolve, until - now));
      return result;
    }
    try {
      await this.outbox.enqueue({
        conversationId,
        reply: result.reply,
        actions,
        notBefore: until > now ? new Date(until) : undefined,
      });
    } catch (error) {
      // Early is better than never: the reply goes out now, inside the flow.
      logger.error({ err: String(error) }, 'failed to hold reply for flow');
      return result;
    }
    if (until > now) {
      logger.info({ heldMs: until - now, path: 'outbox' }, 'reply held for flow');
    } else {
      logger.info({ path: 'outbox' }, 'reply queued behind the previous one');
    }
    return {
      reply: result.reply,
      outcome: result.outcome,
      conversationId: result.conversationId,
      binding: result.binding,
      silent: true,
    };
  }
}
