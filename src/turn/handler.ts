import type { Database } from '../db/client.ts';
import type { AgentRunner, AgentResult } from '../agent/runner.ts';
import type { InboundMessage, StagedAction } from '../contracts/agent.ts';
import { NO_TOOLS } from '../contracts/config.ts';
import type { Rules, Tools } from '../contracts/config.ts';
import type { MediaResolver } from '../media/resolver.ts';
import { escalationReply } from '../agent/guardrails.ts';
import { ConversationStore } from '../conversation/store.ts';
import { BudgetGuard } from '../conversation/budget.ts';
import { OutboxQueue } from '../outbox/queue.ts';
import { ContactTokens } from '../conversation/tokens.ts';
import type { ContactTokenWriter } from '../conversation/tokens.ts';
import { ActionStage, contactActionsFrom, openingFlow, stagesProspect } from '../agent/tools.ts';
import type { ActionPerformer, ContactReader } from '../channels/manychat/client.ts';
import { ContactReads, ReadBudget } from '../agent/contact.ts';
import { PluginReads } from '../plugins/reads.ts';
import type { Plugins } from '../plugins/plugins.ts';
import { performActions, performedOffering } from '../conversation/actions.ts';
import { NudgeStore } from '../nudge/store.ts';
import { NudgingPerformer } from '../nudge/performer.ts';
import { FlowSends } from '../agent/flows.ts';
import type { TurnLanes } from '../conversation/turns.ts';
import { advertOfferingOf, offeringOf } from './context.ts';
import { TurnAdmission } from './admission.ts';
import { Prechecks } from './prechecks.ts';
import { raceDeadline } from './race.ts';
import { TurnOrder } from './order.ts';
import type { RunOptions } from './order.ts';
import { MessageFold, supersedes } from './fold.ts';
import { modelOutcomeOf, plainReply } from './replies.ts';
import type { Completion, Settled } from './completion.ts';
import { DeferredSettlement } from './deferred.ts';
import type { TurnLogger } from './logger.ts';
import { MediaReader } from './media.ts';
import { TurnRecorder } from './recorder.ts';
import { ContactOutbox, ReplyDelivery } from './delivery.ts';
import type { TurnResult } from './result.ts';

const DAY_MS = 86_400_000;

export type { TurnLogger, TurnResult };

export interface TurnDeps {
  db: Database;
  runner: AgentRunner;
  rules: Rules;
  /** What the agent may act with; read for the contact's funnel and sent flows (specs/023). */
  tools?: Tools | undefined;
  raceDeadlineMs: number;
  modelAbortMs: number;
  logger: TurnLogger;
  /** Where an issued token is written for the contact (specs/019). */
  tokenWriter: ContactTokenWriter;
  /** CONTACT_TOKENS_ENFORCED: false only while tokens reach existing contacts. */
  tokensEnforced: boolean;
  /** Performs what the agent staged, once the reply has gone out (specs/012). */
  actions: ActionPerformer;
  /** Reads the contact for `get_contact` (specs/024). Without it, no read is offered. */
  contacts?: ContactReader | undefined;
  /** The tenant's plugins: their read tools are offered on a turn that reads history (specs/039). */
  plugins?: Plugins | undefined;
  /** Reads voice notes, images and videos (specs/020). Without it, all take the fallback. */
  media?: MediaResolver | undefined;
  /**
   * The process's order of each contact's turns (specs/037). Shared by every
   * request; without it, turns run side by side.
   */
  lanes?: TurnLanes | undefined;
  /**
   * The plugin channel the turn arrived on (specs/038); ManyChat when absent.
   * Its contacts are bound by the channel's own auth and carry no token, its
   * turns are offered no `tools.json` tool, and its queued replies go out
   * through its adapter.
   */
  channel?: string | undefined;
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
  private readonly tokens: ContactTokens;
  private readonly nudges: NudgeStore;
  private readonly media: MediaReader;
  private readonly prechecks: Prechecks;

  constructor(deps: TurnDeps) {
    this.deps = deps;
    this.store = new ConversationStore(deps.db);
    this.budget = new BudgetGuard(deps.db);
    this.queue = new OutboxQueue(deps.db);
    this.tokens = new ContactTokens(deps.db, deps.tokenWriter);
    this.nudges = new NudgeStore(deps.db);
    this.prechecks = new Prechecks({ budget: this.budget, rules: deps.rules });
    this.media = new MediaReader({
      runner: deps.runner,
      rules: deps.rules,
      store: this.store,
      budget: this.budget,
      resolver: deps.media,
    });
  }

