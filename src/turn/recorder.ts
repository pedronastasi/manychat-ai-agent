import type { AgentResult } from '../agent/runner.ts';
import type { ActionStage } from '../agent/tools.ts';
import type { ActionRecord, AgentReply, StagedAction, TurnOutcome } from '../contracts/agent.ts';
import type { BudgetGuard } from '../conversation/budget.ts';
import type { ConversationStore } from '../conversation/store.ts';
import type { NudgeStore } from '../nudge/store.ts';
import type { PluginReads } from '../plugins/reads.ts';
import type { TurnLogger } from './logger.ts';

export interface TurnRecorderDeps {
  store: ConversationStore;
  budget: BudgetGuard;
  nudges: NudgeStore;
}

/** The turn whose agent reply is recorded. */
export interface RecordedTurn {
  conversationId: string;
  tenantId: string;
  /** Only a bound turn may change the contact's own state (specs/019). */
  bound: boolean;
  logger: TurnLogger;
  /** What the model stages this turn, read when its reply is recorded (specs/012). */
  stage: ActionStage;
  /** The turn's plugin reads. Absent when no read tool is offered (specs/039). */
  pluginReads?: PluginReads | undefined;
}

/**
 * Writes how a turn ended: its agent reply row, with usage, spend, what was
 * staged and what was read, and the escalation it made. One per turn; the
 * inline and the deferred path record through the same one, so the two cannot
 * drift apart (ADR-0024).
 */
export class TurnRecorder {
  private readonly deps: TurnRecorderDeps;
  private readonly turn: RecordedTurn;

  constructor(deps: TurnRecorderDeps, turn: RecordedTurn) {
    this.deps = deps;
    this.turn = turn;
  }

  /**
   * An unbound request must not change the contact's own state. Any
   * escalation cancels a waiting nudge, though: it can only err toward
   * sending nothing (specs/025).
   */
  async escalated(): Promise<void> {
    const { conversationId, bound } = this.turn;
    await this.deps.nudges.cancel(conversationId, 'escalated');
    if (bound) await this.deps.store.markEscalated(conversationId);
  }

  /**
   * Records a reply decided without the model: the scripted opening, a
   * precheck's handoff, a media fallback. Its own outcome is kept even when
   * it lands after the deadline: `deferred` describes a slow model, and a
   * fallback recorded as one could not be counted as a fallback.
   */
  async decided(reply: AgentReply, outcome: TurnOutcome): Promise<void> {
    await this.deps.store.recordAgentReply(
      this.turn.conversationId,
      reply.messages.join('\n'),
      outcome,
      { bound: this.turn.bound },
    );
    if (reply.escalate) await this.escalated();
  }

  /**
   * Staged actions are performed only when the final reply, after the
   * guardrails, does not escalate. Every other ending lands here (specs/012
   * § Guardrails run before any action is performed), except the
   * `onEscalation` notes in `kept` (specs/024).
   */
  discard(kept: readonly StagedAction[] = []): ActionRecord[] | undefined {
    const { stage, logger } = this.turn;
    const discarded = stage.staged.length - kept.length;
    if (discarded > 0) logger.info({ discarded }, 'staged actions discarded');
    return stage.staged.length + stage.dropped.length + stage.sent.length > 0
      ? stage.records('discarded', kept)
      : undefined;
  }

  /**
   * Records a model call that failed, with what it had staged, as `error`.
   * `message` is what the contact was actually given.
   */
  async failed(message: string, actions: ActionRecord[] | undefined): Promise<void> {
    await this.deps.store.recordAgentReply(this.turn.conversationId, message, 'error', {
      bound: this.turn.bound,
      actions,
      reads: this.reads(),
    });
  }

  /**
   * What a settled turn performs once its text is delivered: everything
   * staged when it did not escalate, and on an escalation the model or the
   * confidence threshold made, the notes that outlive it (specs/024 § A
   * handoff summary survives the escalation it describes).
   */
  performable(result: AgentResult): readonly StagedAction[] {
    const { stage } = this.turn;
    return result.reply.escalate
      ? stage.survivors(result.escalatedBy === 'model' || result.escalatedBy === 'confidence')
      : stage.staged;
  }

  /**
   * Persists a model reply's usage, spend and what was staged, and the
   * escalation it made. Returns the agent turn's id.
   */
  async settle(result: AgentResult, outcome: TurnOutcome): Promise<string> {
    const { conversationId, tenantId, bound } = this.turn;
    const turnId = await this.deps.store.recordAgentReply(
      conversationId,
      result.reply.messages.join('\n'),
      outcome,
      {
        bound,
        usage: {
          model: result.model,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cacheReadTokens: result.usage.cacheReadTokens,
          costUsd: result.usage.costUsd,
          latencyMs: result.latencyMs,
          playbookVersion: result.playbookVersion,
        },
        actions: this.actionsOf(result, outcome),
        reads: this.reads(),
      },
    );
    const tokens = (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0);
    await this.deps.budget.recordSpend(tenantId, tokens, result.usage.costUsd);
    if (result.reply.escalate) await this.escalated();
    return turnId;
  }

  /**
   * Null when no tool was offered, so it reads apart from "offered, none
   * chosen" (specs/012 § Every staged action is recorded on its turn). A flow
   * the server sent is recorded even when the model was offered no tool: the
   * opening may be a tenant's only flow (specs/032).
   */
  private actionsOf(result: AgentResult, outcome: TurnOutcome): ActionRecord[] | null {
    const { stage } = this.turn;
    if (!result.toolsOffered && stage.sent.length === 0) return null;
    if (outcome === 'superseded') return this.discard() ?? [];
    if (result.reply.escalate) return this.discard(this.performable(result)) ?? [];
    return stage.records('staged');
  }

  /**
   * Every row an agent turn writes carries its reads, an errored one too:
   * null only when no read tool was offered (specs/039 § The turn records
   * that a read happened, never what it returned).
   */
  private reads() {
    const { pluginReads } = this.turn;
    return pluginReads ? [...pluginReads.records] : null;
  }
}
