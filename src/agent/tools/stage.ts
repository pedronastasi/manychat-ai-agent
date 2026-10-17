import type {
  ActionRecord,
  ActionStatus,
  PerformableAction,
  StagedAction,
} from '../../contracts/agent.ts';
import type { FlowSends, SendFlowAction } from '../flows.ts';

/**
 * Bounds the burst one turn can put through the ManyChat rate limiter, one
 * request per action. Eight fit a flow, a funnel stage, two qualification
 * fields, a tag and three notes (specs/024). Chosen, not measured.
 */
export const MAX_ACTIONS_PER_TURN = 8;

/** `send_flow intro_course_brochure`, `set_field preferred_shift=evening`. */
export function describeAction(action: { tool: string; id: string; value?: string | undefined }) {
  return action.value === undefined
    ? `${action.tool} ${action.id}`
    : `${action.tool} ${action.id}=${action.value}`;
}

/**
 * The entry recorded on the turn: ids and values, never ManyChat names. A
 * note is recorded by its length, never its text (specs/024 § Note text never
 * reaches the record or the logs).
 */
export function recordOf(
  action: PerformableAction,
  status: ActionStatus,
  error?: string,
): ActionRecord {
  return {
    tool: action.tool,
    id: action.id,
    ...(action.tool === 'set_field' ? { value: action.value } : {}),
    ...(action.tool === 'write_note' ? { length: action.text.length } : {}),
    status,
    ...(error === undefined ? {} : { error }),
    ...(action.tool === 'send_flow' && action.origin ? { origin: action.origin } : {}),
    ...(action.tool === 'send_flow' && action.contactAsked ? { contactAsked: true as const } : {}),
  };
}

/**
 * Everything the model staged on one turn. A tool's `execute` writes here and
 * nothing else: no ManyChat write is made inside the model call, because at
 * that point the model has not decided whether to escalate and the guardrails
 * have not run (ADR-0010). The exception is a flow on an inbound turn, sent
 * when called so the reply can follow it (specs/029, ADR-0019); it is kept
 * here with what became of it, in call order.
 *
 * Created by the caller rather than the runner, so what was staged is still
 * known when the model call is aborted and never returns.
 */
export class ActionStage {
  private readonly accepted: StagedAction[] = [];
  private readonly overCap: StagedAction[] = [];
  private readonly sentNow: {
    action: StagedAction;
    records: ActionRecord[];
    /** Settles when ManyChat has answered, so a repeat call waits for it. */
    done: Promise<void>;
    /** Until ManyChat answers; its records are placeholders meanwhile. */
    pending: boolean;
  }[] = [];
  /** Staged and sent entries in the order the model made them, for the record. */
  private readonly order: (StagedAction | { sent: number })[] = [];
  /** Sends the cap does not count: the opening flow is the server's (specs/032). */
  private uncapped = 0;

  /**
   * Whether the action is staged. A repeat of one already staged is. Compared
   * whole rather than by record, since two notes of one length differ.
   */
  stage(action: StagedAction): boolean {
    const key = JSON.stringify(action);
    const same = (existing: StagedAction) => JSON.stringify(existing) === key;
    if (this.accepted.some(same)) return true;
    if (this.full) {
      if (!this.overCap.some(same)) this.overCap.push(action);
      return false;
    }
    this.accepted.push(action);
    this.order.push(action);
    return true;
  }

  /** A flow sent this turn counts against the cap as a staged action does. */
  private get full(): boolean {
    return this.accepted.length + this.sentNow.length - this.uncapped >= MAX_ACTIONS_PER_TURN;
  }

