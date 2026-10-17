import type { AgentResult } from '../agent/runner.ts';
import type { AgentReply, TurnOutcome } from '../contracts/agent.ts';

/**
 * A reply that hands nothing to a person: a scripted opening, a holding line,
 * the tenant's media fallback, or no message at all for a silent response.
 * Tenant copy already ends how it should, so no closing question is appended.
 */
export function plainReply(messages: string[]): AgentReply {
  return {
    messages,
    escalate: false,
    escalation_reason: null,
    confidence: 1,
    closing_question: null,
  };
}

/**
 * The outcome of a model reply delivered on its own turn. A failed call and a
 * deliberate escalation both carry `escalate: true` and the same tenant
 * message, so without the first branch the turns table would record a dead
 * model call as a decision the model made.
 */
export function modelOutcomeOf(result: AgentResult): TurnOutcome {
  if (result.modelError) return 'error';
  return result.reply.escalate ? 'escalated_model' : 'answered_inline';
}
