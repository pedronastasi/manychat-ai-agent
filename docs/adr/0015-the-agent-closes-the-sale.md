# ADR-0015 — The agent closes the sale, inside the limits of C6

**Status:** accepted · **Date:** 2026-10-02

## Context

`001 § Role` made the agent "a front desk, not a salesperson": it answers
grounded questions and hands off everything else. That was the right scope
while the agent could only reply with text. Since `012` it can send the
tenant's flows, tag a contact and set fields, and the sales sequence a tenant
runs today is a fixed drip that sends the same content to every lead on a
timer, whatever they said. The agent is the only component that reads what
the lead said, and it is not allowed to act on it.

The reflexive option is to keep the front desk. Its case is strong: a front
desk that only answers is hard to get wrong, and every step towards selling
is a step towards the failure C6 exists to prevent: a confident claim that
was never in the catalog. A model told to sell will reach for urgency,
discounts and outcomes, because that is what sales copy in its training data
does.

The middle option, a guided seller that qualifies and steers but leaves the
ask to a human, was also considered. It was turned down because the human
step it keeps is the one the contact waits longest for, and the ask itself
(sending the payment link) has nothing in it that needs judgement the catalog
cannot supply.

None of this was measured. There is no baseline conversion figure yet, and
`023 § Success is measured twice` requires one before rollout.

## Decision

The agent takes a lead from first reply to the payment-link flow on its own,
and every C6 limit on what it may claim stays exactly as it is.

## Consequences

- The agent qualifies, chooses content, answers objections from the catalog
  and sends the payment link. `001 § Role` is rewritten to say so in the
  pull request that implements `023`.
- C6 is not relaxed. A price, date, payment option or promotion still comes
  from the catalog or not at all. Discounts not in the catalog still escalate
  as `price_negotiation`. "Invented urgency" stays on the `001 § Register`
  never-list.
- Cost: more turns end in a confident answer instead of a handoff, so each
  wrong answer now reaches a contact rather than a person. The eval suite must
  carry sales cases (objections, "is that the best price?", pressure to
  commit) before the prompt ships.
- Cost: a human no longer sees a lead until payment or escalation. Context the
  human used to gather in conversation has to be written down by the agent
  (`024 § Three free-text notes`).
- Revisit if the eval suite shows the agent inventing a price, a promotion or a
  deadline on any sales case, or if paid enrolments fall after rollout while
  link-sent rate rises. The second means the agent is asking too early, and
  the guided-seller option is the fallback.
