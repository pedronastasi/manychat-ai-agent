import { contactActionsFrom, knownOffering } from '../agent/tools.ts';
import type { ContactActions } from '../agent/tools.ts';
import type { ContactReader } from '../channels/manychat/client.ts';
import { LINK_SENT, MAX_NUDGE_MINUTES } from '../contracts/config.ts';
import type { Rules, Tools } from '../contracts/config.ts';
import { checkTurnCap } from '../conversation/budget.ts';
import type { BudgetGuard } from '../conversation/budget.ts';
import type { ConversationStore } from '../conversation/store.ts';
import type { CancelReason, ClaimedNudge } from './store.ts';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * No race to protect here, unlike `get_contact`'s 1500 ms (specs/024): the
 * client's own 10-second bound, so a slow read is not mistaken for a failure.
 */
const TAG_READ_TIMEOUT_MS = 10_000;

/** The nudge's conversation, as the worker reads it at due time. */
export type NudgedConversation = NonNullable<Awaited<ReturnType<ConversationStore['byId']>>>;

export interface NudgeChecksDeps {
  store: ConversationStore;
  budget: BudgetGuard;
  /** The `human_active` check's read: the specs/024 read path (specs/025). */
  contacts: ContactReader;
  rules: Rules;
  tools: Tools;
  /** Warns on a failed tag read, naming the conversation (ADR-0014). */
  warn: (obj: object, msg: string) => void;
}

/** A nudge every check allowed, with what its turn runs on. */
export interface AllowedNudge {
  contact: ContactActions & { offering: string | undefined };
  /** The contact's last message on the nudge's channel, which it follows up (specs/025, 048). */
  lastInbound: Date;
  /** How far back the turn's history reaches (specs/018). */
  historySince: Date;
}

export type NudgeCheck = { cancel: CancelReason } | { allowed: AllowedNudge };

/**
 * Whether a due nudge may still run, before the model is called (specs/025 §
 * A nudge is cancelled by anything that makes it wrong). Cheapest first; the
 * ManyChat read last, and the rate limit after it, because it counts the turn
 * against the contact's hourly limit.
 */
export class NudgeChecks {
  private readonly deps: NudgeChecksDeps;

  constructor(deps: NudgeChecksDeps) {
    this.deps = deps;
  }

  async check(
    nudge: ClaimedNudge,
    conversation: NudgedConversation,
    now: Date,
  ): Promise<NudgeCheck> {
    const { store, budget, rules, tools } = this.deps;

    if (conversation.escalatedAt && conversation.escalatedAt >= nudge.scheduledAt) {
      return { cancel: 'escalated' };
    }
    const historySince = new Date(now.getTime() - rules.historyDays * DAY_MS);
    const contact = {
      ...contactActionsFrom(await store.actionHistory(conversation.id), tools, historySince),
      // No request to carry one, so the offering the conversation keeps, if
      // the catalog still has it (specs/028).
      offering: knownOffering(conversation.offering, tools),
    };
    if (contact.funnelStage === LINK_SENT) return { cancel: 'link_sent' };

    // On the nudge's own channel, whose window it is sent in (specs/048).
    const lastInbound = await store.lastInbound(conversation.id, nudge.channel ?? undefined);
    if (!lastInbound || now.getTime() > lastInbound.getTime() + MAX_NUDGE_MINUTES * MINUTE_MS) {
      return { cancel: 'window_closing' };
    }

    // A cap never escalates a nudge: the contact asked nothing, so there is
    // nothing to hand off.
    const turnCap = checkTurnCap(conversation.turnCount + 1, rules);
    const spent = await budget.checkBudget(conversation.tenantId, rules, now);
    if (!turnCap.allowed || !spent.allowed) return { cancel: 'cap_reached' };

    const humanActive = await this.humanActive(conversation);
    if (humanActive) return { cancel: humanActive };

    const rate = await budget.checkRateLimit(
      conversation.tenantId,
      conversation.subscriberId,
      rules,
      now,
    );
    if (!rate.allowed) return { cancel: 'cap_reached' };

    return { allowed: { contact, lastInbound, historySince } };
  }

  /** The tenant's human-takeover tag on the contact, read at due time. */
  private async humanActive(
    conversation: NudgedConversation,
  ): Promise<'human_active' | 'read_failed' | undefined> {
    const humanActiveTag = this.deps.tools.nudge?.humanActiveTag;
    if (!humanActiveTag) return undefined;
    let tags: string[];
    try {
      const record = await this.deps.contacts.readContact(
        conversation.subscriberId,
        AbortSignal.timeout(TAG_READ_TIMEOUT_MS),
      );
      tags = record.tags;
    } catch (error) {
      // An unprompted message on top of a person's conversation is worse
      // than a missed follow-up (C6).
      this.deps.warn(
        { conversation: conversation.id, err: error instanceof Error ? error.name : 'unknown' },
        'nudge tag read failed',
      );
      return 'read_failed';
    }
    return tags.includes(humanActiveTag) ? 'human_active' : undefined;
  }
}
