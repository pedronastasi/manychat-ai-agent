import { NO_CONTACT_ACTIONS } from '../../src/agent/tools.ts';
import type { ContactActions } from '../../src/agent/tools.ts';

/**
 * The contact as a prospect. Tests of the sale itself assume the gate of
 * specs/034 has opened; the gate has tests of its own.
 */
export const asProspect = (contact: ContactActions | undefined = NO_CONTACT_ACTIONS) => ({
  ...contact,
  intent: 'prospect' as const,
});
