import { PROSPECT } from '../../contracts/config.ts';
import type { Tools } from '../../contracts/config.ts';
import type { ActionRecord, SendEventAction } from '../../contracts/agent.ts';
import { funnelField, intentField, stageIndex } from './lookups.ts';
import type { Intent } from './lookups.ts';
import type { ChannelTools } from './channel.ts';

/**
 * What this service has already done for the contact, as far as the next
 * turn's tools depend on it (specs/023). Read from the `actions` the turns
 * recorded as `performed`, never from the model's text.
 */
export interface ContactActions {
  /** Flows performed for the contact within the history window. */
  sentFlows: ReadonlySet<string>;
  /** The funnel stage last recorded as performed for the contact, if any. */
  funnelStage?: string | undefined;
  /**
   * The contact's offering as the turn starts: the request's, or else the
   * one the conversation keeps (specs/028). Not read from the actions.
   */
  offering?: string | undefined;
  /** The offering the conversation held before the request changed it, if it did. */
  offeringChangedFrom?: string | undefined;
  /**
   * The contact's intent as the server knows it: the last performed write,
   * or `prospect` by the rollout rule. Absent is unknown (specs/034).
   */
  intent?: Intent | undefined;
  /**
   * The contact has had the opening, or a turn that staged `prospect`, so
   * the opening is never sent again (specs/034 § The opening waits for a
   * prospect).
   */
  openingSpent?: boolean | undefined;
  /**
   * The opening goes out on this turn if it stages `prospect` and does not
   * forfeit it by escalating (specs/034 § The opening waits for a prospect).
   */
  openingDue?: boolean | undefined;
  /**
   * The offering a bound request stored and the agent did not write: the
   * contact arrived through its advert (specs/034 § What counts as prospect
   * intent).
   */
  advertOffering?: string | undefined;
}

export const NO_CONTACT_ACTIONS: ContactActions = { sentFlows: new Set() };

/**
 * Folds a contact's agent turns, oldest first, into `ContactActions`.
 *
 * Flows count only inside the history window (specs/018): a contact back
 * after it starts clean, as their history does. The stage counts however old,
 * because it only ever moves forward, and so do intent and the opening.
 */
export function contactActionsFrom(
  turns: readonly { createdAt: Date; actions: readonly ActionRecord[] | null }[],
  config: Tools,
  since: Date,
): ContactActions {
  const funnel = funnelField(config);
  const intentId = intentField(config)?.id;
  const sentFlows = new Set<string>();
  let funnelStage: string | undefined;
  let intent: Intent | undefined;
  let openingSpent = false;
  for (const turn of turns) {
    for (const action of turn.actions ?? []) {
      // A turn that staged `prospect` spent the opening whatever became of
      // the write: an escalation discards it and forfeits the opening
      // (specs/034). One dropped over the cap was never staged.
      if (
        (action.tool === 'send_flow' && action.origin === 'opening') ||
        (action.tool === 'set_field' &&
          action.id === intentId &&
          action.value === PROSPECT &&
          action.status !== 'dropped_over_cap')
      ) {
        openingSpent = true;
      }
      if (action.status !== 'performed') continue;
      if (action.tool === 'send_flow' && turn.createdAt >= since) sentFlows.add(action.id);
      if (action.tool === 'set_field' && action.id === funnel?.id) funnelStage = action.value;
      if (action.tool === 'set_field' && action.id === intentId) intent = action.value as Intent;
    }
  }
  // A contact already being sold to before the gate counts as a prospect
  // without a write (specs/034 § Existing contacts are not asked again).
  if (intentId !== undefined && intent === undefined && stageIndex(funnelStage) > 0) {
    intent = PROSPECT;
  }
  return {
    sentFlows,
    funnelStage,
    ...(intent === undefined ? {} : { intent }),
    ...(openingSpent ? { openingSpent } : {}),
  };
}

/**
 * The tracking flow a funnel write to `value` fires, if the tenant configured
 * one and the write advances the stage past the last one performed for the
 * contact. A write equal to it counts nothing, and a stage only moves
 * forward, so each event fires at most once per contact (specs/027 § One
 * event per stage per contact).
 */
export function eventFor(
  config: ChannelTools,
  contact: ContactActions,
  value: string,
): SendEventAction | undefined {
  if (stageIndex(value) <= stageIndex(contact.funnelStage)) return undefined;
  const event = config.events.find(entry => entry.stage === value);
  return event ? { tool: 'send_event', id: event.id, flowNs: event.flowNs } : undefined;
}
