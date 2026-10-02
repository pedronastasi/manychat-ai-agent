import type { ActionRecord, StagedAction } from '../contracts/agent.ts';
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
function reasonFor(error: unknown, subscriberId: string, action: StagedAction): string {
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
 * Returns one group per staged action: its own record, then the record of a
 * follow-on it carried. A follow-on runs only once its action was performed,
 * so a payment-link flow that failed writes no stage (specs/023 § The sale
 * ends at the payment-link flow).
 */
export async function performActions(
  performer: ActionPerformer,
  subscriberId: string,
  actions: readonly StagedAction[],
  logger: ActionLogger,
): Promise<ActionRecord[][]> {
  const attempt = async (action: StagedAction): Promise<ActionRecord> => {
    try {
      await performer.performAction(subscriberId, action);
      return recordOf(action, 'performed');
    } catch (error) {
      const reason = reasonFor(error, subscriberId, action);
      logger.warn({ tool: action.tool, id: action.id, error: reason }, 'action failed');
      return recordOf(action, 'failed', reason);
    }
  };

  const groups: ActionRecord[][] = [];
  for (const action of actions) {
    const record = await attempt(action);
    const followOn = action.tool === 'send_flow' ? action.followOn : undefined;
    groups.push(
      followOn && record.status === 'performed' ? [record, await attempt(followOn)] : [record],
    );
  }
  return groups;
}
