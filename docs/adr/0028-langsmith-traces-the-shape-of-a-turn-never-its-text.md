# ADR-0028 — LangSmith traces the shape of a live turn, never its text

**Status:** accepted · **Date:** 2026-10-28

## Context

The runner is a LangGraph graph (ADR-0027), and nothing today shows how a live
turn moved through it. Logs are redacted (C5) and `turns` stores only the final
reply, so where the 8-second race (ADR-0001) goes, what a step costs, and which
tools a turn called cannot be seen. Boot refuses every LangSmith variable
(`050`, `026`), so the framework's own tracer is off.

The reflexive choice is LangSmith as documented: set `LANGSMITH_TRACING=true`
and every run's inputs and outputs are sent, which means the tenant's prompt
and catalog, the contact's messages and the model's replies. Its case is
strong: a wrong reply could be read step by step, and real conversations could
become datasets. It is rejected because it puts private data on a vendor's
servers, which C5 forbids. The middle option, masking text before upload, is
rejected too. A pattern catches phone numbers and emails, not a name or an
address written in prose, and a reply can repeat what the contact said. Privacy
here is a rule, not a best effort, so no contact text is sent at all, masked
or not.

## Decision

A deployment that opts in sends LangSmith the structure of each live turn, with
every input and output hidden, and sends full text only for eval runs against
the invented fixture tenant.

## Consequences

- Per-step timings, token counts, the model, tool names, step count and how the
  turn ended become visible for live turns. Eval runs, including the judge,
  are traced in full, because their data is invented.
- Nothing a contact wrote or the model replied leaves the process. Neither does
  the tenant's prompt or catalog. C1 and C5 stand unchanged.
- A trace identifies a turn by the conversation's random ID (ADR-0014) and
  nothing derived from the subscriber. An error is recorded as its class, never
  its message, because a provider's error can echo the request.
- Tracing is off unless the deployment sets a variable specific to this
  repository, plus its own LangSmith key and project. `LANGSMITH_TRACING=true`
  on its own still refuses boot, so the unmasked default can never be switched
  on by accident. Each tenant traces to its own workspace, never a shared one.
- The tracer uploads in the background and is never awaited inside a turn. A
  failed upload is logged, redacted, and dropped, never retried into a later
  turn, and never changes the reply (C6, C7).
- TypeScript and Python make the same change. Python lives in its own
  repository (ADR-0025) and follows there.
- Cost: LangSmith cannot answer why a particular live reply went wrong. That
  still means reading `turns` in the tenant's own database. Real conversations
  cannot become LangSmith datasets; eval cases stay written by hand.
- Cost: a vendor becomes a sub-processor of turn metadata, and each tenant has
  one more key to hold.
- Revisit if a contact's erasure request or a breach involves LangSmith, if a
  tenant's privacy terms forbid the sub-processor, or if the traces go unread
  for a quarter, when the risk buys nothing.
