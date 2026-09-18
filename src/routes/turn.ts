import type { Database } from '../db/client.ts';
import type { AgentRunner, AgentResult } from '../agent/runner.ts';
import type { InboundMessage, AgentReply, TurnOutcome } from '../contracts/agent.ts';
import type { Rules } from '../contracts/config.ts';
import { escalationReply } from '../agent/guardrails.ts';
import { ConversationStore } from '../conversation/store.ts';
import {
  BudgetGuard,
  checkKeywords,
  checkTurnCap,
  matchOpeningTrigger,
} from '../conversation/budget.ts';
import { OutboxQueue } from '../outbox/queue.ts';

export interface TurnDeps {
  db: Database;
  runner: AgentRunner;
  rules: Rules;
  raceDeadlineMs: number;
  modelAbortMs: number;
  logger: { info: (o: object, m: string) => void; error: (o: object, m: string) => void };
}

export interface TurnResult {
  reply: AgentReply;
  outcome: TurnOutcome;
  conversationId: string;
}

/**
 * Runs one conversational turn under the platform's timeout (specs/002).
 *
 * The race is the whole design (ADR-0001): if the model answers before the
 * deadline the reply goes back inline; if not, the caller gets an
 * acknowledgement and the still-running model call delivers via the outbox.
 */
export class TurnHandler {
  private readonly deps: TurnDeps;
  private readonly store: ConversationStore;
  private readonly budget: BudgetGuard;
  private readonly queue: OutboxQueue;

  constructor(deps: TurnDeps) {
    this.deps = deps;
    this.store = new ConversationStore(deps.db);
    this.budget = new BudgetGuard(deps.db);
    this.queue = new OutboxQueue(deps.db);
  }

