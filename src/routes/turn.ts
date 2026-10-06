import type { Database } from '../db/client.ts';
import type { AgentRunner, AgentResult } from '../agent/runner.ts';
import type {
  ActionRecord,
  InboundMedia,
  InboundMessage,
  AgentReply,
  MediaKind,
  StagedAction,
  TurnOutcome,
} from '../contracts/agent.ts';
import { NO_TOOLS } from '../contracts/config.ts';
import type { Rules, Tools } from '../contracts/config.ts';
import type { MediaResolver } from '../media/resolver.ts';
import { MediaFailure } from '../media/port.ts';
import { escalationReply } from '../agent/guardrails.ts';
import { ConversationStore } from '../conversation/store.ts';
import {
  BudgetGuard,
  checkKeywords,
  checkTurnCap,
  matchOpeningTrigger,
} from '../conversation/budget.ts';
import { OutboxQueue } from '../outbox/queue.ts';
import { ContactTokens, bindingFor } from '../conversation/tokens.ts';
import type { Binding, ContactTokenWriter } from '../conversation/tokens.ts';
import {
  ActionStage,
  contactActionsFrom,
  courseField,
  knownCourse,
  openingFlow,
  stagesProspect,
} from '../agent/tools.ts';
import type { HistoryTurn } from '../agent/runner.ts';
import type { ContactActions } from '../agent/tools.ts';
import type { ActionPerformer, ContactReader } from '../channels/manychat/client.ts';
import { ContactReads } from '../agent/contact.ts';
import {
  ManyChatApiError,
  ManyChatConnectionError,
  ManyChatResponseError,
} from '../channels/manychat/client.ts';
import { performActions, performedCourse } from '../conversation/actions.ts';
import { NudgeStore } from '../nudge/store.ts';
import { NudgingPerformer } from '../nudge/performer.ts';
import { FlowSends } from '../agent/flows.ts';
import type { TurnLanes } from '../conversation/turns.ts';

const DAY_MS = 86_400_000;

export interface TurnLogger {
  info: (o: object, m: string) => void;
  warn: (o: object, m: string) => void;
  error: (o: object, m: string) => void;
}

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
  /** Reads voice notes, images and videos (specs/020). Without it, all take the fallback. */
  media?: MediaResolver | undefined;
  /**
   * The process's order of each contact's turns (specs/037). Shared by every
   * request; without it, turns run side by side.
   */
  lanes?: TurnLanes | undefined;
}

/** How a turn runs once its contact's order lets it (specs/037). */
interface RunOptions {
  /** The race deadline, from the request's arrival (specs/002). */
  deadlineAt: number;
  /** Its response was already sent, silent: every reply goes to the outbox. */
  late?: boolean;
  /** Called with the work a lost race leaves running, which the turn settles in. */
  onBackground?: (work: Promise<void>) => void;
}

/**
 * What a media turn is recorded as until, and unless, it has a transcript.
 * Never the URL: it opens the contact's file for good (specs/020).
 */
const MEDIA_MARKERS: Record<MediaKind, string> = {
  audio: '[voice note]',
  image: '[image]',
  video: '[video]',
  unsupported: '[media]',
};

/**
 * What the part of a turn run against the deadline produced: the model's
 * answer, or a reply decided without it — a media fallback, a keyword found in
 * a transcript, or media we failed to read.
 */
type Completion =
  | { kind: 'model'; result: AgentResult }
  | { kind: 'decided'; reply: AgentReply; outcome: TurnOutcome };

/**
 * Every line about a turn names its conversation by the row's random ID, and
 * nothing derived from the subscriber ID (ADR-0014).
 */
function withConversation(logger: TurnLogger, conversation: string): TurnLogger {
  return {
    info: (fields, message) => logger.info({ conversation, ...fields }, message),
    warn: (fields, message) => logger.warn({ conversation, ...fields }, message),
    error: (fields, message) => logger.error({ conversation, ...fields }, message),
  };
}

