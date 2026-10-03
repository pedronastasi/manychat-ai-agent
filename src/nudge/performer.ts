import type { PerformableAction } from '../contracts/agent.ts';
import { LINK_SENT } from '../contracts/config.ts';
import type { ActionPerformer } from '../channels/manychat/client.ts';
import type { NudgeStore } from './store.ts';

/**
 * Performs a turn's staged actions for one conversation. `schedule_nudge` is a
 * row in `nudges`, not a ManyChat request; everything else goes to ManyChat as
 * before (specs/025 § The agent schedules a nudge; it does not send one).
 *
 * Once the funnel reaches `link_sent` the sale is closed, so a pending nudge is
 * cancelled as soon as that write lands. Only the server writes `link_sent`
 * (specs/023), and the worker checks the stage again at due time.
 */
export class NudgingPerformer implements ActionPerformer {
  private readonly inner: ActionPerformer;
  private readonly nudges: NudgeStore;
  private readonly conversationId: string;

  constructor(inner: ActionPerformer, nudges: NudgeStore, conversationId: string) {
    this.inner = inner;
    this.nudges = nudges;
    this.conversationId = conversationId;
  }

  async performAction(subscriberId: string, action: PerformableAction): Promise<void> {
    if (action.tool === 'schedule_nudge') {
      await this.nudges.schedule(this.conversationId, action.minutes);
      return;
    }
    await this.inner.performAction(subscriberId, action);
    if (action.tool === 'set_field' && action.value === LINK_SENT) {
      await this.nudges.cancel(this.conversationId, 'link_sent');
    }
  }
}
