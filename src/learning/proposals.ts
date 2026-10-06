import type { AnalystProposal } from '../contracts/learning.ts';
import { IDENTIFIER_SHAPES } from '../observability/redact.ts';

/** At most this many proposals come out of one run (specs/031). */
export const MAX_PROPOSALS_PER_RUN = 5;
export const MAX_INSIGHT_LENGTH = 280;
export const MAX_RATIONALE_LENGTH = 500;

/**
 * A digit or a currency symbol, in any script: the only marks of a price or a
 * date that do not depend on the tenant's language (specs/031 § A proposal is
 * a tactic, never a fact). "The price goes up soon" passes; review catches it.
 */
const FACT_MARK = /[\p{Nd}\p{Sc}]/u;

/** Why `text` may not be a tactic, or undefined when it may be. */
function factIn(text: string, field: string): string | undefined {
  if (FACT_MARK.test(text)) return `${field} holds a digit or a currency symbol`;
  // The shapes are global regexes: `search` ignores and keeps their lastIndex.
  if (IDENTIFIER_SHAPES.some(({ shape }) => text.search(shape) !== -1)) {
    return `${field} holds a link, an email or a phone number`;
  }
  return undefined;
}

/**
 * The refusals a tactic's text passes before it is stored, whether the analyst
 * wrote it or a reviewer edited it. Returns why it is refused, or undefined.
 */
export function insightRefusal(text: string): string | undefined {
  if (text.trim().length === 0) return 'the text is empty';
  if (text.length > MAX_INSIGHT_LENGTH) {
    return `the text is over ${MAX_INSIGHT_LENGTH} characters`;
  }
  return factIn(text, 'the text');
}

/** Why the analyst's proposal is refused and never stored, or undefined. */
export function proposalRefusal(
  proposal: AnalystProposal,
  knownTurnIds: ReadonlySet<string>,
): string | undefined {
  const text = insightRefusal(proposal.text);
  if (text) return text;
  if (proposal.rationale.length > MAX_RATIONALE_LENGTH) {
    return `the rationale is over ${MAX_RATIONALE_LENGTH} characters`;
  }
  const rationale = factIn(proposal.rationale, 'the rationale');
  if (rationale) return rationale;
  if (proposal.turnIds.some(id => !knownTurnIds.has(id))) {
    return 'it cites a turn that was not in its input';
  }
  return undefined;
}

/**
 * The proposals a run keeps: those that pass the refusals, at most
 * `MAX_PROPOSALS_PER_RUN`, in the analyst's order. The refused are counted,
 * never logged with their text (C5).
 */
export function acceptProposals(
  proposals: readonly AnalystProposal[],
  knownTurnIds: ReadonlySet<string>,
): { accepted: AnalystProposal[]; refused: number; dropped: number } {
  const passing = proposals.filter(proposal => !proposalRefusal(proposal, knownTurnIds));
  return {
    accepted: passing.slice(0, MAX_PROPOSALS_PER_RUN),
    refused: proposals.length - passing.length,
    dropped: Math.max(0, passing.length - MAX_PROPOSALS_PER_RUN),
  };
}
