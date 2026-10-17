import type { ToolSet } from 'ai';
import type { Tools } from '../../contracts/config.ts';
import type { ContactReads } from '../contact.ts';
import { NO_CONTACT_ACTIONS } from './contact-actions.ts';
import type { ContactActions } from './contact-actions.ts';
import { STAGED } from './copy.ts';
import { addGetContact } from './get-contact.ts';
import { addWriteNote } from './notes.ts';
import { addScheduleNudge } from './nudge.ts';
import { addSendFlow } from './send-flow.ts';
import { addSetField } from './set-field.ts';
import type { ActionStage } from './stage.ts';
import { addTagTools } from './tags.ts';
import { ToolTurn } from './turn.ts';
import type { BuildToolsOptions } from './turn.ts';

/**
 * Steps one to three may call tools; step four offers none, so it must
 * produce the reply. Four fit read, act, read again and reply (specs/024
 * § The loop grows to four steps and eight actions). Chosen, not measured.
 */
export const MAX_STEPS = 4;

/**
 * The tools for one turn, or undefined when `tools.json` configures none.
 *
 * Each parameter is an enum of the configured ids, so the model can only name
 * something the tenant set up (C3), and no tool takes a subscriber: the action
 * lands on whoever the turn belongs to (C4, C5). A tool whose list is empty is
 * not offered at all.
 */
export function buildTools(
  config: Tools,
  stage: ActionStage,
  contact: ContactActions = NO_CONTACT_ACTIONS,
  /** The turn's own contact, readable only on a turn that reads history (specs/024). */
  reads?: ContactReads,
  options: BuildToolsOptions = {},
): ToolSet | undefined {
  const tools: ToolSet = {};
  const turn = new ToolTurn(config, stage, contact, options);

  // In the order the model is offered them.
  addGetContact(turn, tools, reads);
  addSendFlow(turn, tools);
  addTagTools(turn, tools);
  addSetField(turn, tools);
  addWriteNote(turn, tools);
  addScheduleNudge(turn, tools);

  // Added last, and a built-in name was refused when the plugin loaded, so a
  // plugin can neither replace nor shadow one of the tools above.
  options.plugins?.addTools(
    tools,
    stage,
    () => turn.closed(),
    description => `${description}\n${STAGED}`,
  );
  if (options.pluginReads) options.plugins?.addReadTools(tools, options.pluginReads);

  return Object.keys(tools).length > 0 ? tools : undefined;
}
