# ADR-0001 — Hybrid race for the reply path

**Status:** accepted · **Date:** 2026-09-14

## Context

ManyChat terminates external requests at 10s. A model call plus database work
sometimes fits in that window and sometimes does not, depending on provider
latency, prompt length, and load. Three options:

1. **Synchronous only** — always answer inline. Simplest, no Send API token, but
   a slow provider drops the reply entirely and the contact sees nothing.
2. **Asynchronous only** — always acknowledge, always push via the Send API.
   Uniform and robust, but every reply pays queue latency even when the model
   answered in 900ms, which makes the bot feel worse than it is.
3. **Hybrid** — race the model against a deadline below the platform timeout.

## Decision

Hybrid. `Promise.race` between the model call and an 8s deadline. If the model
wins, render inline. If the deadline wins, return a short acknowledgement and let
the in-flight call complete into the outbox for a worker to deliver.

## Consequences

- Fast turns (the common case) stay conversational, with no queue hop.
- Slow turns degrade to a short delay rather than to silence.
- Cost: two delivery paths to build and test, and the acknowledgement is
  occasionally followed by an answer the contact did not wait for.
- The losing promise must not be abandoned — it holds a paid-for model response.
  Cancelling it on deadline would waste the tokens already spent.
- Requires `MANYCHAT_API_TOKEN` on day one, which option 1 would have deferred.
