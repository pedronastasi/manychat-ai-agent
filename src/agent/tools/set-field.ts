import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { LINK_SENT, PROSPECT } from '../../contracts/config.ts';
import type { SendFlowAction } from '../flows.ts';
import { eventFor } from './contact-actions.ts';
import { idsOf, STAGED } from './copy.ts';
import { OFFERING_LOCKED_FROM, openingFlow, stageIndex } from './lookups.ts';
import { fitsOffering, NOT_PROSPECT } from './turn.ts';
import type { ToolTurn } from './turn.ts';

/**
 * `set_field`: the tenant's enum fields, the funnel, the offering and intent
 * among them (specs/012, 023, 028, 032, 034, 045).
 */
export function addSetField(turn: ToolTurn, tools: ToolSet) {
  const { config, stage, contact, options, funnel, intent, offering } = turn;
  if (config.fields.length > 0) {
    // `link_sent` is the server's to write, so the model cannot name it.
    const offered = config.fields.map(field =>
      field.funnel
        ? { ...field, values: field.values.filter(value => value !== LINK_SENT) }
        : field,
    );
    const fields = new Map(offered.map(field => [field.id, field]));
    const values = [...new Set(offered.flatMap(field => field.values))] as [string, ...string[]];
    const listing = offered
      .map(field => `- ${field.id} (one of: ${field.values.join(', ')}): ${field.description}`)
      .join('\n');

    /**
     * The flow tied to a stage the model just moved the contact to, sent as a
     * flow the model calls is (specs/032 § A stage move can carry a flow):
     * once per contact, only for the turn's offering, and only for the stage
     * written, never one skipped.
     */
    const overCap = (id: string) => ({ flowDropped: id, reason: 'over the per-turn limit' });
    const sendTied = async (value: string) => {
      const tied = config.flows.find(flow => flow.onStage === value);
      if (!tied || !fitsOffering(tied, turn.turnOffering())) return {};
      if (!tied.repeatable && contact.sentFlows.has(tied.id)) return {};
      if (stage.sent.some(sent => sent.action.tool === 'send_flow' && sent.action.id === tied.id)) {
        return {};
      }
      const action: SendFlowAction = {
        tool: 'send_flow',
        id: tied.id,
        flowNs: tied.flowNs,
        origin: 'stage',
      };
      if (!options.flows) {
        // `stage` refuses only over the cap; a repeat is reported as staged.
        return stage.stage(action) ? { flowStaged: tied.id } : overCap(tied.id);
      }
      if (options.beforeFlow) await options.beforeFlow();
      const sent = await stage.send(action, options.flows);
      // Dropped over the cap is not refused by ManyChat: the model may still
      // send the flow itself on a later turn (specs/032).
      if (sent === undefined) return overCap(tied.id);
      return sent ? { flowSent: tied.id } : { flowRefused: tied.id };
    };

    tools.set_field = tool({
      description: `Record one of these choices on the contact.\n${listing}\n${STAGED}`,
      // Never free text (specs/012 § Free-text field values are refused). The
      // enum covers every field's values; the refinement holds each value to
      // its own field.
      inputSchema: z
        .object({ field: z.enum(idsOf(config.fields)), value: z.enum(values) })
        .refine(input => fields.get(input.field)!.values.includes(input.value), {
          message: 'value is not one of this field’s configured values',
          path: ['value'],
        }),
      execute: async ({ field, value }) => {
        if (field === intent?.id) {
          // Intent moves one way, and `prospect` is final (specs/034 § Intent
          // is a field the model records).
          const before = turn.turnIntent();
          if (before === PROSPECT && value !== PROSPECT) return { staged: false };
          const staged = stage.stage({
            tool: 'set_field',
            id: field,
            field: fields.get(field)!.field,
            value,
          });
          // The opening belongs to the turn that first stages `prospect`, and
          // the result says so, since the server could not know before the
          // loop ran (specs/034 § The opening waits for a prospect).
          const opening = openingFlow(config);
          return staged &&
            value === PROSPECT &&
            before !== PROSPECT &&
            contact.openingDue &&
            opening
            ? { staged, openingQueued: { flow: opening.id, description: opening.description } }
            : { staged };
        }
        if (turn.closed()) return NOT_PROSPECT;
        // The stage only moves forward (specs/023 § The funnel is a field the
        // agent moves).
        const floor = turn.stageFloor();
        if (field === funnel?.id && stageIndex(value) < floor) return { staged: false };
        if (field !== offering?.id) {
          // The server's measurement of the write, never the model's choice
          // (specs/027 § An event is a measurement).
          const event = field === funnel?.id ? eventFor(config, contact, value) : undefined;
          const staged = stage.stage({
            tool: 'set_field',
            id: field,
            field: fields.get(field)!.field,
            value,
            ...(event ? { followOn: event } : {}),
          });
          const moved = field === funnel?.id && staged && stageIndex(value) > floor;
          return moved ? { staged, ...(await sendTied(value)) } : { staged };
        }
        // Once an offering and its price have been put to the contact, a person
        // decides a switch (specs/028 § The offering may change until the offer),
        // unless the tenant keeps it open (specs/045).
        if (!offering?.switchable && turn.stageFloor() >= stageIndex(OFFERING_LOCKED_FROM)) {
          return { staged: false };
        }
        const before = turn.turnOffering();
        const staged = stage.stage({
          tool: 'set_field',
          id: field,
          field: fields.get(field)!.field,
          value,
          offering: true,
        });
        if (!staged) return { staged };
        // Available in the same turn, and said so, since the send_flow
        // description was written before the offering was known.
        const opened = turn.unsent.filter(
          flow => flow.offering === value && !fitsOffering(flow, before),
        );
        return {
          staged,
          flowsAvailable: opened.map(flow => ({ flow: flow.id, description: flow.description })),
        };
      },
    });
  }
}
