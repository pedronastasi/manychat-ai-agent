# ADR-0016 — Reads are performed inside the tool loop, which grows to four steps

**Status:** accepted · **Date:** 2026-10-02

## Context

ADR-0010 made every tool stage its action and capped the loop at two steps. It
named its own revisit trigger: "when the first read tool arrives, since the
model needs its result, and 'stage, don't perform' does not apply to reads."
That trigger is met. To sell (ADR-0015) the agent has to know what a lead has
already been through, and much of that is set by the tenant's own flows
(tags from an ad click, a field from an earlier campaign), not by this
service, so the `012` history note cannot carry it.

The reflexive option is a server-side pre-fetch: call `getInfo` once before
the model runs and inject a whitelisted view of the contact into the prompt.
Its case is strong. It adds no model step, it keeps ADR-0010 intact, and the
one ManyChat call can run in parallel with loading history, so it costs
almost nothing against the 8 s deadline. It was turned down because it pays
that call on every turn, including the many where the contact asks a
question that needs nothing from the record, and because a model that can
ask for the record can ask again after a tenant flow has changed it
mid-conversation.

Neither reason was measured. Neither was the latency of the second step
ADR-0010 already added.

## Decision

A tool that only reads is performed when the model calls it, and the loop is
capped at four steps; every tool that writes is still staged as ADR-0010
decided.

## Consequences

- ADR-0010's rule for writes stands unchanged: a write is staged, performed
  after the guardrails and discarded on escalation. This ADR replaces only its
  two-step cap and closes its read-tool trigger. ADR-0010 is not marked
  superseded, because its central decision is still in force.
- A read has no side effect on the contact, so performing it before the
  guardrails run exposes nothing that an escalation would want undone.
- Cost: a read is a ManyChat request inside the race, through the same rate
  limiter as delivery, and each step is another model call. More turns will
  lose the race and go to the outbox. That is the accepted path, not a
  failure, but a deferred reply is a worse reply.
- Cost: the read returns contact data into the model's context. What it may
  return is a tenant whitelist, never the raw subscriber, and is specified in
  `024`.
- Revisit if the share of deferred turns rises visibly after `024` ships, or if
  eval p95 latency on tool turns breaks the budget in `002`. The pre-fetch is
  the fallback, and needs no change to the write path.
