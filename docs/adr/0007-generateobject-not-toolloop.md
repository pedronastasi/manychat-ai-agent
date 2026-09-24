# ADR-0007 — `generateObject` rather than a tool loop for v1

**Status:** superseded by ADR-0010 · **Date:** 2026-09-14

## Context

The AI SDK offers `ToolLoopAgent`, which runs the full call/execute/repeat cycle.
It is the obvious thing to reach for in something called "an agent". The v1 scope
is answer-from-catalog and escalate: there are no tools to call.

## Decision

Implement the `AgentRunner` port with a single `generateObject` call returning
the `AgentReply` schema. No tool loop in v1.

## Consequences

- One model call instead of a loop of them, which matters against an 8s budget —
  a tool loop's step count is unbounded in latency terms.
- The escalation signal is a validated field rather than a string parsed out of
  prose, so routing to a human is mechanical.
- Adding tools later means a second `AgentRunner` implementation behind the same
  port; no caller changes.
- Gives up built-in multi-step reasoning. If the agent later needs to check live
  availability or create a booking, this decision gets revisited — that is the
  trigger, not a general desire for the agent to be more agentic.