export interface TurnResult {
  reply: AgentReply;
  outcome: TurnOutcome;
  conversationId: string;
  binding: Binding;
  /**
   * Performs the actions staged on an inline turn. The caller runs it once the
   * response has been sent, never before (specs/012 § Actions follow the
   * text). It never throws.
   */
  afterResponse?: () => Promise<void>;
  /**
   * The response carries no message: a flow sent this turn is still playing,
   * and the reply follows it from the outbox (specs/030). `reply` is still
   * set, for the log line.
   */
  silent?: boolean;
}

/**
 * A write that fails is retried by the outbox. Its message is never logged:
 * ManyChat's answer could quote the token it was sent (specs/022 § Error text
 * stays within what C5 and 019 allow).
 */
/**
 * The course the contact arrived through, as the model is told it: one stored
 * from a bound request that the agent never wrote (specs/034 § What counts as
 * prospect intent). An unbound request's course is never stored (specs/028),
 * so it is never one, and a forged request cannot make a contact a prospect.
 */
function advertCourseOf(
  stored: string | undefined,
  turns: readonly { actions: readonly ActionRecord[] | null }[],
  tools: Tools,
): { advertCourse?: string } {
  const field = courseField(tools);
  if (stored === undefined || field === undefined) return {};
  const written = turns.some(turn =>
    (turn.actions ?? []).some(
      action =>
        action.tool === 'set_field' &&
        action.id === field.id &&
        action.value === stored &&
        action.status === 'performed',
    ),
  );
  return written ? {} : { advertCourse: stored };
}

