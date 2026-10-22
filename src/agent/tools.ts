/**
 * The tools the model may call on a turn (specs/012), and the stage that
 * holds what it chose (ADR-0010). Split across `tools/` by concern; this
 * file is the one place they are imported from.
 */
export { MAX_STEPS, buildTools } from './tools/build.ts';
export { DEFAULT_CHANNEL } from './tools/turn.ts';
export type { BuildToolsOptions } from './tools/turn.ts';
export { flowOn, toolsOn } from './tools/channel.ts';
export type { ChannelTools } from './tools/channel.ts';
export { MAX_ACTIONS_PER_TURN, ActionStage, describeAction, recordOf } from './tools/stage.ts';
export {
  funnelField,
  intentField,
  knownOffering,
  offeringField,
  openingFlow,
  paymentLinkFlow,
  silentPaymentLink,
  stagesProspect,
} from './tools/lookups.ts';
export type { Intent } from './tools/lookups.ts';
export { NO_CONTACT_ACTIONS, contactActionsFrom } from './tools/contact-actions.ts';
export type { ContactActions } from './tools/contact-actions.ts';
