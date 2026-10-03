import type { ActionRecord, PerformableAction, StagedAction } from '../contracts/agent.ts';
import type { ActionPerformer } from '../channels/manychat/client.ts';
import { recordOf } from '../agent/tools.ts';
import { redactText } from '../observability/redact.ts';

export interface ActionLogger {
  warn: (fields: object, message: string) => void;
}

/**
 * Why ManyChat refused, with the contact taken out: its answer can quote the
 * subscriber it was asked about, or the note it was sent, and this reason is
 * both logged and stored on the turn (C5, specs/024 § Note text never reaches
 * the record or the logs).
 */
function reasonFor(error: unknown, subscriberId: string, action: PerformableAction): string {
  // A ManyChat error's message already names the endpoint, the status and
  // ManyChat's own message.
  const raw = error instanceof Error ? error.message : String(error);
  const unquoted = action.tool === 'write_note' ? raw.split(action.text).join('[note]') : raw;
  return redactText(unquoted.split(subscriberId).join('[subscriber]')).slice(0, 200);
}

/**
 * Performs a turn's staged actions, in the order they were staged, one
 * request each (specs/012 § Actions follow the text, on both delivery paths).
 *
 * Each gets one attempt. A failure is logged and recorded, never retried: the
 * text is the reply of record, and a retry that lands after the conversation
 * has moved on is worse than a missing tag (§ A failed action is logged,
 * never retried).
 *
 * Returns one group per staged action: its own record, then the records of
 * the follow-ons it carried, in order. A follow-on runs only once the action
 * before it was performed, so a payment-link flow that failed writes no stage
 * (specs/023 § The sale ends at the payment-link flow), and a stage write that
 * failed fires no event (specs/027 § The event follows the stage write it
 * records).
 */
export async function performActions(
  performer: ActionPerformer,
  subscriberId: string,
  actions: readonly StagedAction[],
  logger: ActionLogger,
): Promise<ActionRecord[][]> {
  const attempt = async (action: PerformableAction): Promise<ActionRecord> => {
    try {
      await performer.performAction(subscriberId, action);
      return recordOf(action, 'performed');
    } catch (error) {
      const reason = reasonFor(error, subscriberId, action);
      logger.warn({ tool: action.tool, id: action.id, error: reason }, 'action failed');
      return recordOf(action, 'failed', reason);
    }
  };

  // Payment-link flow, then its `link_sent` write, then that stage's event.
  const chain = async (action: PerformableAction): Promise<ActionRecord[]> => {
    const record = await attempt(action);
    const followOn =
      action.tool === 'send_flow' || action.tool === 'set_field' ? action.followOn : undefined;
    return followOn && record.status === 'performed'
      ? [record, ...(await chain(followOn))]
      : [record];
  };

  const groups: ActionRecord[][] = [];
  for (const action of actions) groups.push(await chain(action));
  return groups;
}

/**
 * The course the turn's performed actions wrote, if any: the last write to
 * the course field that ManyChat accepted (specs/028). `outcomes` is what
 * `performActions` returned for `actions`.
 */
export function performedCourse(
  actions: readonly StagedAction[],
  outcomes: readonly ActionRecord[][],
): string | undefined {
  let course: string | undefined;
  actions.forEach((action, index) => {
    if (action.tool !== 'set_field' || !action.course) return;
    if (outcomes[index]?.[0]?.status === 'performed') course = action.value;
  });
  return course;
}
