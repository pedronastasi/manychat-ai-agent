import type { InboundMessage } from '../contracts/agent.ts';
import type { Rules } from '../contracts/config.ts';
import { matchOpeningTrigger } from '../conversation/budget.ts';
import type { ConversationStore } from '../conversation/store.ts';
import type { Binding } from '../conversation/tokens.ts';
import type { TurnLanes } from '../conversation/turns.ts';
import { bindingOf } from './admission.ts';
import { foldable } from './fold.ts';
import type { TurnLogger } from './logger.ts';
import { raceDeadline } from './race.ts';
import { plainReply } from './replies.ts';
import type { TurnResult } from './result.ts';

/** How a turn runs once its contact's order lets it (specs/037). */
export interface RunOptions {
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

/** What an ordered turn can become once its place comes up. */
export interface OrderedTurn {
  run: (opts: RunOptions) => Promise<TurnResult>;
  fold: (binding: Binding) => Promise<TurnResult>;
  /** Hands a turn that failed after its silent response to a person (C6). */
  handOffSilent: () => Promise<void>;
}

export interface TurnOrderDeps {
  /** The process's order of each contact's turns. Shared by every request. */
  lanes: TurnLanes;
  store: ConversationStore;
  rules: Rules;
  tokensEnforced: boolean;
  /** The plugin channel the turn arrived on (specs/038); ManyChat when absent. */
  channel?: string | undefined;
  logger: TurnLogger;
}

/**
 * Runs a contact's turns that enter history one at a time (specs/037 § Turns
 * that enter history run one at a time), folds a message the contact's next
 * turn will answer (specs/046, 047), and answers a turn still waiting at its
 * deadline silently, to run when its turn comes, through the outbox.
 */
export class TurnOrder {
  private readonly deps: TurnOrderDeps;

  constructor(deps: TurnOrderDeps) {
    this.deps = deps;
  }

  async handle(
    inbound: InboundMessage,
    deadlineAt: number,
    turn: OrderedTurn,
  ): Promise<TurnResult> {
    const { lanes, store, rules, tokensEnforced, channel, logger } = this.deps;

    // Its place is taken on arrival, before any read can reorder two requests.
    const slot = lanes.enter(`${inbound.tenantId}:${inbound.subscriberId}`);
    // Only a turn that enters the contact's history is ordered. One without
    // the token gives its place back at once: it neither waits nor holds the
    // contact's own turns up.
    // A failed read gives the place back, or the contact's next turn would
    // wait out the whole bound for a turn that never ran.
    const known = await store
      .find(inbound.tenantId, inbound.subscriberId)
      .catch((error: unknown) => {
        slot.leave();
        throw error;
      });
    const binding = bindingOf(known, inbound, channel);
    if (binding === 'unbound' && tokensEnforced) {
      slot.leave();
      return turn.run({ deadlineAt });
    }
    // This turn will answer whatever the contact wrote before it, so a turn
    // ahead of it may leave its message to this one (specs/046). Only a turn
    // that reads the contact's history can: a first turn while tokens are
    // enforced reads none (specs/019), and the opening sentinel's scripted
    // reply answers nothing the contact wrote.
    const readsHistory = binding === 'bound' || !tokensEnforced;
    const answers = inbound.media || !matchOpeningTrigger(inbound.text, rules);
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
      if (!readsHistory || !foldable(inbound, rules)) return false;
      if (slot.waited && slot.followed()) return true;
      const windowMs = rules.burstWindowMs;
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
          if (decision === 'fold') await turn.fold(binding);
          else await turn.run({ ...opts, late: true });
        })
        .catch(async (error: unknown) => {
          logger.error({ conversation: known?.id, err: String(error) }, 'waiting turn failed');
          await turn.handOffSilent();
        })
        .finally(leave);
      // The previous turn has started the conversation by now; its reply,
      // or its holding line, is the contact's answer for the moment.
      const current = known ?? (await store.find(inbound.tenantId, inbound.subscriberId));
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
      if (first === 'fold') return await turn.fold(binding);
      return await turn.run(opts);
    } finally {
      leave();
    }
  }
}
