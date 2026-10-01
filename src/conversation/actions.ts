import type { ActionRecord, StagedAction } from '../contracts/agent.ts';
import type { ActionPerformer } from '../channels/manychat/client.ts';
import { ManyChatApiError } from '../channels/manychat/client.ts';
import { recordOf } from '../agent/tools.ts';
import { redactText } from '../observability/redact.ts';

export interface ActionLogger {
  warn: (fields: object, message: string) => void;
}

/**
 * Why ManyChat refused, with the contact taken out: its answer can quote the
 * subscriber it was asked about, and this reason is both logged and stored on
 * the turn (C5).
 */
function reasonFor(error: unknown, subscriberId: string): string {
  const raw =
    error instanceof ManyChatApiError
      ? `ManyChat API ${error.status}: ${error.body}`
      : error instanceof Error
        ? error.message
        : String(error);
  return redactText(raw.split(subscriberId).join('[subscriber]')).slice(0, 200);
}

/**
 * Performs a turn's staged actions, in the order they were staged, one
 * request each (specs/012 § Actions follow the text, on both delivery paths).
 *
 * Each gets one attempt. A failure is logged and recorded, never retried: the
 * text is the reply of record, and a retry that lands after the conversation
 * has moved on is worse than a missing tag (§ A failed action is logged,
 * never retried).
 */
export async function performActions(
  performer: ActionPerformer,
  subscriberId: string,
  actions: readonly StagedAction[],
  logger: ActionLogger,
): Promise<ActionRecord[]> {
  const records: ActionRecord[] = [];
  for (const action of actions) {
    try {
      await performer.performAction(subscriberId, action);
      records.push(recordOf(action, 'performed'));
    } catch (error) {
      const reason = reasonFor(error, subscriberId);
      logger.warn({ tool: action.tool, id: action.id, error: reason }, 'action failed');
      records.push(recordOf(action, 'failed', reason));
    }
  }
  return records;
}
