# ADR-0023 — The turn handler sequences the turn, and a factory builds what it runs with

**Status:** accepted · **Date:** 2026-10-17

## Context

Splitting `run()` into collaborators (`TurnRecorder`, `ReplyDelivery`,
`FlowSends` and the rest) left `TurnHandler` doing two jobs: running the turn's
steps in order and constructing every collaborator. The second job made it know
each collaborator's dependencies, so adding one to `TurnRecorder` meant editing
`TurnHandler` though no step had changed, and about fifty lines of wiring sat
in front of the sequence `run()` exists to show. ADR-0008 settles that
collaborators are classes; it does not say who builds them.

The reflexive fix is dependency injection all the way out: `server.ts` builds
every collaborator and hands them in, and `TurnHandler` knows nothing about
construction. Its strongest case is real: the composition root is where wiring
belongs, and nothing else in the repo would need to change shape. It loses
here because most collaborators cannot be built before the turn is admitted.
They need its conversation, whether it is bound and may read history, its
logger and its deadline, so injection would mean injecting factories, and
`TurnDeps` would grow to about twenty fields to carry what `TurnHandler`
already knows. Leaving the wiring in place was the other option, and its case
is that one file is the whole turn with no indirection; it loses because that
file is then the one every collaborator change touches.

## Decision

`TurnHandler` builds in its constructor what needs only `TurnDeps`, a
`TurnScope` builds the collaborators that need the admitted turn, and `run()`
only sequences the steps.

## Consequences

- A collaborator's dependencies are named in one place, its constructor call in
  `TurnScope`, and changing them leaves `TurnHandler` alone.
- Each turn gets new collaborators, so two turns never share a stage, a read
  budget or a recorder; the per-turn wiring rules (no contact read on a turn
  that may not read history, a payment link that cancels a nudge) can be tested
  on `TurnScope` without running a turn.
- `TurnOrder`, `MessageFold` and `TurnAdmission` are built once per handler,
  not once per call. `server.ts` still builds a handler per request, so a
  `SIGHUP` reload of the rules reaches the next turn unchanged.
- It is one more layer to read through: what a turn runs with is in
  `scope.ts`, not in `run()`.
- The collaborators stay concrete. Nothing can be swapped in a test, which the
  two-seam rule of `CLAUDE.md` wants, but which also means a test that needs a
  fake collaborator cannot be written.
- That `run()` only sequences is held by review alone; no check catches a step
  written inline.
- Revisit if a collaborator gets a second implementation (it becomes a port,
  injected), if `TurnScope` starts deciding things — branching on rules rather
  than building objects — or if a test can only be written by faking a
  collaborator.