  async handle(inbound: InboundMessage): Promise<TurnResult> {
    const { rules, logger } = this.deps;

    const conversation = await this.store.startTurn({
      tenantId: inbound.tenantId,
      subscriberId: inbound.subscriberId,
      channel: inbound.channel,
    });
    await this.store.recordUserMessage(conversation.id, inbound.text);

    // The channel flow's opening sentinel. Fully determined - no contact input
    // to interpret and exactly one correct reply - so it never reaches the
    // model: instant, free, and it cannot be lost to a low-confidence
    // self-report. Checked before the guards because the sentinel is emitted by
    // the flow rather than typed by a contact, and the caps below exist to
    // bound model spend, which a scripted reply does not incur.
    const opening = matchOpeningTrigger(inbound.text, rules);
    if (opening) {
      await this.store.recordAgentReply(conversation.id, opening, 'answered_scripted');
      logger.info({ outcome: 'answered_scripted' }, 'scripted opening sent');
      return {
        reply: {
          messages: [opening],
          escalate: false,
          escalation_reason: null,
          confidence: 1,
          // The opening copy is the tenant's own and already ends how it
          // should; appending a second question would talk over it.
          closing_question: null,
        },
        outcome: 'answered_scripted',
        conversationId: conversation.id,
      };
    }

    // Pre-model guards: each denial costs nothing and fails toward a human (C6).
    const guards = [
      checkKeywords(inbound.text, rules),
      checkTurnCap(conversation.turnCount, rules),
      await this.budget.checkRateLimit(inbound.tenantId, inbound.subscriberId, rules),
      await this.budget.checkBudget(inbound.tenantId, rules),
    ];
    const denied = guards.find(guard => !guard.allowed);
    if (denied && !denied.allowed) {
      const reply = escalationReply(denied.reason, rules.messages.escalation);
      await this.store.recordAgentReply(conversation.id, reply.messages[0]!, 'escalated_precheck');
      await this.store.markEscalated(conversation.id);
      logger.info({ reason: denied.reason, detail: denied.detail }, 'turn escalated before model');
      return { reply, outcome: 'escalated_precheck', conversationId: conversation.id };
    }

    const history = await this.store.recentTurns(conversation.id, 10);
    // recentTurns includes the message just recorded; the runner adds it itself.
    const priorHistory = history.slice(0, -1);

    const abort = new AbortController();
    const abortTimer = setTimeout(() => abort.abort(), this.deps.modelAbortMs);

    let deadlineTimer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'deadline'>(resolve => {
      deadlineTimer = setTimeout(() => resolve('deadline'), this.deps.raceDeadlineMs);
    });

    const modelCall = this.deps.runner
      .run({ text: inbound.text, history: priorHistory, signal: abort.signal })
      .then(result => ({ kind: 'result' as const, result: result }))
      .catch((error: unknown) => ({ kind: 'error' as const, error }));

    const winner = await Promise.race([modelCall, deadline]);

    /** Persists usage and spend. Shared by the inline and deferred paths. */
    const settle = async (result: AgentResult, outcome: TurnOutcome) => {
      await this.store.recordAgentReply(
        conversation.id,
        result.reply.messages.join('\n'),
        outcome,
        {
          model: result.model,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cacheReadTokens: result.usage.cacheReadTokens,
          costUsd: result.usage.costUsd,
          latencyMs: result.latencyMs,
        },
      );
      const tokens = (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0);
      await this.budget.recordSpend(inbound.tenantId, tokens, result.usage.costUsd);
      if (result.reply.escalate) await this.store.markEscalated(conversation.id);
    };

    if (winner === 'deadline') {
      clearTimeout(deadlineTimer);

      // The in-flight call is NOT cancelled: those tokens are already paid for,
      // and the answer is still wanted. It completes into the outbox instead.
      //
      // abortTimer deliberately stays armed. MODEL_ABORT_MS is the outer bound
      // on a runaway call, and this is the only path where a call can outlive
      // the request — so clearing it here would leave the deferred call with no
      // bound at all. It is cleared below, when the call actually settles.
      void modelCall.then(async outcome => {
        clearTimeout(abortTimer);
        try {
          if (outcome.kind === 'error') {
            logger.error({ err: String(outcome.error) }, 'deferred model call failed');
            return;
          }
          await settle(outcome.result, 'deferred');
          // The inline path logs these below. Without the same line here a
          // guardrail or a failed call on a deferred turn left no trace in the
          // logs at all, which is most of them whenever the model runs slow.
          if (outcome.result.interventions.length > 0) {
            logger.info(
              { interventions: outcome.result.interventions, deferred: true },
              'guardrails intervened',
            );
          }
          await this.queue.enqueue({
            tenantId: inbound.tenantId,
            subscriberId: inbound.subscriberId,
            conversationId: conversation.id,
            reply: outcome.result.reply,
          });
        } catch (error) {
          logger.error({ err: String(error) }, 'failed to enqueue deferred reply');
        }
      });

      return {
        reply: {
          messages: [rules.messages.acknowledgement],
          escalate: false,
          escalation_reason: null,
          confidence: 1,
          // A holding line while the real reply completes into the outbox.
          closing_question: null,
        },
        outcome: 'deferred',
        conversationId: conversation.id,
      };
    }

    clearTimeout(abortTimer);
    clearTimeout(deadlineTimer);

    if (winner.kind === 'error') {
      logger.error({ err: String(winner.error) }, 'model call failed');
      const reply = escalationReply('low_confidence', rules.messages.escalation);
      await this.store.recordAgentReply(conversation.id, reply.messages[0]!, 'error');
      await this.store.markEscalated(conversation.id);
      return { reply, outcome: 'error', conversationId: conversation.id };
    }

    // A failed call and a deliberate escalation both carry `escalate: true` and
    // the same tenant message, so without the first branch the turns table
    // recorded a dead model call as a decision the model made.
    const outcome: TurnOutcome = winner.result.modelError
      ? 'error'
      : winner.result.reply.escalate
        ? 'escalated_model'
        : 'answered_inline';
    await settle(winner.result, outcome);
    if (winner.result.interventions.length > 0) {
      logger.info({ interventions: winner.result.interventions }, 'guardrails intervened');
    }
    return { reply: winner.result.reply, outcome, conversationId: conversation.id };
  }
}
