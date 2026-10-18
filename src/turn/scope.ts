import type { AgentResult } from '../agent/runner.ts';
import { ContactReads, ReadBudget } from '../agent/contact.ts';
import { FlowSends } from '../agent/flows.ts';
import { ActionStage } from '../agent/tools.ts';
import type { ActionPerformer, ContactReader } from '../channels/manychat/client.ts';
import type { AgentReply, InboundMessage } from '../contracts/agent.ts';
import type { Rules, Tools } from '../contracts/config.ts';
import type { BudgetGuard } from '../conversation/budget.ts';
import type { ConversationStore } from '../conversation/store.ts';
import { NudgingPerformer } from '../nudge/performer.ts';
import type { NudgeStore } from '../nudge/store.ts';
import type { OutboxQueue } from '../outbox/queue.ts';
import type { Plugins } from '../plugins/plugins.ts';
import { PluginReads } from '../plugins/reads.ts';
import { DeferredSettlement } from './deferred.ts';
import { ContactOutbox, ReplyDelivery } from './delivery.ts';
import type { TurnLogger } from './logger.ts';
import { TurnRecorder } from './recorder.ts';

export interface TurnScopeDeps {
  store: ConversationStore;
  budget: BudgetGuard;
  queue: OutboxQueue;
  nudges: NudgeStore;
  rules: Rules;
  tools: Tools;
  /** Performs a flow the model sends, and what it staged (specs/012, 029). */
  actions: ActionPerformer;
  /** Reads the contact for `get_contact` (specs/024). Without it, no read is offered. */
  contacts?: ContactReader | undefined;
  /** The tenant's plugins, whose read tools a turn may be offered (specs/039). */
  plugins?: Plugins | undefined;
  /** The plugin channel the turn arrived on (specs/038); ManyChat when absent. */
  channel?: string | undefined;
  logger: TurnLogger;
}

/** The admitted turn its collaborators are built for. */
export interface ScopedTurn {
  inbound: InboundMessage;
  conversationId: string;
  /** Whether the turn may change the contact's own state (specs/019). */
  bound: boolean;
  /** Whether the turn may read the contact's history, and their record (specs/019, 024). */
  readsHistory: boolean;
  /** Names the conversation on every line (ADR-0014). */
  logger: TurnLogger;
  /** Its response was already sent, silent: every reply goes to the outbox. */
  late: boolean;
  /** The race deadline, from the request's arrival (specs/002). */
  deadlineAt: number;
}

/** What one turn runs with. None of it outlives the turn or is shared with another. */
export interface TurnCollaborators {
  /** What the model stages this turn (ADR-0010). */
  stage: ActionStage;
  reads: ContactReads | undefined;
  pluginReads: PluginReads | undefined;
  flows: FlowSends;
  outbox: ContactOutbox;
  delivery: ReplyDelivery;
  recorder: TurnRecorder;
}

/** How a lost race answered the contact, for the settlement that finishes it. */
export interface LostRace {
  holding: AgentReply;
  silent: boolean;
  superseded: (result: AgentResult) => boolean;
}

/**
 * Builds the collaborators of one admitted turn (ADR-0023). It only
 * constructs: the rules each collaborator applies stay in that collaborator,
 * and the order they run in stays in `TurnHandler`.
 */
export class TurnScope {
  private readonly deps: TurnScopeDeps;

  constructor(deps: TurnScopeDeps) {
    this.deps = deps;
  }

  open(turn: ScopedTurn): TurnCollaborators {
    const { inbound, conversationId, bound, readsHistory, logger } = turn;
    const { contacts, plugins, tools } = this.deps;
    const { subscriberId } = inbound;

    // Held here rather than in the runner, so what the model staged is still
    // known when the call is aborted and never returns.
    const stage = new ActionStage();

    // The contact's record holds their own words in its notes, so a turn that
    // may not read their history may not read it either (specs/024). A plugin
    // read is given the subscriber, so it is held to the same rule, and
    // spends the same two reads (specs/039).
    const budget = new ReadBudget();
    const reads =
      contacts && readsHistory
        ? new ContactReads({ reader: contacts, subscriberId, logger, budget })
        : undefined;
    const pluginReads =
      plugins?.hasReadTools && readsHistory
        ? new PluginReads({ subscriberId, logger, budget })
        : undefined;

    // A flow is sent when the model calls it, so its reply follows it
    // (specs/029). Through the nudging performer, so a payment link sent now
    // still cancels a pending nudge.
    const flows = new FlowSends({
      performer: this.performer(conversationId),
      subscriberId,
      logger,
      tools,
    });

    const outbox = this.outbox(inbound);
    const delivery = new ReplyDelivery(outbox, {
      conversationId,
      logger,
      late: turn.late,
      deadlineAt: turn.deadlineAt,
      flows,
    });
    const recorder = new TurnRecorder(
      { store: this.deps.store, budget: this.deps.budget, nudges: this.deps.nudges },
      { conversationId, tenantId: inbound.tenantId, bound, logger, stage, pluginReads },
    );
    return { stage, reads, pluginReads, flows, outbox, delivery, recorder };
  }

  /** The contact's queued replies, on the turn's channel (specs/038). */
  outbox(inbound: InboundMessage): ContactOutbox {
    const { queue, store, nudges, rules, logger, channel } = this.deps;
    return new ContactOutbox(
      { queue, store, nudges, rules, logger, channel },
      { tenantId: inbound.tenantId, subscriberId: inbound.subscriberId },
    );
  }

  /** Performs the contact's actions; a payment link cancels a pending nudge (specs/025). */
  performer(conversationId: string): NudgingPerformer {
    return new NudgingPerformer(this.deps.actions, this.deps.nudges, conversationId);
  }

  /** Finishes the turn after a lost race (ADR-0001), with what it already built. */
  settlement(turn: TurnCollaborators, logger: TurnLogger, lost: LostRace): DeferredSettlement {
    const { stage, recorder, delivery, outbox } = turn;
    return new DeferredSettlement({ logger, stage, recorder, delivery, outbox, ...lost });
  }
}
