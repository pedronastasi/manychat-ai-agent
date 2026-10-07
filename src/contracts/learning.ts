import { z } from 'zod';

/**
 * What the analyst of the learning job returns (specs/031 § The analyst reads
 * transcripts as untrusted data). Output that fails it fails the run and
 * creates no proposal (C3). Lengths are not enforced here: one proposal over
 * them is refused on its own, not the whole run (§ A proposal is a tactic).
 */
export const AnalystProposal = z.object({
  text: z.string().describe('The tactic, in the language you were given.'),
  rationale: z.string().describe('Why the transcripts suggest it.'),
  enrolledCount: z.number().int().min(0).describe('How many enrolled transcripts show the tactic.'),
  notEnrolledCount: z.number().int().min(0).describe('How many not-enrolled transcripts show it.'),
  turnIds: z.array(z.string()).describe('The ids of the turns that show it.'),
});
export type AnalystProposal = z.infer<typeof AnalystProposal>;

export const AnalystOutput = z.object({ proposals: z.array(AnalystProposal) });
export type AnalystOutput = z.infer<typeof AnalystOutput>;

/** How a cohort contact's outcome is read: their enrolled tag, or its absence. */
export type OutcomeLabel = 'enrolled' | 'not_enrolled';

export type RunStatus = 'completed' | 'insufficient' | 'skipped_budget' | 'failed';
