import { LINK_SENT, PROSPECT } from '../../contracts/config.ts';
import type { Tools } from '../../contracts/config.ts';
import type { StagedAction } from '../../contracts/agent.ts';
import type { Plugins } from '../../plugins/plugins.ts';
import type { PluginReads } from '../../plugins/reads.ts';
import type { FlowSends } from '../flows.ts';
import type { ContactActions } from './contact-actions.ts';
import { funnelField, intentField, offeringField, stageIndex } from './lookups.ts';
import type { Intent } from './lookups.ts';
import type { ActionStage } from './stage.ts';

export interface BuildToolsOptions {
  /**
   * A nudge turn is offered no `schedule_nudge`, so a nudge never schedules
   * another (specs/025).
   */
  nudgeTurn?: boolean;
  /** Sends a flow when it is called instead of staging it (specs/029). */
  flows?: FlowSends | undefined;
  /**
   * Runs before the turn's first flow goes out: on the prospect turn it
   * sends the opening, so no content reaches the contact ahead of it
   * (specs/032 § The opening flow is the server's, not the model's).
   */
  beforeFlow?: (() => Promise<void>) | undefined;
  /** The tenant's plugin tools, staged as the built-in ones are (specs/036). */
  plugins?: Plugins | undefined;
  /**
   * The turn's plugin reads. Absent, no read tool is offered: as for
   * `get_contact`, only a turn that reads history may read (specs/039).
   */
  pluginReads?: PluginReads | undefined;
}

/** What a sales tool returns while the contact is not a prospect (specs/034). */
export const NOT_PROSPECT = { staged: false, reason: 'not_prospect' } as const;

/** Whether a flow serves the turn's offering: its own, or every one (specs/028). */
export const fitsOffering = (
  flow: { offering?: string | undefined },
  current: string | undefined,
) => flow.offering === undefined || flow.offering === current;

/**
 * What every tool of one turn reads as it runs: the gate on intent, the
 * turn's offering and the floor under the funnel stage. Read from the stage
 * each time, so a write staged by one tool is seen by the next, in the same
 * step included.
 */
export class ToolTurn {
  readonly config: Tools;
  readonly stage: ActionStage;
  readonly contact: ContactActions;
  readonly options: BuildToolsOptions;
  readonly funnel: ReturnType<typeof funnelField>;
  readonly intent: ReturnType<typeof intentField>;
  readonly offering: ReturnType<typeof offeringField>;
  /**
   * A flow already sent to this contact is not offered again, so a repeat is
   * unrepresentable rather than discouraged (specs/023 § Every content flow
   * is a leaf, sent once). An offering change does not bring one back
   * (specs/028). The opening flow is the server's to send, never the model's
   * (specs/032).
   */
  readonly unsent: Tools['flows'];
  /**
   * A payment link marked here before any await on its way out, so a call
   * beside it in the same step already sees it (specs/029, specs/032).
   */
  linkStarting = 0;

  constructor(
    config: Tools,
    stage: ActionStage,
    contact: ContactActions,
    options: BuildToolsOptions,
  ) {
    this.config = config;
    this.stage = stage;
    this.contact = contact;
    this.options = options;
    this.funnel = funnelField(config);
    this.intent = intentField(config);
    this.offering = offeringField(config);
    this.unsent = config.flows.filter(
      flow => flow.role !== 'opening' && (flow.repeatable || !contact.sentFlows.has(flow.id)),
    );
  }

  /**
   * The contact's intent as the server knows it, a write staged earlier this
   * turn included, so a first message can be recorded as a prospect and sold
   * to in one turn (specs/034 § Until intent is prospect, the sale's tools
   * refuse).
   */
  turnIntent(): Intent | undefined {
    const staged = this.stage.staged.findLast(
      (action): action is Extract<StagedAction, { tool: 'set_field' }> =>
        action.tool === 'set_field' && action.id === this.intent?.id,
    );
    return (staged?.value as Intent | undefined) ?? this.contact.intent;
  }

  /**
   * Refused rather than removed from the enums: removing them would rule out
   * the same-turn unlock. A refusal makes no request and takes no slot of the
   * cap (specs/034).
   */
  closed(): boolean {
    return this.intent !== undefined && this.turnIntent() !== PROSPECT;
  }

  /**
   * The turn's offering: one staged on the offering field earlier in this
   * turn, or else the contact's (specs/028 § A flow belongs to one offering or
   * to all).
   */
  turnOffering(): string | undefined {
    const staged = this.stage.staged.findLast(
      (action): action is Extract<StagedAction, { tool: 'set_field' }> =>
        action.tool === 'set_field' && action.offering === true,
    );
    return staged?.value ?? this.contact.offering;
  }

  /**
   * The earliest stage a write may name: the last one performed for this
   * contact, or a later one already staged this turn. Parallel calls in one
   * step must not walk a lead back any more than a later turn may.
   */
  stageFloor(): number {
    const { stage, contact, funnel } = this;
    return Math.max(
      stageIndex(contact.funnelStage),
      this.linkStarting > 0 ? stageIndex(LINK_SENT) : -1,
      ...stage.staged.map(action =>
        action.tool === 'set_field' && action.id === funnel?.id ? stageIndex(action.value) : -1,
      ),
      // Writes already made this turn, a payment link's `link_sent` among
      // them (specs/029), so nothing staged after can walk the stage back.
      ...stage.sent.flatMap(sent =>
        sent.records.map(record =>
          record.tool === 'set_field' && record.id === funnel?.id && record.status === 'performed'
            ? stageIndex(record.value)
            : -1,
        ),
      ),
      // A payment link still in flight counts at the stage it is about to
      // write: a call in the same step runs while it waits (the SDK starts a
      // step's calls together), and would otherwise stage a lower write
      // that lands after `link_sent`. If the link then fails, the turn has
      // at most one step left.
      ...stage.sent.map(sent =>
        sent.pending && sent.action.tool === 'send_flow' && sent.action.followOn?.id === funnel?.id
          ? stageIndex(sent.action.followOn?.value)
          : -1,
      ),
    );
  }
}
