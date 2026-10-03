import type { ActionRecord, StagedAction } from '../contracts/agent.ts';
import type { ActionPerformer } from '../channels/manychat/client.ts';
import { performActions } from '../conversation/actions.ts';
import type { ActionLogger } from '../conversation/actions.ts';

export type SendFlowAction = Extract<StagedAction, { tool: 'send_flow' }>;

/**
 * A turn's flow sends, made when the model calls `send_flow` rather than
 * after its reply (specs/029). The model is told whether the flow went out
 * and writes its reply after it, so the reply, and its closing question,
 * reach the contact after the flow's content.
 *
 * Built by the turn handler for an inbound turn only: a nudge turn may
 * decline by escalating, and a flow already sent would then arrive alone
 * (specs/025), so its flows stay staged.
 */
export class FlowSends {
  private readonly performer: ActionPerformer;
  private readonly subscriberId: string;
  private readonly logger: ActionLogger;

  constructor(opts: { performer: ActionPerformer; subscriberId: string; logger: ActionLogger }) {
    this.performer = opts.performer;
    this.subscriberId = opts.subscriberId;
    this.logger = opts.logger;
  }

  /**
   * Sends the flow, then its follow-ons (the payment link's `link_sent` write
   * and that stage's event, specs/023 and 027), one attempt each, and returns
   * what became of them, the flow first.
   */
  async send(action: SendFlowAction): Promise<ActionRecord[]> {
    const [records] = await performActions(
      this.performer,
      this.subscriberId,
      [action],
      this.logger,
    );
    return records ?? [];
  }
}
