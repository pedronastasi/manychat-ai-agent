import type { ActionRecord, StagedAction } from '../contracts/agent.ts';
import type { ActionPerformer } from '../channels/manychat/client.ts';
import type { Tools } from '../contracts/config.ts';
import { performActions } from '../conversation/actions.ts';
import type { ActionLogger } from '../conversation/actions.ts';

export type SendFlowAction = Extract<StagedAction, { tool: 'send_flow' }>;

/**
 * A turn's flow sends, made when the model calls `send_flow` rather than
 * after its reply (specs/029). The model is told whether the flow went out
 * and writes its reply after it, so the reply, and its closing question,
 * reach the contact after the flow's content. ManyChat answering is not the
 * flow finishing, so it also keeps when the last flow sent ends, by the
 * flow's own `settleSeconds`, and the reply waits for that (specs/030).
 *
 * Built by the turn handler for an inbound turn only: a nudge turn may
 * decline by escalating, and a flow already sent would then arrive alone
 * (specs/025), so its flows stay staged.
 */
export class FlowSends {
  private readonly performer: ActionPerformer;
  private readonly subscriberId: string;
  private readonly logger: ActionLogger;
  private readonly settleSeconds: ReadonlyMap<string, number>;
  private readonly clock: () => number;
  private until = 0;

  constructor(opts: {
    performer: ActionPerformer;
    subscriberId: string;
    logger: ActionLogger;
    /** Where each flow's `settleSeconds` is read from (specs/030). */
    tools?: Tools | undefined;
    clock?: () => number;
  }) {
    this.performer = opts.performer;
    this.subscriberId = opts.subscriberId;
    this.logger = opts.logger;
    this.settleSeconds = new Map(
      (opts.tools?.flows ?? []).map(flow => [flow.id, flow.settleSeconds ?? 0]),
    );
    this.clock = opts.clock ?? Date.now;
  }

  /**
   * Sends `actions` in order, each with its follow-ons (the payment link's
   * `link_sent` write and that stage's event, specs/023 and 027), one attempt
   * each, and returns what became of them, one group per action.
   */
  async send(actions: readonly StagedAction[]): Promise<ActionRecord[][]> {
    const groups = await performActions(this.performer, this.subscriberId, actions, this.logger);
    // Counted from ManyChat's answer: it starts playing the flow then
    // (specs/030 § The reply waits for the flow to play).
    const answeredAt = this.clock();
    actions.forEach((action, index) => {
      if (action.tool !== 'send_flow' || groups[index]?.[0]?.status !== 'performed') return;
      const seconds = this.settleSeconds.get(action.id) ?? 0;
      if (seconds > 0) this.until = Math.max(this.until, answeredAt + seconds * 1000);
    });
    return groups;
  }

  /**
   * When the last flow sent this turn has finished playing, as an epoch
   * millisecond, or 0 when none was sent or none declared a settle time. A
   * reply delivered before then lands inside the flow (specs/030).
   */
  get playsUntil(): number {
    return this.until;
  }
}
