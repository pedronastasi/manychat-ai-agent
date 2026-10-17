import { FUNNEL_STAGES, PROSPECT } from '../../contracts/config.ts';
import type { Catalog, Tools, INTENT_VALUES } from '../../contracts/config.ts';
import type { StagedAction } from '../../contracts/agent.ts';
import type { ActionStage } from './stage.ts';

/** The field the agent's position in the sale is kept in, if the tenant marked one (specs/023). */
export function funnelField(config: Tools) {
  return config.fields.find(field => field.funnel);
}

/** The flow that ends the sale, if the tenant marked one (specs/023). */
export function paymentLinkFlow(config: Tools) {
  return config.flows.find(flow => flow.role === 'payment_link');
}

/**
 * The link a reply must carry because the turn sent a silent payment-link
 * flow, which leaves the link to the reply (specs/023 § A silent payment flow
 * leaves the link to the reply). `undefined` when the turn neither sent such
 * a flow nor staged it to be sent after the reply.
 *
 * The link is the catalog `url` of the turn's offering: one written this turn,
 * else the contact's, else the catalog's only offering. `null` when the flow
 * went out and no offering or link is known, which the loader's checks leave
 * to a contact with no offering recorded yet.
 */
export function silentPaymentLink(
  config: Tools,
  catalog: Catalog,
  stage: ActionStage,
  contact: { offering?: string | undefined } | undefined,
): string | null | undefined {
  const link = paymentLinkFlow(config);
  if (!link?.silent) return undefined;
  const sent = stage.sent.some(
    entry =>
      entry.action.tool === 'send_flow' &&
      entry.action.id === link.id &&
      entry.records[0]?.status === 'performed',
  );
  const staged = stage.staged.some(action => action.tool === 'send_flow' && action.id === link.id);
  if (!sent && !staged) return undefined;
  const written = stage.staged.findLast(
    (action): action is Extract<StagedAction, { tool: 'set_field' }> =>
      action.tool === 'set_field' && action.offering === true,
  );
  const id =
    written?.value ??
    contact?.offering ??
    (catalog.offerings.length === 1 ? catalog.offerings[0]!.id : undefined);
  return catalog.offerings.find(offering => offering.id === id)?.url ?? null;
}

/** The flow the server sends on a contact's prospect turn, if the tenant marked one (specs/034). */
export function openingFlow(config: Tools) {
  return config.flows.find(flow => flow.role === 'opening');
}

/** The field the contact's offering is kept in, if the tenant marked one (specs/028). */
export function offeringField(config: Tools) {
  return config.fields.find(field => field.offering);
}

/** The field the contact's intent is kept in, if the tenant marked one (specs/034). */
export function intentField(config: Tools) {
  return config.fields.find(field => field.intent);
}

export type Intent = (typeof INTENT_VALUES)[number];

/**
 * Whether the turn staged a write of `prospect`, which makes it the turn the
 * opening belongs to (specs/034 § The opening waits for a prospect).
 */
export function stagesProspect(stage: ActionStage, config: Tools): boolean {
  const intent = intentField(config);
  return stage.staged.some(
    action => action.tool === 'set_field' && action.id === intent?.id && action.value === PROSPECT,
  );
}

/**
 * The offering a request presented, if it is one: a value of the offering
 * field. Empty, unrendered (`{{offering}}`) or unknown is no offering at all,
 * never a guess (specs/028 § The server learns the offering from the inbound
 * request).
 */
export function knownOffering(raw: string | null | undefined, config: Tools): string | undefined {
  const value = raw?.trim();
  return value && offeringField(config)?.values.includes(value) ? value : undefined;
}

/** The first stage from which the offering is locked (specs/028). */
export const OFFERING_LOCKED_FROM = 'offered';

/** A stage's place in the sale; -1 for anything that is not a stage. */
export const stageIndex = (value: string | undefined) =>
  FUNNEL_STAGES.indexOf(value as (typeof FUNNEL_STAGES)[number]);
