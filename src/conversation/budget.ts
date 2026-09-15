import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { budgetCounters, rateCounters } from '../db/schema.ts';
import type { Rules } from '../contracts/config.ts';
import type { EscalationReason } from '../contracts/agent.ts';

/**
 * Guards that run BEFORE the model, so an over-budget or rate-limited turn costs
 * nothing. Every denial escalates to a human rather than erroring
 * (Constitution C6) — a customer waiting for a person is an acceptable outcome.
 */
export type GuardDecision =
  { allowed: true } | { allowed: false; reason: EscalationReason; detail: string };

const startOfHour = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours()));

const utcDay = (now: Date) => now.toISOString().slice(0, 10);

export class BudgetGuard {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Atomically increments the subscriber's hourly counter and reports whether it
   * is now over the limit. Increment-then-check, not check-then-increment: the
   * latter lets concurrent messages both read an under-limit value and pass.
   */
  async checkRateLimit(
    tenantId: string,
    subscriberId: string,
    rules: Rules,
    now = new Date(),
  ): Promise<GuardDecision> {
    const windowStart = startOfHour(now);
    const [row] = await this.db
      .insert(rateCounters)
      .values({ tenantId, subscriberId, windowStart, count: 1 })
      .onConflictDoUpdate({
        target: [rateCounters.tenantId, rateCounters.subscriberId, rateCounters.windowStart],
        set: { count: sql`${rateCounters.count} + 1` },
      })
      .returning({ count: rateCounters.count });

    const count = row?.count ?? 1;
    if (count > rules.rateLimit.turnsPerSubscriberPerHour) {
      return {
        allowed: false,
        reason: 'explicit_request',
        detail: `rate limit: ${count} turns this hour`,
      };
    }
    return { allowed: true };
  }

  /** Rejects the turn when the tenant's daily token or cost cap is already spent. */
  async checkBudget(tenantId: string, rules: Rules, now = new Date()): Promise<GuardDecision> {
    const day = utcDay(now);
    const row = await this.db.query.budgetCounters.findFirst({
      where: and(eq(budgetCounters.tenantId, tenantId), eq(budgetCounters.day, day)),
    });
    if (!row) return { allowed: true };

    if (row.tokens >= rules.budget.dailyTokenCap) {
      return { allowed: false, reason: 'out_of_scope', detail: `daily token cap reached` };
    }
    if (Number(row.costUsd) >= rules.budget.dailyCostCapUsd) {
      return { allowed: false, reason: 'out_of_scope', detail: `daily cost cap reached` };
    }
    return { allowed: true };
  }

  /** Recorded after each model call; feeds the cap checked above. */
  async recordSpend(tenantId: string, tokens: number, costUsd: number, now = new Date()) {
    const day = utcDay(now);
    await this.db
      .insert(budgetCounters)
      .values({ tenantId, day, tokens, costUsd: costUsd.toFixed(6) })
      .onConflictDoUpdate({
        target: [budgetCounters.tenantId, budgetCounters.day],
        set: {
          tokens: sql`${budgetCounters.tokens} + ${tokens}`,
          costUsd: sql`${budgetCounters.costUsd} + ${costUsd.toFixed(6)}`,
        },
      });
  }
}

// Pure decisions: no dependency to inject, so they stay functions (ADR-0008).

export function checkTurnCap(turnCount: number, rules: Rules): GuardDecision {
  if (turnCount > rules.maxTurnsPerConversation) {
    return {
      allowed: false,
      reason: 'explicit_request',
      detail: `conversation exceeded ${rules.maxTurnsPerConversation} turns`,
    };
  }
  return { allowed: true };
}

/**
 * The scripted opening, when the whole inbound message is the configured
 * sentinel. Returns null when no trigger is configured or the text is anything
 * else, so the turn proceeds to the model as usual.
 *
 * Whole-message and case-insensitive: the sentinel is emitted by the channel
 * flow, not typed by a contact, so substring matching would let a contact who
 * mentions the phrase replay the opening.
 */
export function matchOpeningTrigger(text: string, rules: Rules): string | null {
  const trigger = rules.openingTrigger;
  if (!trigger) return null;
  const normalized = text.trim().toLowerCase();
  const hit = trigger.keywords.some(keyword => keyword.trim().toLowerCase() === normalized);
  return hit ? trigger.message : null;
}

/** Immediate handoff on configured keywords — checked before the model runs. */
export function checkKeywords(text: string, rules: Rules): GuardDecision {
  const haystack = text.toLowerCase();
  const hit = rules.escalationKeywords.find(keyword => haystack.includes(keyword.toLowerCase()));
  return hit
    ? { allowed: false, reason: 'explicit_request', detail: `keyword: ${hit}` }
    : { allowed: true };
}
