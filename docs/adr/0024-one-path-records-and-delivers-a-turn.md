# ADR-0024 — A turn is recorded and delivered on one path, however it ends

**Status:** accepted · **Date:** 2026-10-17

## Context

A turn ends in one of four places: a precheck or the scripted opening before
the model, the model winning the race (ADR-0001), or the model losing it and
finishing in the background after the response went out. The reflexive shape
is a separate path for the lost race: it runs after the request is answered,
holds none of the request's locals, and completes into the outbox, so it is
natural to give it its own code for writing the reply row and queueing the
reply.

That is how the code was until the split of `run()`, and the copies had
already started to differ: the deferred path logged "guardrails intervened"
on its own, and each kept its own way of recording staged actions and
escalations. Nothing had broken yet. The decision was made with the code in
front of us, not ahead of it.

## Decision

Every way a turn ends records through `TurnRecorder` and delivers through
`ReplyDelivery`; a second copy of either is a regression.

## Consequences

- How a turn is recorded cannot depend on whether its model was fast. The
  usage, spend, staged actions, reads and escalation are written by the same
  code for an inline reply and a deferred one.
- Holding a reply until its flow has played (specs/030) and queueing behind an
  earlier reply (specs/037) are decided once, so a deferred reply cannot
  overtake an inline one by a rule the inline path did not know.
- `TurnRecorder` and `ReplyDelivery` have to handle every ending, so their
  inputs are wider than any one path needs: `decided`, `failed` and `settle`
  exist side by side, and a reader of one path sees methods it never calls.
- Revisit if the deferred path ever has to record something the inline path
  must not. That would be a real difference between the paths, and forcing it
  through one recorder would hide it behind a flag.