function describeWriteError(error: unknown) {
  if (!(error instanceof Error)) return { name: typeof error };
  return {
    name: error.name,
    ...(error instanceof ManyChatApiError ? { status: error.status } : {}),
    ...(error instanceof ManyChatConnectionError ? { reason: error.reason } : {}),
    ...(error instanceof ManyChatResponseError ? { endpoint: error.endpoint } : {}),
  };
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

  constructor(deps: TurnDeps) {
    this.deps = deps;
    this.store = new ConversationStore(deps.db);
    this.budget = new BudgetGuard(deps.db);
    this.queue = new OutboxQueue(deps.db);
    this.tokens = new ContactTokens(deps.db, deps.tokenWriter);
    this.nudges = new NudgeStore(deps.db);
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

    // Only a turn that enters the contact's history is ordered. One without
    // the token neither waits nor holds the contact's own turns up.
    const known = await this.store.find(inbound.tenantId, inbound.subscriberId);
    const binding = bindingFor(known, inbound.contactToken);
    if (binding === 'unbound' && tokensEnforced) return this.run(inbound, { deadlineAt });

    const slot = lanes.enter(`${inbound.tenantId}:${inbound.subscriberId}`);
    // The next turn goes in once this one has settled: its reply recorded, and
    // queued when the race was lost.
    let background: Promise<void> = Promise.resolve();
    const opts: RunOptions = {
      deadlineAt,
      onBackground: work => {
        background = work;
      },
    };
    const leave = () => void background.then(slot.leave, slot.leave);
    const expired = () => logger.error({ conversation: known?.id }, 'turn wait expired');

    if (slot.waited) {
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<'late'>(resolve => {
        timer = setTimeout(() => resolve('late'), Math.max(0, deadlineAt - Date.now()));
      });
      const waited = await Promise.race([slot.ready, late]);
      clearTimeout(timer);
      if (waited === 'late') {
        void slot.ready
          .then(async ready => {
            if (ready === 'expired') expired();
            await this.run(inbound, { ...opts, late: true });
          })
          .catch(async (error: unknown) => {
            logger.error({ conversation: known?.id, err: String(error) }, 'waiting turn failed');
            await this.handOffLate(inbound);
          })
          .finally(leave);
        // The previous turn has started the conversation by now; its reply,
        // or its holding line, is the contact's answer for the moment.
        const current = known ?? (await this.store.find(inbound.tenantId, inbound.subscriberId));
        logger.info({ conversation: current?.id }, 'turn waits for the previous one');
        return {
          reply: {
            messages: [],
            escalate: false,
            escalation_reason: null,
            confidence: 1,
            closing_question: null,
          },
          outcome: 'deferred',
          conversationId: current?.id ?? '',
          binding,
          silent: true,
        };
      }
      if (waited === 'expired') expired();
    }
    try {
      return await this.run(inbound, opts);
    } finally {
      leave();
    }
  }

  /**
   * A turn that failed after its silent response, which no error handler can
   * answer any more: the handoff goes through the outbox instead, as the
   * route's error handler would have sent it (C6, specs/037).
   */
  private async handOffLate(inbound: InboundMessage): Promise<void> {
    const { rules, logger } = this.deps;
    try {
      const conversation = await this.store.find(inbound.tenantId, inbound.subscriberId);
      await this.queue.enqueue({
        tenantId: inbound.tenantId,
        subscriberId: inbound.subscriberId,
        conversationId: conversation?.id ?? null,
        reply: escalationReply('low_confidence', rules.messages.escalation),
      });
      if (conversation) {
        await this.store.markEscalated(conversation.id);
        await this.nudges.cancel(conversation.id, 'escalated');
      }
    } catch (error) {
      logger.error({ err: String(error) }, 'waiting turn handoff not queued');
    }
  }

  private async run(inbound: InboundMessage, opts: RunOptions): Promise<TurnResult> {
    const { rules, tokensEnforced } = this.deps;
    const now = new Date();

    // The shared secret proved the caller; the token proves the contact
    // (specs/019). Without it the request is answered from its own message
    // alone, and neither reads nor extends the contact's history.
    const known = await this.store.find(inbound.tenantId, inbound.subscriberId);
    const binding = bindingFor(known, inbound.contactToken);
    // During the rollout a request without the token is treated as it was
    // before specs/019, so nobody loses context before their token lands.
    const bound = binding !== 'unbound' || !tokensEnforced;
    // A contact with no token yet starts their history here: whatever came
    // before was never proved to be theirs.
    const readsHistory = binding === 'bound' || !tokensEnforced;

    // Only a bound turn counts toward the cap or moves the idle gap; the
    // per-contact rate limit bounds the rest (specs/019 § Only bound turns
    // enter history and the turn cap).
    const conversation =
      !bound && known
        ? known
        : await this.store.startTurn(
            {
              tenantId: inbound.tenantId,
              subscriberId: inbound.subscriberId,
              channel: inbound.channel,
              idleResetHours: rules.idleResetHours,
            },
            now,
          );
    const logger = withConversation(this.deps.logger, conversation.id);
    const turn = { bound };

    /**
     * Whether this turn's reply has to go through the outbox behind the
     * contact's: a reply to them is still queued, or this turn's response was
     * already sent (specs/037 § A reply never overtakes an earlier one).
     */
    const mustQueue = async () =>
      opts.late === true ||
      (await this.queue.hasQueuedReply(inbound.tenantId, inbound.subscriberId));

    /**
     * Answers a turn decided without the model: inline, or behind the
     * contact's queued reply with a silent response.
     */
    const answer = async (result: TurnResult): Promise<TurnResult> => {
      if (!(await mustQueue())) return result;
      try {
        await this.queue.enqueue({
          tenantId: inbound.tenantId,
          subscriberId: inbound.subscriberId,
          conversationId: conversation.id,
          reply: result.reply,
        });
      } catch (error) {
        // A late turn's response is gone, so its reply has nowhere else to go.
        if (opts.late) throw error;
        // Early is better than never: the reply goes out now.
        logger.error({ err: String(error) }, 'failed to queue reply behind the previous one');
        return result;
      }
      logger.info({ path: 'outbox' }, 'reply queued behind the previous one');
      return { ...result, silent: true };
    };

    // The request's course is ManyChat's value now, which already holds every
    // write this service performed, so it wins over the one kept here
    // (specs/028). It narrows this turn's flows bound or not, but only a
    // bound request may store it: an unbound one must not change the
    // contact's own state (specs/019). The kept one is checked too, since a
    // reload may have dropped its course from the catalog.
    const tools = this.deps.tools ?? NO_TOOLS;
    const keptCourse = knownCourse(known?.course, tools);
    const requestCourse = knownCourse(inbound.course, tools);
    if (bound && requestCourse !== undefined && requestCourse !== keptCourse) {
      await this.store.setCourse(conversation.id, requestCourse);
    }
    const course = {
      course: requestCourse ?? keptCourse,
      // The stage is not reset: the model confirms the course instead.
      courseChangedFrom:
        requestCourse !== undefined && keptCourse !== undefined && requestCourse !== keptCourse
          ? keptCourse
          : undefined,
    };
    // The contact wrote, so the follow-up waiting for their silence is moot
    // (specs/025). Any message, bound or not: it errs toward sending nothing.
    await this.nudges.cancel(conversation.id, 'contact_replied');
    const media = inbound.media;
    const userTurnId = await this.store.recordUserMessage(
      conversation.id,
      media ? MEDIA_MARKERS[media.kind] : inbound.text,
      { bound, mediaKind: media?.kind },
    );

    // Watched as a share of all turns: a flow that stopped sending the field
    // shows up here and nowhere else.
    if (binding === 'unbound') logger.info({ binding, enforced: tokensEnforced }, 'unbound turn');

    // A contact without a token gets one, and so does an unbound request,
    // which repairs a cleared field or a lost write. It goes only to the real
    // contact's field, so a forger gains nothing by triggering it.
    if (binding !== 'bound') {
      const issued = await this.tokens.issue(
        {
          tenantId: inbound.tenantId,
          subscriberId: inbound.subscriberId,
          conversationId: conversation.id,
        },
        now,
      );
      issued?.written.catch((error: unknown) => {
        logger.error({ error: describeWriteError(error) }, 'contact token write failed');
      });
    }

    // An unbound request must not change the contact's own state. Any
    // escalation cancels a waiting nudge, though: it can only err toward
    // sending nothing (specs/025).
    const markEscalated = async () => {
      await this.nudges.cancel(conversation.id, 'escalated');
      if (bound) await this.store.markEscalated(conversation.id);
    };

    // The channel flow's opening sentinel. Fully determined - no contact input
    // to interpret and exactly one correct reply - so it never reaches the
    // model: instant, free, and it cannot be lost to a low-confidence
    // self-report. Checked before the guards because the sentinel is emitted by
    // the flow rather than typed by a contact, and the caps below exist to
    // bound model spend, which a scripted reply does not incur. Media never
    // matches: the sentinel is sent by the flow, not spoken by a contact.
    const opening = media ? null : matchOpeningTrigger(inbound.text, rules);
    if (opening) {
      await this.store.recordAgentReply(conversation.id, opening, 'answered_scripted', turn);
      logger.info({ outcome: 'answered_scripted' }, 'scripted opening sent');
      return answer({
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
        binding,
      });
    }

    // Pre-model guards: each denial costs nothing and fails toward a human (C6).
    // A media turn has no words to match until it is transcribed, inside the
    // race; the rest need none, so a contact over a limit costs no download.
    const guards = [
      media ? { allowed: true as const } : checkKeywords(inbound.text, rules),
      bound ? checkTurnCap(conversation.turnCount, rules) : { allowed: true as const },
      await this.budget.checkRateLimit(inbound.tenantId, inbound.subscriberId, rules),
      await this.budget.checkBudget(inbound.tenantId, rules),
    ];
    const denied = guards.find(guard => !guard.allowed);
    if (denied && !denied.allowed) {
      const reply = escalationReply(denied.reason, rules.messages.escalation);
      await this.store.recordAgentReply(
        conversation.id,
        reply.messages[0]!,
        'escalated_precheck',
        turn,
      );
      await markEscalated();
      logger.info({ reason: denied.reason, detail: denied.detail }, 'turn escalated before model');
      return answer({
        reply,
        outcome: 'escalated_precheck',
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
            ...course,
            openingDue,
            ...advertCourseOf(
              bound ? (requestCourse ?? keptCourse) : keptCourse,
              actionHistory,
              tools,
            ),
          }
        : undefined;

    // What the model stages this turn. Held here rather than in the runner, so
    // it is still known when the call is aborted and never returns.
    const stage = new ActionStage();

    // The contact's record holds their own words in its notes, so a turn that
    // may not read their history may not read it either (specs/024).
    const reads =
      this.deps.contacts && readsHistory
        ? new ContactReads({
            reader: this.deps.contacts,
            subscriberId: inbound.subscriberId,
            logger,
          })
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

    /**
     * Staged actions are performed only when the final reply, after the
     * guardrails, does not escalate. Every other ending lands here (specs/012
     * § Guardrails run before any action is performed), except the
     * `onEscalation` notes in `kept` (specs/024).
     */
    const discard = (kept: readonly StagedAction[] = []) => {
      const discarded = stage.staged.length - kept.length;
      if (discarded > 0) logger.info({ discarded }, 'staged actions discarded');
      return stage.staged.length + stage.dropped.length + stage.sent.length > 0
        ? stage.records('discarded', kept)
        : undefined;
    };

    /**
     * What a settled turn performs once its text is delivered: everything
     * staged when it did not escalate, and on an escalation the model or the
     * confidence threshold made, the notes that outlive it (specs/024 § A
     * handoff summary survives the escalation it describes).
     */
    const performable = (result: AgentResult): readonly StagedAction[] =>
      result.reply.escalate
        ? stage.survivors(result.escalatedBy === 'model' || result.escalatedBy === 'confidence')
        : stage.staged;

    const abort = new AbortController();
    const abortTimer = setTimeout(() => abort.abort(), this.deps.modelAbortMs);

    // From the request's arrival, so a wait for the contact's previous turn
    // counts against it (specs/037).
    let deadlineTimer: NodeJS.Timeout | undefined;
    const { deadlineAt } = opts;
    const deadline = new Promise<'deadline'>(resolve => {
      deadlineTimer = setTimeout(() => resolve('deadline'), Math.max(0, deadlineAt - Date.now()));
    });

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
    const answered: Promise<Completion> = media
      ? this.readMedia(media, {
          userTurnId,
          tenantId: inbound.tenantId,
          history: priorHistory,
          signal: abort.signal,
          logger,
          stage,
          contact,
          reads,
          flows,
          beforeFlow: sendOpening,
        })
      : this.deps.runner
          .run({
            text: inbound.text,
            history: priorHistory,
            signal: abort.signal,
            stage,
            contact,
            reads,
            flows,
            beforeFlow: sendOpening,
          })
          .then(result => ({ kind: 'model' as const, result }));
    // Inside the race, as a flow the model calls is (specs/029): a send that
    // runs past the deadline is deferred with the reply it precedes.
    const work: Promise<Completion> = sendOpening
      ? answered.then(async done => {
          if (done.kind === 'model' && !done.result.reply.escalate) await sendOpening();
          return done;
        })
      : answered;
    const completion = work
      .then(done => ({ kind: 'done' as const, done }))
      .catch((error: unknown) => ({ kind: 'error' as const, error }));

    // A turn whose response already went out has no race left to win.
    const winner = opts.late ? ('deadline' as const) : await Promise.race([completion, deadline]);

    /**
     * Persists usage, spend and what was staged. Shared by the inline and
     * deferred paths. Returns the agent turn's id.
     */
    const settle = async (result: AgentResult, outcome: TurnOutcome) => {
      // Null when no tool was offered, so it reads apart from "offered, none
      // chosen" (specs/012 § Every staged action is recorded on its turn).
      // A flow the server sent is recorded even when the model was offered no
      // tool: the opening may be a tenant's only flow (specs/032).
      const actions =
        !result.toolsOffered && stage.sent.length === 0
          ? null
          : result.reply.escalate
            ? (discard(performable(result)) ?? [])
            : stage.records('staged');
      const turnId = await this.store.recordAgentReply(
        conversation.id,
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
          },
          actions,
        },
      );
      const tokens = (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0);
      await this.budget.recordSpend(inbound.tenantId, tokens, result.usage.costUsd);
      if (result.reply.escalate) await markEscalated();
      return turnId;
    };

    /**
     * Records a reply decided without the model. Its own outcome is kept even
     * when it lands after the deadline: `deferred` describes a slow model, and
     * a fallback recorded as one could not be counted as a fallback.
     */
    const conclude = async (decided: Extract<Completion, { kind: 'decided' }>) => {
      await this.store.recordAgentReply(
        conversation.id,
        decided.reply.messages.join('\n'),
        decided.outcome,
        turn,
      );
      if (decided.reply.escalate) await markEscalated();
    };

    /**
     * Delivers a settled turn's reply after the flows it sent have played
     * (specs/030 § The reply waits for the flow to play): inline once they
     * end, when that is before the deadline, and otherwise from the outbox at
     * that time, with a silent response now. `actions` go with it to the
     * outbox, in place of `afterResponse`.
     */
    const deliver = async (
      result: TurnResult,
      actions?: { staged: readonly StagedAction[]; turnId: string },
    ): Promise<TurnResult> => {
      const until = flows.playsUntil;
      const now = Date.now();
      const queue = await mustQueue();
      if (until <= now && !queue) return result;
      if (until <= deadlineAt && !queue) {
        logger.info({ heldMs: until - now, path: 'inline' }, 'reply held for flow');
        await new Promise(resolve => setTimeout(resolve, until - now));
        return result;
      }
      try {
        await this.queue.enqueue({
          tenantId: inbound.tenantId,
          subscriberId: inbound.subscriberId,
          conversationId: conversation.id,
          reply: result.reply,
          actions,
          notBefore: until > now ? new Date(until) : undefined,
        });
      } catch (error) {
        // Early is better than never: the reply goes out now, inside the flow.
        logger.error({ err: String(error) }, 'failed to hold reply for flow');
        return result;
      }
      if (until > now) {
        logger.info({ heldMs: until - now, path: 'outbox' }, 'reply held for flow');
      } else {
        logger.info({ path: 'outbox' }, 'reply queued behind the previous one');
      }
      return {
        reply: result.reply,
        outcome: result.outcome,
        conversationId: result.conversationId,
        binding: result.binding,
        silent: true,
      };
    };

    if (winner === 'deadline') {
      clearTimeout(deadlineTimer);
      // A flow still playing is the contact's wait: a holding line now would
      // land inside it (specs/030 § A flow still playing is the holding line).
      // So would one while a reply to the contact is still queued: it is on
      // its way (specs/037).
      const silent = flows.playsUntil > Date.now() || (await mustQueue());
      const holding: AgentReply = {
        messages: [rules.messages.acknowledgement],
        escalate: false,
        escalation_reason: null,
        confidence: 1,
        // A holding line while the real reply completes into the outbox.
        closing_question: null,
      };
      const notBefore = () =>
        flows.playsUntil > Date.now() ? new Date(flows.playsUntil) : undefined;

      // The in-flight call is NOT cancelled: those tokens are already paid for,
      // and the answer is still wanted. It completes into the outbox instead.
      //
      // abortTimer deliberately stays armed. MODEL_ABORT_MS is the outer bound
      // on a runaway call, and this is the only path where a call can outlive
      // the request — so clearing it here would leave the deferred call with no
      // bound at all. It is cleared below, when the call actually settles.
      const settling = completion.then(async outcome => {
        clearTimeout(abortTimer);
        try {
          if (outcome.kind === 'error') {
            // MODEL_ABORT_MS lands here, with whatever it had staged, and
            // perhaps a flow request still in flight.
            await stage.settled();
            const actions = discard();
            logger.error({ err: String(outcome.error) }, 'deferred model call failed');
            // A flow sent during the call has reached the contact, so the turn
            // is recorded with it: otherwise the next turn would not know it
            // went out, and could send a send-once flow again (specs/029 § An
            // escalation cannot recall a flow). Recorded as the holding line
            // the contact was actually given.
            if (stage.sent.length > 0) {
              await this.store.recordAgentReply(
                conversation.id,
                rules.messages.acknowledgement,
                'error',
                { ...turn, actions },
              );
            }
            // A silent response gave the contact nothing yet, so the holding
            // line it held back goes out now, after the flow (specs/030).
            if (silent) {
              await this.queue.enqueue({
                tenantId: inbound.tenantId,
                subscriberId: inbound.subscriberId,
                conversationId: conversation.id,
                reply: holding,
                notBefore: notBefore(),
              });
            }
            return;
          }
          const { done } = outcome;
          let deferred: { staged: readonly StagedAction[]; turnId: string } | undefined;
          if (done.kind === 'decided') {
            await conclude(done);
          } else {
            const turnId = await settle(done.result, 'deferred');
            // Deferred with the reply, never dropped from it: the worker
            // performs them once the text is delivered (specs/012 § The whole
            // loop runs inside the race).
            const staged = performable(done.result);
            if (staged.length > 0) deferred = { staged, turnId };
            // The inline path logs these below. Without the same line here a
            // guardrail or a failed call on a deferred turn left no trace in
            // the logs at all, which is most of them whenever the model runs
            // slow.
            if (done.result.interventions.length > 0) {
              logger.info(
                { interventions: done.result.interventions, deferred: true },
                'guardrails intervened',
              );
            }
          }
          await this.queue.enqueue({
            tenantId: inbound.tenantId,
            subscriberId: inbound.subscriberId,
            conversationId: conversation.id,
            reply: done.kind === 'decided' ? done.reply : done.result.reply,
            actions: deferred,
            // A flow the call sent, before or after the deadline, plays first.
            notBefore: notBefore(),
          });
        } catch (error) {
          logger.error({ err: String(error) }, 'failed to enqueue deferred reply');
          // A late turn's response was silent, so this is all the contact
          // would get: nothing (C6).
          if (opts.late) await this.handOffLate(inbound);
        }
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
    clearTimeout(deadlineTimer);

    if (winner.kind === 'error') {
      logger.error({ err: String(winner.error) }, 'model call failed');
      const reply = escalationReply('low_confidence', rules.messages.escalation);
      await this.store.recordAgentReply(conversation.id, reply.messages[0]!, 'error', {
        ...turn,
        actions: discard(),
      });
      await markEscalated();
      return deliver({ reply, outcome: 'error', conversationId: conversation.id, binding });
    }

    const { done } = winner;
    if (done.kind === 'decided') {
      await conclude(done);
      return answer({
        reply: done.reply,
        outcome: done.outcome,
        conversationId: conversation.id,
        binding,
      });
    }

    // A failed call and a deliberate escalation both carry `escalate: true` and
    // the same tenant message, so without the first branch the turns table
    // recorded a dead model call as a decision the model made.
    const outcome: TurnOutcome = done.result.modelError
      ? 'error'
      : done.result.reply.escalate
        ? 'escalated_model'
        : 'answered_inline';
    const turnId = await settle(done.result, outcome);
    if (done.result.interventions.length > 0) {
      logger.info({ interventions: done.result.interventions }, 'guardrails intervened');
    }
    const staged = performable(done.result);
    return deliver(
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
      const course = performedCourse(staged, outcomes);
      if (course !== undefined) await this.store.setCourse(conversationId, course);
    } catch (error) {
      logger.error({ err: String(error) }, 'inline actions not recorded');
    }
  }

  /**
   * The media half of a turn (specs/020): download, split and transcribe,
   * then the keyword check the transcript makes possible, then the model.
   */
  private async readMedia(
    media: InboundMedia,
    ctx: {
      userTurnId: string;
      tenantId: string;
      history: HistoryTurn[];
      signal: AbortSignal;
      logger: TurnLogger;
      stage: ActionStage;
      contact: ContactActions | undefined;
      reads: ContactReads | undefined;
      flows: FlowSends | undefined;
      beforeFlow: (() => Promise<void>) | undefined;
    },
  ): Promise<Completion> {
    const { rules } = this.deps;
    const { logger } = ctx;

    let resolved;
    try {
      resolved = this.deps.media
        ? await this.deps.media.resolve(media, ctx.signal)
        : ({ status: 'fallback', reason: 'unsupported', costUsd: 0 } as const);
    } catch (error) {
      // A failed download, transcription or frame extraction is not something
      // the contact can fix, and asking them to type would blame them for it.
      // The message names the step, never the URL.
      logger.error(
        {
          media: media.kind,
          reason: error instanceof MediaFailure ? error.reason : 'unknown',
          err: error instanceof Error ? error.message : String(error),
        },
        'media unreadable',
      );
      return {
        kind: 'decided',
        reply: escalationReply('low_confidence', rules.messages.escalation),
        outcome: 'error',
      };
    }

    // Owed whatever happens next: an empty transcript was still transcribed.
    if (resolved.costUsd > 0) await this.budget.recordSpend(ctx.tenantId, 0, resolved.costUsd);

    if (resolved.status === 'fallback') {
      logger.info({ media: media.kind, reason: resolved.reason }, 'media fallback');
      return this.mediaFallback();
    }

    const { transcript, images } = resolved;
    if (transcript !== null) {
      // From here the transcript is the contact's message, as if typed: it
      // enters history, and it is matched against the keywords.
      await this.store.replaceUserMessage(ctx.userTurnId, transcript);
      const keyword = checkKeywords(transcript, rules);
      if (!keyword.allowed) {
        logger.info(
          { reason: keyword.reason, detail: keyword.detail },
          'turn escalated before model',
        );
        return {
          kind: 'decided',
          reply: escalationReply(keyword.reason, rules.messages.escalation),
          outcome: 'escalated_precheck',
        };
      }
    }

    logger.info(
      { media: media.kind, images: images.length, transcript: transcript !== null },
      'media read',
    );
    const result = await this.deps.runner.run({
      text: transcript ?? '',
      history: ctx.history,
      signal: ctx.signal,
      stage: ctx.stage,
      contact: ctx.contact,
      reads: ctx.reads,
      flows: ctx.flows,
      beforeFlow: ctx.beforeFlow,
      media: {
        // `unsupported` never resolves; it always takes the fallback above.
        kind: media.kind as 'audio' | 'image' | 'video',
        images,
        transcript: transcript !== null,
      },
    });
    return { kind: 'model', result };
  }

  /**
   * The tenant's "please type it" reply, or a handoff when the tenant has not
   * written one: a contact who cannot be asked to type goes to a person (C6).
   */
  private mediaFallback(): Completion {
    const { messages } = this.deps.rules;
    if (!messages.mediaFallback) {
      return {
        kind: 'decided',
        reply: escalationReply('out_of_scope', messages.escalation),
        outcome: 'escalated_precheck',
      };
    }
    return {
      kind: 'decided',
      reply: {
        messages: [messages.mediaFallback],
        escalate: false,
        escalation_reason: null,
        confidence: 1,
        // Tenant copy that already asks what it needs to.
        closing_question: null,
      },
      outcome: 'media_fallback',
    };
  }
}
