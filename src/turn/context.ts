import type { ActionRecord } from '../contracts/agent.ts';
import type { Tools } from '../contracts/config.ts';
import { offeringField } from '../agent/tools.ts';

/**
 * The offering the contact arrived through, as the model is told it: one
 * stored from a bound request that the agent never wrote (specs/034 § What
 * counts as prospect intent). An unbound request's offering is never stored
 * (specs/028), so it is never one, and a forged request cannot make a contact
 * a prospect.
 */
export function advertOfferingOf(
  stored: string | undefined,
  turns: readonly { actions: readonly ActionRecord[] | null }[],
  tools: Tools,
): { advertOffering?: string } {
  const field = offeringField(tools);
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
  return written ? {} : { advertOffering: stored };
}
