import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { LINK_SENT, PREPARED } from '../../contracts/config.ts';
import type { SendFlowAction } from '../flows.ts';
import { eventFor } from './contact-actions.ts';
import { catalogOf, CONTACT_ASKED, idsOf, SENT_NOW, SILENT, silentResult, STAGED } from './copy.ts';
import { stageIndex } from './lookups.ts';
import { fitsOffering, NOT_PROSPECT } from './turn.ts';
import type { ToolTurn } from './turn.ts';

/** `send_flow`: the content flows not yet sent to the contact (specs/023, 028, 029, 032). */
export function addSendFlow(turn: ToolTurn, tools: ToolSet) {
  const { config, stage, contact, options, funnel } = turn;
  if (turn.unsent.length > 0) {
    const flows = new Map(turn.unsent.map(flow => [flow.id, flow]));
    // The enum holds every unsent flow, so one the agent makes available by
    // setting the offering this turn can still be named; the description lists
    // only those it can accept now.
    const available = turn.unsent.filter(flow => fitsOffering(flow, turn.turnOffering()));
    // With an offering known, an empty list means its content was all sent:
    // told to set the offering, the model could switch it just to have something to
    // send, or try a write the lock refuses.
    const listing =
      available.length > 0
        ? catalogOf(available)
        : turn.turnOffering() === undefined
          ? 'None yet: record the contact’s offering with set_field first.'
          : 'None: everything for this contact’s offering has been sent.';
    const sends = options.flows;
    // The payment link waits for readiness unless the contact asked to pay
    // (specs/032 § The payment link waits for readiness).
    const gated = funnel !== undefined && turn.unsent.some(flow => flow.role === 'payment_link');
    tools.send_flow = tool({
      description:
        `Send the contact one of these flows.\n${listing}\n${sends ? SENT_NOW : STAGED}` +
        (turn.unsent.some(flow => flow.silent) ? `\n${SILENT}` : '') +
        (gated ? `\n${CONTACT_ASKED}` : ''),
      inputSchema: gated
        ? z.object({ flow: z.enum(idsOf(turn.unsent)), contactAsked: z.boolean().optional() })
        : z.object({ flow: z.enum(idsOf(turn.unsent)) }),
      execute: async (input: { flow: string; contactAsked?: boolean | undefined }) => {
        if (turn.closed()) return sends ? { sent: false, reason: 'not_prospect' } : NOT_PROSPECT;
        const { flow } = input;
        const entry = flows.get(flow)!;
        // Another offering's content is refused, whatever the model names.
        if (!fitsOffering(entry, turn.turnOffering()))
          return sends ? { sent: false } : { staged: false };
        // Recorded only when it opened the gate, so the bypass rate counts
        // bypasses, not every claim the model makes (specs/032).
        const asked =
          entry.role === 'payment_link' &&
          input.contactAsked === true &&
          funnel !== undefined &&
          turn.stageFloor() < stageIndex(PREPARED);
        if (
          entry.role === 'payment_link' &&
          funnel &&
          !asked &&
          turn.stageFloor() < stageIndex(PREPARED)
        ) {
          return sends
            ? { sent: false, reason: 'not_prepared' }
            : { staged: false, reason: 'not_prepared' };
        }
        // The server, not the model, records that the link went out, and only
        // once the flow itself has (specs/023 § The sale ends at the
        // payment-link flow).
        // Its event, if any, follows the write in turn (specs/027).
        const event = funnel ? eventFor(config, contact, LINK_SENT) : undefined;
        const followOn =
          entry.role === 'payment_link' && funnel
            ? {
                tool: 'set_field' as const,
                id: funnel.id,
                field: funnel.field,
                value: LINK_SENT,
                ...(event ? { followOn: event } : {}),
              }
            : undefined;
        const action: SendFlowAction = {
          tool: 'send_flow',
          id: flow,
          flowNs: entry.flowNs,
          ...(followOn ? { followOn } : {}),
          ...(asked ? { contactAsked: true as const } : {}),
        };
        // What a silent flow leaves to the reply, said where the model reads
        // the outcome (specs/023 § A silent payment flow leaves the link to
        // the reply).
        const silent = entry.silent ? { silent: silentResult(entry.role) } : {};
        if (!sends) {
          const staged = stage.stage(action);
          return staged ? { staged, ...silent } : { staged };
        }
        // The opening goes first on the prospect turn (specs/034). A payment
        // link is counted at link_sent before the await, so a funnel or offering
        // write made beside it is refused rather than landing after it (specs/029).
        const link = entry.role === 'payment_link' && funnel !== undefined;
        if (link) turn.linkStarting += 1;
        try {
          if (options.beforeFlow) await options.beforeFlow();
        } finally {
          // From here the reserved entry counts while the link is in flight.
          if (link) turn.linkStarting -= 1;
        }
        // Sent now, so the reply written after it follows it (specs/029). A
        // payment link takes the turn's staged stage writes ahead of it, so
        // its `link_sent` is the last stage ManyChat is given.
        const first =
          entry.role === 'payment_link' && funnel
            ? stage.staged.filter(staged => staged.tool === 'set_field' && staged.id === funnel.id)
            : [];
        const sent = await stage.send(action, sends, first);
        if (sent === undefined) return { sent: false, reason: 'over the per-turn limit' };
        return sent ? { sent, ...silent } : { sent };
      },
    });
  }
}