  /** The contact's queued replies, on the turn's channel (specs/038). */
  private outboxFor(inbound: InboundMessage): ContactOutbox {
    const { rules, logger, channel } = this.deps;
    return new ContactOutbox(
      { queue: this.queue, store: this.store, nudges: this.nudges, rules, logger, channel },
      { tenantId: inbound.tenantId, subscriberId: inbound.subscriberId },
    );
  }

  private admission(tools: Tools): TurnAdmission {
    const { rules, tokensEnforced, channel, logger } = this.deps;
    return new TurnAdmission({
      store: this.store,
      tokens: this.tokens,
      nudges: this.nudges,
      rules,
      tools,
      tokensEnforced,
      channel,
      logger,
    });
  }

  /**
   * Runs the turn once the contact's previous one has settled (specs/037).
   * Without lanes, turns run side by side.
   */
  async handle(inbound: InboundMessage): Promise<TurnResult> {
    const { lanes, rules, tokensEnforced, channel, logger } = this.deps;
    const deadlineAt = Date.now() + this.deps.raceDeadlineMs;
    if (!lanes) return this.run(inbound, { deadlineAt });
    const order = new TurnOrder({
      lanes,
      store: this.store,
      rules,
      tokensEnforced,
      channel,
      logger,
    });
    return order.handle(inbound, deadlineAt, {
      run: opts => this.run(inbound, opts),
      fold: binding =>
        new MessageFold({ store: this.store, nudges: this.nudges, rules, logger }).fold(
          inbound,
          binding,
        ),
      handOffSilent: () => this.outboxFor(inbound).handOffSilent(),
    });
  }

