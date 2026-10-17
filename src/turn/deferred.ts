import type { AgentResult } from '../agent/runner.ts';
import type { ActionStage } from '../agent/tools.ts';
import type { AgentReply } from '../contracts/agent.ts';
import type { Settled } from './completion.ts';
import type { ContactOutbox, DeferredActions, ReplyDelivery } from './delivery.ts';
import type { TurnLogger } from './logger.ts';
import type { TurnRecorder } from './recorder.ts';

/** The turn that lost the race, and what it answered the contact with. */
export interface DeferredTurn {
  logger: TurnLogger;
  stage: ActionStage;
  recorder: TurnRecorder;
  delivery: ReplyDelivery;
  outbox: ContactOutbox;
  /** The holding line the response carried, or held back when `silent`. */
  holding: AgentReply;
  /** The response carried no message: the contact has nothing from this turn yet. */
  silent: boolean;
  /** Whether a model reply is dropped for the contact's next turn (specs/046). */
  superseded: (result: AgentResult) => boolean;
}

/**
 * Finishes a turn whose race was lost (ADR-0001): the call it left running
 * completes into the outbox, with the actions it staged, behind the flows it
 * sent (specs/030). Never throws: a failure it cannot queue is handed to a
 * person when the contact was given nothing (C6).
 */
export class DeferredSettlement {
  private readonly turn: DeferredTurn;

  constructor(turn: DeferredTurn) {
    this.turn = turn;
  }

  async settle(settled: Settled): Promise<void> {
    const { logger, silent, outbox } = this.turn;
    try {
      if (settled.kind === 'error') await this.failed(settled.error);
      else await this.completed(settled.done);
    } catch (error) {
      logger.error({ err: String(error) }, 'failed to enqueue deferred reply');
      // A silent response, late or behind a queued reply or a flow, left the
      // contact this reply and nothing else (C6).
      if (silent) await outbox.handOffSilent();
    }
  }

  /**
   * MODEL_ABORT_MS lands here, with whatever the call had staged, and perhaps
   * a flow request still in flight.
   */
  private async failed(error: unknown): Promise<void> {
    const { stage, recorder, delivery, logger, holding, silent } = this.turn;
    await stage.settled();
    const actions = recorder.discard();
    logger.error({ err: String(error) }, 'deferred model call failed');
    // A flow sent during the call has reached the contact, so the turn is
    // recorded with it: otherwise the next turn would not know it went out,
    // and could send a send-once flow again (specs/029 § An escalation cannot
    // recall a flow). Recorded as the holding line the contact was actually
    // given.
    if (stage.sent.length > 0) await recorder.failed(holding.messages.join('\n'), actions);
    // A silent response gave the contact nothing yet, so the holding line it
    // held back goes out now, after the flow (specs/030).
    if (silent) await delivery.queue(holding);
  }

  private async completed(done: Extract<Settled, { kind: 'done' }>['done']): Promise<void> {
    const { recorder, delivery, logger } = this.turn;
    if (done.kind === 'decided') {
      await recorder.decided(done.reply, done.outcome);
      await delivery.queue(done.reply);
      return;
    }
    const { result } = done;
    if (this.turn.superseded(result)) {
      await recorder.settle(result, 'superseded');
      logger.info({ outcome: 'superseded', deferred: true }, 'reply superseded');
      return;
    }
    const turnId = await recorder.settle(result, 'deferred');
    // Deferred with the reply, never dropped from it: the worker performs them
    // once the text is delivered (specs/012 § The whole loop runs inside the
    // race).
    const staged = recorder.performable(result);
    const actions: DeferredActions | undefined = staged.length > 0 ? { staged, turnId } : undefined;
    // The inline path logs these too. Without the same line here a guardrail
    // or a failed call on a deferred turn left no trace in the logs at all,
    // which is most of them whenever the model runs slow.
    if (result.interventions.length > 0) {
      logger.info({ interventions: result.interventions, deferred: true }, 'guardrails intervened');
    }
    await delivery.queue(result.reply, actions);
  }
}
