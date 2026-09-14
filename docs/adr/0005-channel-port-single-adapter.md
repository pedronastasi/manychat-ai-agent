# ADR-0005 — Channel port with one adapter

**Status:** accepted · **Date:** 2026-09-14

## Context

The agent should not be permanently wedded to ManyChat, but building adapters
for platforms nobody has asked for is speculative work, and a port validated by
a single implementation is really only a guess at the right seam.

## Decision

Define a narrow `ChannelAdapter` port — `parse`, `render`, `push` — and ship
exactly one implementation (ManyChat). Channel differences are data, carried in a
`ChannelCapabilities` value, not branches in the renderer.

## Consequences

- The WhatsApp constraints (no quick replies, 3 buttons) are enforced by a
  capability object and covered by tests, rather than remembered by the author.
- Adding Telegram later is a new adapter and a capability row, not a refactor.
- The port may need adjusting when a second adapter arrives. Accepted: one
  adapter's worth of evidence is cheaper to correct than three adapters'.
- A local simulator implements the same contract, so the agent is fully testable
  with no ManyChat account — which matters because Dev Tools require a paid plan.
