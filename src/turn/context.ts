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

/**
 * The offering the model is told of: the request's, which wins (specs/028),
 * and the one it replaced, when it changed. The stage is not reset: the model
 * confirms the offering instead.
 */
export function offeringOf(
  requestOffering: string | undefined,
  keptOffering: string | undefined,
): { offering: string | undefined; offeringChangedFrom: string | undefined } {
  return {
    offering: requestOffering ?? keptOffering,
    offeringChangedFrom:
      requestOffering !== undefined &&
      keptOffering !== undefined &&
      requestOffering !== keptOffering
        ? keptOffering
        : undefined,
  };
}
