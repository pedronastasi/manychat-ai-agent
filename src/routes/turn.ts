import type { Database } from '../db/client.ts';
import type { AgentRunner, AgentResult } from '../agent/runner.ts';
import type { InboundMessage, StagedAction } from '../contracts/agent.ts';
import { NO_TOOLS } from '../contracts/config.ts';
import type { Rules, Tools } from '../contracts/config.ts';
import type { MediaResolver } from '../media/resolver.ts';
import { escalationReply } from '../agent/guardrails.ts';
import { ConversationStore } from '../conversation/store.ts';
import { BudgetGuard, checkKeywords, matchOpeningTrigger } from '../conversation/budget.ts';
import { OutboxQueue } from '../outbox/queue.ts';
import { ContactTokens } from '../conversation/tokens.ts';
import type { Binding, ContactTokenWriter } from '../conversation/tokens.ts';
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
import { advertOfferingOf, offeringOf } from '../turn/context.ts';
import { TurnAdmission, bindingOf } from '../turn/admission.ts';
import { Prechecks } from '../turn/prechecks.ts';
import { raceDeadline } from '../turn/race.ts';
import { modelOutcomeOf, plainReply } from '../turn/replies.ts';
import type { Completion, Settled } from '../turn/completion.ts';
import { DeferredSettlement } from '../turn/deferred.ts';
import { withConversation } from '../turn/logger.ts';
import type { TurnLogger } from '../turn/logger.ts';
import { MediaReader } from '../turn/media.ts';
import { TurnRecorder } from '../turn/recorder.ts';
import { ContactOutbox, ReplyDelivery } from '../turn/delivery.ts';
import type { TurnResult } from '../turn/result.ts';

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