  private async run(inbound: InboundMessage, opts: RunOptions): Promise<TurnResult> {
    const { rules } = this.deps;
    const now = new Date();
    const tools = this.deps.tools ?? NO_TOOLS;
    const admitted = await this.admission(tools).admit(inbound, now);
    const { binding, bound, readsHistory, conversation, logger, userTurnId } = admitted;
    const { keptOffering, requestOffering } = admitted;
    const { media } = inbound;

    // What the model stages this turn. Held here rather than in the runner, so
    // it is still known when the call is aborted and never returns.
    const stage = new ActionStage();

    // The contact's record holds their own words in its notes, so a turn that
    // may not read their history may not read it either (specs/024). A plugin
    // read is given the subscriber, so it is held to the same rule, and
    // spends the same two reads (specs/039).
    const budget = new ReadBudget();
    const reads =
      this.deps.contacts && readsHistory
        ? new ContactReads({
            reader: this.deps.contacts,
            subscriberId: inbound.subscriberId,
            logger,
            budget,
          })
        : undefined;
    const pluginReads =
      this.deps.plugins?.hasReadTools && readsHistory
        ? new PluginReads({ subscriberId: inbound.subscriberId, logger, budget })
        : undefined;

    // A flow is sent when the model calls it, so its reply follows it
    // (specs/029). Through the nudging performer, so a payment link sent now
    // still cancels a pending nudge.
    const flows = new FlowSends({
      performer: new NudgingPerformer(this.deps.actions, this.nudges, conversation.id),
      subscriberId: inbound.subscriberId,
      logger,
      tools,
    });

    const outbox = this.outboxFor(inbound);
    const delivery = new ReplyDelivery(outbox, {
      conversationId: conversation.id,
      logger,
      late: opts.late === true,
      deadlineAt: opts.deadlineAt,
      flows,
    });
    const recorder = new TurnRecorder(
      { store: this.store, budget: this.budget, nudges: this.nudges },
      {
        conversationId: conversation.id,
        tenantId: inbound.tenantId,
        bound,
        logger,
        stage,
        pluginReads,
      },
    );

    const precheck = await this.prechecks.check(inbound, {
      turnCount: conversation.turnCount,
      bound,
    });
    if (precheck) {
      await recorder.decided(precheck.reply, precheck.outcome);
      if (precheck.outcome === 'answered_scripted') {
        logger.info({ outcome: 'answered_scripted' }, 'scripted opening sent');
      } else {
        logger.info(
          { reason: precheck.reason, detail: precheck.detail },
          'turn escalated before model',
        );
      }
      return delivery.answer({
        reply: precheck.reply,
        outcome: precheck.outcome,
        conversationId: conversation.id,
        binding,
      });
    }

    // History outlives the turn cap on purpose: a contact returning after two
    // weeks gets their context and a fresh cap (specs/018, ADR-0013).
    const historySince = new Date(now.getTime() - rules.historyDays * DAY_MS);
    const history = readsHistory
      ? await this.store.recentTurns(conversation.id, historySince, 10)
      : [];
    // recentTurns includes the message just recorded; the runner adds it itself.
    const priorHistory = history.slice(0, -1);
    // Read whether or not the turn is bound: these are facts about the
    // contact's ManyChat record, not their words, and they narrow what the
    // tools offer, so a request without the token cannot resend a flow or
    // walk the sale back (specs/023).
    const openingEntry = openingFlow(tools);
    const actionHistory =
      tools.flows.length + tools.fields.length > 0
        ? await this.store.actionHistory(conversation.id)
        : undefined;
    const recorded = actionHistory && contactActionsFrom(actionHistory, tools, historySince);
    // The opening belongs to the turn that first stages `prospect`, once per
    // contact, and never to a prospect by the rollout rule (specs/034 § The
    // opening waits for a prospect).
    const openingDue =
      openingEntry !== undefined &&
      recorded !== undefined &&
      !recorded.openingSpent &&
      recorded.intent !== 'prospect';
    const contact =
      actionHistory && recorded
        ? {
            ...recorded,
            ...offeringOf(requestOffering, keptOffering),
            openingDue,
            ...advertOfferingOf(
              bound ? (requestOffering ?? keptOffering) : keptOffering,
              actionHistory,
              tools,
            ),
          }
        : undefined;

    const abort = new AbortController();
    const abortTimer = setTimeout(() => abort.abort(), this.deps.modelAbortMs);

    // Once per turn, whichever comes first: the model's first flow, or its
    // reply settling (specs/032 § The opening flow is the server's).
    let openingSend: Promise<void> | undefined;
    // Only once this turn has staged `prospect`: before that the gate refuses
    // every flow, so nothing can call it early (specs/034).
    const sendOpening =
      openingEntry && openingDue
        ? async () => {
            if (!stagesProspect(stage, tools)) return;
            await (openingSend ??= this.sendOpening(
              openingEntry,
              conversation.id,
              stage,
              flows,
              logger,
            ));
          }
        : undefined;

    // A media turn's download and transcription share the model's deadline and
    // abort signal (specs/020 § Download and transcription run inside the
    // race), so the bound on a runaway model call also bounds a runaway fetch.
    const input = {
      history: priorHistory,
      signal: abort.signal,
      stage,
      contact,
      reads,
      pluginReads,
      flows,
      beforeFlow: sendOpening,
      builtInTools: this.deps.channel === undefined,
    };
    const answered: Promise<Completion> = media
      ? this.media.read(media, { userTurnId, tenantId: inbound.tenantId, logger, input })
      : this.deps.runner
          .run({ ...input, text: inbound.text })
          .then(result => ({ kind: 'model' as const, result }));
    // Inside the race, as a flow the model calls is (specs/029): a send that
    // runs past the deadline is deferred with the reply it precedes.
    const work: Promise<Completion> = sendOpening
      ? answered.then(async done => {
          if (done.kind === 'model' && !done.result.reply.escalate) await sendOpening();
          return done;
        })
      : answered;
    const completion: Promise<Settled> = work
      .then(done => ({ kind: 'done' as const, done }))
      .catch((error: unknown) => ({ kind: 'error' as const, error }));

    // A turn whose response already went out has no race left to win. The
    // deadline runs from the request's arrival, so a wait for the contact's
    // previous turn counts against it (specs/037).
    const winner = opts.late
      ? ('deadline' as const)
      : await raceDeadline(completion, opts.deadlineAt);

    const superseded = (result: AgentResult) =>
      supersedes(result, {
        rules,
        media: media !== undefined,
        followed: opts.followed?.() === true,
        flowsSent: stage.sent.length,
      });

    if (winner === 'deadline') {
      const silent = await delivery.silentNow();
      // A holding line while the real reply completes into the outbox.
      const holding = plainReply([rules.messages.acknowledgement]);

      // The in-flight call is NOT cancelled: those tokens are already paid for,
      // and the answer is still wanted. It completes into the outbox instead.
      //
      // abortTimer deliberately stays armed. MODEL_ABORT_MS is the outer bound
      // on a runaway call, and this is the only path where a call can outlive
      // the request — so clearing it here would leave the deferred call with no
      // bound at all. It is cleared when the call actually settles.
      const deferred = new DeferredSettlement({
        logger,
        stage,
        recorder,
        delivery,
        outbox,
        holding,
        silent,
        superseded,
      });
      const settling = completion.then(async settled => {
        clearTimeout(abortTimer);
        await deferred.settle(settled);
      });
      opts.onBackground?.(settling);

      return {
        reply: holding,
        outcome: 'deferred',
        conversationId: conversation.id,
        binding,
        ...(silent ? { silent: true } : {}),
      };
    }

    clearTimeout(abortTimer);

    if (winner.kind === 'error') {
      logger.error({ err: String(winner.error) }, 'model call failed');
      const reply = escalationReply('low_confidence', rules.messages.escalation);
      await recorder.failed(reply.messages[0]!, recorder.discard());
      await recorder.escalated();
      return delivery.deliver({
        reply,
        outcome: 'error',
        conversationId: conversation.id,
        binding,
      });
    }

    const { done } = winner;
    if (done.kind === 'decided') {
      await recorder.decided(done.reply, done.outcome);
      return delivery.answer({
        reply: done.reply,
        outcome: done.outcome,
        conversationId: conversation.id,
        binding,
      });
    }

    if (superseded(done.result)) {
      await recorder.settle(done.result, 'superseded');
      logger.info({ outcome: 'superseded' }, 'reply superseded');
      return {
        reply: done.result.reply,
        outcome: 'superseded',
        conversationId: conversation.id,
        binding,
        silent: true,
      };
    }

    const outcome = modelOutcomeOf(done.result);
    const turnId = await recorder.settle(done.result, outcome);
    if (done.result.interventions.length > 0) {
      logger.info({ interventions: done.result.interventions }, 'guardrails intervened');
    }
    const staged = recorder.performable(done.result);
    return delivery.deliver(
      {
        reply: done.result.reply,
        outcome,
        conversationId: conversation.id,
        binding,
        ...(staged.length > 0
          ? {
              afterResponse: () =>
                this.performInline(inbound.subscriberId, conversation.id, staged, turnId, logger),
            }
          : {}),
      },
      staged.length > 0 ? { staged, turnId } : undefined,
    );
  }

