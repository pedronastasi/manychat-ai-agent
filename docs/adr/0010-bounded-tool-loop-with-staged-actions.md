# ADR-0010 — A bounded tool loop whose tools stage actions, not perform them

**Status:** accepted · **Date:** 2026-09-24

## Context

ADR-0007 chose a single structured-output call "while there are no tools". There
are now: tenants want the agent to send media (images, audio, video, documents),
tag a contact, and record a choice on the contact. The ManyChat API offers no
way to push media directly. The only route is `POST /fb/sending/sendFlow` on a
flow the tenant has already built, so every one of these is a ManyChat API call
the agent chooses to make.

The reflexive shape is the AI SDK default: each tool gets an `execute` that
calls ManyChat, and the SDK loops until the model stops. The case for it is
real. It is the least code, and the model sees what actually happened. It is
rejected because the side effect fires mid-generation, before the model has
set `escalate` and before the guardrails run. A turn that ends in a handoff, a
prompt-leak veto or a schema failure would still have sent the brochure and
tagged the contact. Constitution C6 wants that turn to reach a human with nothing
done on its behalf.

The other option was to have the model declare the actions in a field of its
structured reply, with no tools at all. That keeps a single call. The case for
it is latency: there is no second model step against the 8 s deadline. It was
turned down in favour of tools for two reasons. Tool descriptions are the form
providers train models to act on, which gives each action its own "use this
when" guidance. And the port can later take read tools, whose results the model
does need, without the reply schema being reshaped again. Neither reason was
measured. The latency cost of the second step was not measured either.

## Decision

The agent runs a tool loop capped at two steps, and every tool's `execute` only
stages an action. The server performs the staged actions after the guardrails
pass, and discards them on any escalation.

## Consequences

- Actions are subject to the same vetoes as text. An escalated turn performs
  none, whether the model, the confidence threshold, a guardrail or an error
  caused the escalation.
- Cost: a turn that calls a tool pays for a second model step, so it is more
  likely to lose the race and be delivered through the outbox. The step cap
  bounds that cost but does not remove it.
- Cost: the model is told an action was _staged_, never that it succeeded. It
  cannot react to a failed send, and must not claim one happened. A ManyChat
  failure is visible only in the logs.
- Cost: this is a second `AgentRunner` shape to build and test, and the eval
  suite now has to exercise turns with and without tools.
- Supersedes ADR-0007, whose own trigger (the agent taking actions) has been
  met.
- Revisit if eval p95 latency on tool turns breaks the budget in
  `002-channel-contract.md`, or if the share of deferred turns rises visibly
  after tools ship. In either case the declared-actions option is the fallback.
  Revisit also when the first read tool arrives, since the model needs its
  result, and "stage, don't perform" does not apply to reads.