/** How a turn runs once its contact's order lets it (specs/037). */
interface RunOptions {
  /** The race deadline, from the request's arrival (specs/002). */
  deadlineAt: number;
  /** Its response was already sent, silent: every reply goes to the outbox. */
  late?: boolean;
  /** Called with the work a lost race leaves running, which the turn settles in. */
  onBackground?: (work: Promise<void>) => void;
  /**
   * Whether the contact has written again since this turn started, and a
   * later turn of theirs will answer them (specs/046).
   */
  followed?: () => boolean;
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
   * Runs the turn once the contact's previous one has settled (specs/037 §
   * Turns that enter history run one at a time). A turn still waiting at its
   * deadline is answered silently now and runs when its turn comes, through
   * the outbox.
   */
  async handle(inbound: InboundMessage): Promise<TurnResult> {
    const { lanes, tokensEnforced, logger } = this.deps;
    const deadlineAt = Date.now() + this.deps.raceDeadlineMs;
    if (!lanes) return this.run(inbound, { deadlineAt });

    // Its place is taken on arrival, before any read can reorder two requests.
    const slot = lanes.enter(`${inbound.tenantId}:${inbound.subscriberId}`);
    // Only a turn that enters the contact's history is ordered. One without
    // the token gives its place back at once: it neither waits nor holds the
    // contact's own turns up.
    // A failed read gives the place back, or the contact's next turn would
    // wait out the whole bound for a turn that never ran.
    const known = await this.store
      .find(inbound.tenantId, inbound.subscriberId)
      .catch((error: unknown) => {
        slot.leave();
        throw error;
      });
    const binding = bindingOf(known, inbound, this.deps.channel);
    if (binding === 'unbound' && tokensEnforced) {
      slot.leave();
      return this.run(inbound, { deadlineAt });
    }
    // This turn will answer whatever the contact wrote before it, so a turn
    // ahead of it may leave its message to this one (specs/046). Only a turn
    // that reads the contact's history can: a first turn while tokens are
    // enforced reads none (specs/019), and the opening sentinel's scripted
    // reply answers nothing the contact wrote.
    const readsHistory = binding === 'bound' || !tokensEnforced;
    const answers = inbound.media || !matchOpeningTrigger(inbound.text, this.deps.rules);
    if (readsHistory && answers) slot.claim();
    // The next turn goes in once this one has settled: its reply recorded, and
    // queued when the race was lost.
    let background: Promise<void> = Promise.resolve();
    const opts: RunOptions = {
      deadlineAt,
      onBackground: work => {
        background = work;
      },
      followed: slot.followed,
    };
    const leave = () => void background.then(slot.leave, slot.leave);
    const expired = () => logger.error({ conversation: known?.id }, 'turn wait expired');

    /**
     * Whether this turn only records its message, which a later turn of the
     * contact answers (specs/046): the contact wrote again while it waited for
     * their previous turn, or, with a burst window, before that window passed
     * in silence (specs/047). Only a turn that reads history folds: any other
     * runs, and is bound by the token state it finds then (specs/019).
     */
    const folds = async (): Promise<boolean> => {
      if (!readsHistory || !this.foldable(inbound)) return false;
      if (slot.waited && slot.followed()) return true;
      const windowMs = this.deps.rules.burstWindowMs;
      return windowMs > 0 && (await slot.quiet(windowMs));
    };
    // The wait for the previous turn and the burst window both count against
    // the deadline (C7): a turn still deciding at it is answered silently now.
    const decided = (async () => {
      if (slot.waited && (await slot.ready) === 'expired') expired();
      return (await folds()) ? ('fold' as const) : ('run' as const);
    })();

    const first = await raceDeadline(decided, deadlineAt);
    if (first === 'deadline') {
      void decided
        .then(async decision => {
          if (decision === 'fold') await this.fold(inbound, binding);
          else await this.run(inbound, { ...opts, late: true });
        })
        .catch(async (error: unknown) => {
          logger.error({ conversation: known?.id, err: String(error) }, 'waiting turn failed');
          await this.outboxFor(inbound).handOffSilent();
        })
        .finally(leave);
      // The previous turn has started the conversation by now; its reply,
      // or its holding line, is the contact's answer for the moment.
      const current = known ?? (await this.store.find(inbound.tenantId, inbound.subscriberId));
      logger.info({ conversation: current?.id }, 'turn answered silently while it waits');
      return {
        reply: plainReply([]),
        outcome: 'deferred',
        conversationId: current?.id ?? '',
        binding,
        silent: true,
      };
    }
    try {
      if (first === 'fold') return await this.fold(inbound, binding);
      return await this.run(inbound, opts);
    } finally {
      leave();
    }
  }

  /**
   * Whether a message can be left to the contact's next turn to answer
   * (specs/046 § A waiting message is folded into the next one). The next
   * turn reads it from history, so it must be text the model can read there,
   * and nothing a check of its own words would have answered differently.
   */
  private foldable(inbound: InboundMessage): boolean {
    const { rules } = this.deps;
    return (
      !inbound.media &&
      !matchOpeningTrigger(inbound.text, rules) &&
      checkKeywords(inbound.text, rules).allowed
    );
  }

  /**
   * Records a message the contact's next turn answers, and nothing else: no
   * model call, no reply, and a silent response (specs/046).
   */
  private async fold(inbound: InboundMessage, binding: Binding): Promise<TurnResult> {
    const conversation = await this.store.startTurn(
      {
        tenantId: inbound.tenantId,
        subscriberId: inbound.subscriberId,
        channel: inbound.channel,
        idleResetHours: this.deps.rules.idleResetHours,
      },
      new Date(),
    );
    await this.nudges.cancel(conversation.id, 'contact_replied');
    await this.store.recordUserMessage(conversation.id, inbound.text, { bound: true });
    withConversation(this.deps.logger, conversation.id).info(
      { outcome: 'folded' },
      'message folded into the next turn',
    );
    return {
      reply: plainReply([]),
      outcome: 'folded',
      conversationId: conversation.id,
      binding,
      silent: true,
    };
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

    /**
     * Whether the model's reply is dropped because the contact kept writing
     * while it ran, and their next turn answers everything they wrote
     * (specs/046 § A reply the contact wrote past is superseded). Never one
     * that sent a flow, which has reached them, or that escalates, and never
     * a media turn's: history keeps only its marker, so the turn behind could
     * not see what the contact sent.
     */
    const superseded = (result: AgentResult) =>
      rules.foldBursts &&
      !media &&
      opts.followed?.() === true &&
      stage.sent.length === 0 &&
      !result.reply.escalate &&
      !result.modelError;

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