  /**
   * Sends a flow now (specs/029). Returns whether ManyChat accepted it, or
   * `undefined` when it is over the cap and was not sent. A flow already sent
   * this turn is not sent again; its first outcome stands.
   *
   * `first` are actions already staged that must reach ManyChat before the
   * flow: a payment link's `link_sent` would otherwise be overwritten by an
   * earlier funnel write performed after the reply (specs/029 § A payment link
   * takes the turn's stage writes with it). They are sent ahead of it, keep
   * their place in the record, and are no longer staged.
   */
  async send(
    action: SendFlowAction,
    sends: FlowSends,
    first: readonly StagedAction[] = [],
    /** Not counted against the cap: the server's opening flow (specs/032). */
    options: { uncapped?: boolean } = {},
  ): Promise<boolean | undefined> {
    const earlier = this.sentNow.find(
      entry => entry.action.tool === 'send_flow' && entry.action.id === action.id,
    );
    if (earlier) {
      // A repeat made while the first request is in flight (parallel calls in
      // one step) gets its real outcome, not the placeholder.
      await earlier.done;
      return earlier.records[0]?.status === 'performed';
    }
    if (!options.uncapped && this.full) {
      if (!this.overCap.some(entry => entry.tool === 'send_flow' && entry.id === action.id)) {
        this.overCap.push(action);
      }
      return undefined;
    }
    // Reserved before the request, so a second call made while it is in
    // flight neither sends the flow twice nor slips past the cap. Recorded as
    // failed until ManyChat answers: a turn that ends while the request is in
    // flight cannot say it went out.
    const reserve = (entryAction: StagedAction) => ({
      action: entryAction,
      records: [recordOf(entryAction, 'failed', 'no answer before the turn ended')],
      done: Promise.resolve(),
      pending: true,
    });
    const ahead = first.filter(staged => this.accepted.includes(staged)).map(reserve);
    for (const entry of ahead) {
      const at = this.accepted.indexOf(entry.action);
      this.accepted.splice(at, 1);
      this.sentNow.push(entry);
      this.order[this.order.indexOf(entry.action)] = { sent: this.sentNow.length - 1 };
    }
    const entry = reserve(action);
    if (options.uncapped) this.uncapped += 1;
    this.sentNow.push(entry);
    this.order.push({ sent: this.sentNow.length - 1 });
    const done = sends.send([...ahead.map(staged => staged.action), action]).then(groups => {
      [...ahead, entry].forEach((sent, index) => {
        sent.records = groups[index] ?? sent.records;
        sent.pending = false;
      });
    });
    for (const sent of [...ahead, entry]) sent.done = done;
    await done;
    return entry.records[0]?.status === 'performed';
  }

  /**
   * Resolves once every send started this turn has its answer. A call aborted
   * while a request is in flight does not stop the request, so the record waits
   * for it rather than keeping the placeholder (specs/029). Bounded by the
   * client's request timeout.
   */
  async settled(): Promise<void> {
    await Promise.all(this.sentNow.map(entry => entry.done));
  }

  /** Actions sent this turn, whatever became of them. */
  get sent(): readonly {
    action: StagedAction;
    records: readonly ActionRecord[];
    pending: boolean;
  }[] {
    return this.sentNow;
  }

  /** In the order the model staged them, which is the order they are performed in. */
  get staged(): readonly StagedAction[] {
    return this.accepted;
  }

  get dropped(): readonly StagedAction[] {
    return this.overCap;
  }

  /**
   * What an escalated turn still performs: the notes marked `onEscalation`,
   * and only when the model or the confidence threshold escalated (specs/024
   * § A handoff summary survives the escalation it describes).
   */
  survivors(keepNotes: boolean): StagedAction[] {
    return keepNotes
      ? this.accepted.filter(action => action.tool === 'write_note' && action.onEscalation)
      : [];
  }

  /**
   * The turn's record before anything is performed: every accepted action
   * with `status`, then those dropped over the cap. On an escalated turn
   * (`discarded`), an action in `kept` is recorded `staged` instead, since it
   * will still be performed.
   */
  records(status: 'staged' | 'discarded', kept: readonly StagedAction[] = []): ActionRecord[] {
    // A flow already sent keeps its outcome: an escalation cannot recall it.
    return [
      ...this.order.flatMap(entry =>
        'sent' in entry
          ? this.sentNow[entry.sent]!.records
          : [recordOf(entry, kept.includes(entry) ? 'staged' : status)],
      ),
      ...this.overCap.map(action => recordOf(action, 'dropped_over_cap')),
    ];
  }
}