  /**
   * Sends the opening flow before the first model reply, once per contact:
   * the claim on the conversation makes concurrent first messages send it
   * once (specs/032). Not counted against the cap. A failure costs the
   * opening, never the reply.
   */
  private async sendOpening(
    opening: { id: string; flowNs: string },
    conversationId: string,
    stage: ActionStage,
    flows: FlowSends,
    logger: TurnLogger,
  ): Promise<void> {
    try {
      if (!(await this.store.claimOpening(conversationId))) return;
      const sent = await stage.send(
        { tool: 'send_flow', id: opening.id, flowNs: opening.flowNs, origin: 'opening' },
        flows,
        [],
        { uncapped: true },
      );
      logger.info({ flow: opening.id, sent }, 'opening flow sent');
    } catch (error) {
      logger.error({ err: String(error) }, 'opening flow not sent');
    }
  }

  /**
   * The inline path's actions, run in-process after the response. A crash
   * before they finish loses them, which specs/012 accepts: a late action is
   * worse than a missing one.
   */
  private async performInline(
    subscriberId: string,
    conversationId: string,
    staged: readonly StagedAction[],
    turnId: string,
    logger: TurnLogger,
  ): Promise<void> {
    try {
      const performer = new NudgingPerformer(this.deps.actions, this.nudges, conversationId);
      const outcomes = await performActions(performer, subscriberId, staged, logger);
      await this.store.resolveStaged(turnId, outcomes);
      const offering = performedOffering(staged, outcomes);
      if (offering !== undefined) await this.store.setOffering(conversationId, offering);
    } catch (error) {
      logger.error({ err: String(error) }, 'inline actions not recorded');
    }
  }
}
