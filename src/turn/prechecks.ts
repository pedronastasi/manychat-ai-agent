import { escalationReply } from '../agent/guardrails.ts';
import type { AgentReply, EscalationReason, InboundMessage } from '../contracts/agent.ts';
import type { Rules } from '../contracts/config.ts';
import { checkKeywords, checkTurnCap, matchOpeningTrigger } from '../conversation/budget.ts';
import type { BudgetGuard } from '../conversation/budget.ts';
import { plainReply } from './replies.ts';

/** A reply decided before the model, which never runs for it. */
export type Precheck =
  | { outcome: 'answered_scripted'; reply: AgentReply }
  | { outcome: 'escalated_precheck'; reply: AgentReply; reason: EscalationReason; detail: string };

export interface PrechecksDeps {
  budget: BudgetGuard;
  rules: Rules;
}

/**
 * What a turn is answered with before the model: the channel flow's opening
 * sentinel, or a handoff when a guard denies it. Each costs nothing and fails
 * toward a human (C6).
 */
export class Prechecks {
  private readonly deps: PrechecksDeps;

  constructor(deps: PrechecksDeps) {
    this.deps = deps;
  }

  async check(
    inbound: InboundMessage,
    turn: { turnCount: number; bound: boolean },
  ): Promise<Precheck | undefined> {
    const { rules, budget } = this.deps;
    const { media } = inbound;

    // The channel flow's opening sentinel. Fully determined - no contact input
    // to interpret and exactly one correct reply - so it never reaches the
    // model: instant, free, and it cannot be lost to a low-confidence
    // self-report. Checked before the guards because the sentinel is emitted by
    // the flow rather than typed by a contact, and the caps below exist to
    // bound model spend, which a scripted reply does not incur. Media never
    // matches: the sentinel is sent by the flow, not spoken by a contact.
    const opening = media ? null : matchOpeningTrigger(inbound.text, rules);
    if (opening) {
      // The opening copy is the tenant's own and already ends how it should;
      // appending a second question would talk over it.
      return { outcome: 'answered_scripted', reply: plainReply([opening]) };
    }

    // A media turn has no words to match until it is transcribed, inside the
    // race; the rest need none, so a contact over a limit costs no download.
    const guards = [
      media ? { allowed: true as const } : checkKeywords(inbound.text, rules),
      turn.bound ? checkTurnCap(turn.turnCount, rules) : { allowed: true as const },
      await budget.checkRateLimit(inbound.tenantId, inbound.subscriberId, rules),
      await budget.checkBudget(inbound.tenantId, rules),
    ];
    const denied = guards.find(guard => !guard.allowed);
    if (!denied || denied.allowed) return undefined;
    return {
      outcome: 'escalated_precheck',
      reply: escalationReply(denied.reason, rules.messages.escalation),
      reason: denied.reason,
      detail: denied.detail,
    };
  }
}
