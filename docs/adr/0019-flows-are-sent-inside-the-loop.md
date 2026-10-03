# ADR-0019 — Flows are sent inside the tool loop on an inbound turn

**Status:** accepted · **Date:** 2026-10-03

## Context

ADR-0010 made every tool stage its action, performed after the reply was sent
and only if the turn did not escalate. ADR-0016 carved out reads. For a flow,
staging fixes the order in which the contact receives a turn: the reply and its
closing question first, as the Dynamic Block response, and the flow after it.
On a live deployment that reads as the agent announcing the syllabus, asking
"would you like the prices?", and only then showing the syllabus. The question
sits above content the contact has not seen, and scrolls away under it.

Two fixes that kept staging were tried or weighed. Holding the question back
and sending it after the flow put a second, background send to the contact
beside the outbox, which the reply field's write-then-trigger delivery cannot
take: two sends that interleave show one text twice and lose the other. It
also left the model writing a reply about a flow it had not seen go out.
Dropping the question on flow turns, or baking a fixed one into each flow,
removes the model's choice of next step.

## Decision

On an inbound turn, `send_flow` sends the flow when the model calls it, with
its follow-ons (the payment link's `link_sent` write and its event), and
returns whether ManyChat accepted it. The model writes its reply after, knowing
what went out. Every other write (tags, fields, notes, nudges) stays staged as
ADR-0010 has it. A nudge turn keeps flows staged too, since it declines by
escalating and a flow sent first would then arrive alone.

## Consequences

- The contact receives the flow, then the reply, then its closing question, and
  the reply can refer to what was sent and leave its content out.
- Cost: a flow is no longer subject to the turn's vetoes. A turn that escalates
  after it, on the model's call, the confidence threshold, a guardrail or an
  error, has still sent it. Accepted because flows are content the tenant
  built and chose to offer: one arriving before a handoff is harmless. The
  payment-link flow is included, and so is its `link_sent` write.
- Cost: the flow's request runs inside the race, so a turn that sends one is
  slower and more likely to be deferred. Bounded by the action cap and the
  client's request timeout.
- Cost: ManyChat accepting a flow is not ManyChat finishing it. A flow with a
  long Smart Delay is still playing when the reply arrives; a flow the agent
  sends should deliver its content without one. Superseded by specs/030: on a
  live deployment even a flow with no delay outlasted the reply, so a flow now
  declares how long it plays and the reply waits for it, inline or from the
  outbox.
- Amends ADR-0010 for flows on inbound turns; its rule stands for every other
  write and for nudge turns.
- Revisit if escalations after a sent flow show up in real conversations as a
  problem, or if deferred turns rise visibly on flow turns.
