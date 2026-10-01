import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { Tools } from '../contracts/config.ts';
import type { ActionRecord, ActionStatus, StagedAction } from '../contracts/agent.ts';

/**
 * Step one may call tools; step two offers none, so it must produce the reply
 * (specs/012 § The loop is bounded at two steps). Chosen, not measured.
 */
export const MAX_STEPS = 2;

/**
 * Bounds the burst one turn can put through the ManyChat rate limiter, one
 * request per action. Chosen, not measured.
 */
export const MAX_ACTIONS_PER_TURN = 3;

/** `send_flow gel_course_brochure`, `set_field preferred_shift=evening`. */
export function describeAction(action: { tool: string; id: string; value?: string | undefined }) {
  return action.value === undefined
    ? `${action.tool} ${action.id}`
    : `${action.tool} ${action.id}=${action.value}`;
}

/** The entry recorded on the turn: ids and values, never ManyChat names. */
export function recordOf(action: StagedAction, status: ActionStatus, error?: string): ActionRecord {
  return {
    tool: action.tool,
    id: action.id,
    ...(action.tool === 'set_field' ? { value: action.value } : {}),
    status,
    ...(error === undefined ? {} : { error }),
  };
}

/**
 * Everything the model staged on one turn. A tool's `execute` writes here and
 * nothing else: no ManyChat request is made inside the model call, because at
 * that point the model has not decided whether to escalate and the guardrails
 * have not run (ADR-0010).
 *
 * Created by the caller rather than the runner, so what was staged is still
 * known when the model call is aborted and never returns.
 */
export class ActionStage {
  private readonly accepted: StagedAction[] = [];
  private readonly overCap: StagedAction[] = [];

  /** Whether the action is staged. A repeat of one already staged is. */
  stage(action: StagedAction): boolean {
    const key = JSON.stringify(recordOf(action, 'staged'));
    const same = (existing: StagedAction) => JSON.stringify(recordOf(existing, 'staged')) === key;
    if (this.accepted.some(same)) return true;
    if (this.accepted.length >= MAX_ACTIONS_PER_TURN) {
      if (!this.overCap.some(same)) this.overCap.push(action);
      return false;
    }
    this.accepted.push(action);
    return true;
  }

  /** In the order the model staged them, which is the order they are performed in. */
  get staged(): readonly StagedAction[] {
    return this.accepted;
  }

  get dropped(): readonly StagedAction[] {
    return this.overCap;
  }

  /**
   * The turn's record before anything is performed: every accepted action
   * with `status`, then those dropped over the cap.
   */
  records(status: 'staged' | 'discarded'): ActionRecord[] {
    return [
      ...this.accepted.map(action => recordOf(action, status)),
      ...this.overCap.map(action => recordOf(action, 'dropped_over_cap')),
    ];
  }
}

const idsOf = (entries: { id: string }[]) =>
  entries.map(entry => entry.id) as [string, ...string[]];

const catalogOf = (entries: { id: string; description: string }[]) =>
  entries.map(entry => `- ${entry.id}: ${entry.description}`).join('\n');

const STAGED =
  'The action is staged, not performed: it happens after your reply is sent, and not at all if the turn escalates.';

/**
 * The tools for one turn, or undefined when `tools.json` configures none.
 *
 * Each parameter is an enum of the configured ids, so the model can only name
 * something the tenant set up (C3), and no tool takes a subscriber: the action
 * lands on whoever the turn belongs to (C4, C5). A tool whose list is empty is
 * not offered at all.
 */
export function buildTools(config: Tools, stage: ActionStage): ToolSet | undefined {
  const tools: ToolSet = {};

  if (config.flows.length > 0) {
    const flows = new Map(config.flows.map(flow => [flow.id, flow]));
    tools.send_flow = tool({
      description: `Send the contact one of these flows.\n${catalogOf(config.flows)}\n${STAGED}`,
      inputSchema: z.object({ flow: z.enum(idsOf(config.flows)) }),
      execute: ({ flow }) => ({
        staged: stage.stage({ tool: 'send_flow', id: flow, flowNs: flows.get(flow)!.flowNs }),
      }),
    });
  }

  if (config.tags.length > 0) {
    const tags = new Map(config.tags.map(entry => [entry.id, entry]));
    const input = z.object({ tag: z.enum(idsOf(config.tags)) });
    tools.add_tag = tool({
      description: `Add one of these tags to the contact.\n${catalogOf(config.tags)}\n${STAGED}`,
      inputSchema: input,
      execute: ({ tag }) => ({
        staged: stage.stage({ tool: 'add_tag', id: tag, tag: tags.get(tag)!.tag }),
      }),
    });
    tools.remove_tag = tool({
      description: `Remove one of these tags from the contact.\n${catalogOf(config.tags)}\n${STAGED}`,
      inputSchema: input,
      execute: ({ tag }) => ({
        staged: stage.stage({ tool: 'remove_tag', id: tag, tag: tags.get(tag)!.tag }),
      }),
    });
  }

  if (config.fields.length > 0) {
    const fields = new Map(config.fields.map(field => [field.id, field]));
    const values = [...new Set(config.fields.flatMap(field => field.values))] as [
      string,
      ...string[],
    ];
    const listing = config.fields
      .map(field => `- ${field.id} (one of: ${field.values.join(', ')}): ${field.description}`)
      .join('\n');
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
      execute: ({ field, value }) => ({
        staged: stage.stage({
          tool: 'set_field',
          id: field,
          field: fields.get(field)!.field,
          value,
        }),
      }),
    });
  }

  return Object.keys(tools).length > 0 ? tools : undefined;
}
