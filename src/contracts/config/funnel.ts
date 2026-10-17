/**
 * The stages of a sale, in order (specs/023 § The funnel is a field the agent
 * moves). A conversion is not one: only a person who has seen the payment sets
 * it, in the tenant's ManyChat account.
 */
export const FUNNEL_STAGES = [
  'new',
  'qualifying',
  'nurturing',
  'offered',
  'prepared',
  'link_sent',
] as const;

/**
 * The stage the payment link waits for, unless the contact asked to pay
 * (specs/032 § The payment link waits for readiness).
 */
export const PREPARED = 'prepared';

/** The stage the server writes when the payment-link flow is performed, never the model. */
export const LINK_SENT = 'link_sent';

/**
 * Whether the contact means to buy, in the order intent may move
 * (specs/034 § Intent is a field the model records). No value is unknown.
 */
export const INTENT_VALUES = ['not_prospect', 'prospect'] as const;

/** The intent that opens the sale's tools, and is final once recorded (specs/034). */
export const PROSPECT = 'prospect';
