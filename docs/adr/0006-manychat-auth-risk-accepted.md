# ADR-0006 — Accepting ManyChat's unsigned webhooks

**Status:** accepted · **Date:** 2026-09-14

## Context

ManyChat does not sign Dynamic Block requests. There is no HMAC, no timestamp,
and no nonce — only headers we configure, sent verbatim on every request. We
cannot verify that a request genuinely originated from ManyChat, only that the
sender knows a secret.

## Decision

Accept the risk, with compensating controls:

- Shared secret compared using `crypto.timingSafeEqual`, never `===`.
- TLS required; it is the only protection against interception and replay.
- Two secrets valid during rotation, so rotation needs no flow downtime.
- Rate limiting per IP and per subscriber, bounding a leaked secret's blast radius.
- The endpoint exposes no data: it accepts a message and returns a reply. There is
  nothing to read back, so a valid-looking forged request can waste model budget
  but cannot exfiltrate conversation history.
- Budget caps mean the worst case of a leaked secret is bounded spend, not an
  unbounded bill.

## Consequences

- Residual risk: anyone holding the secret can invoke the agent. Detection is via
  rate-limit and budget alerting rather than via request authentication.
- If ManyChat adds request signing, revisit immediately — this ADR is the record
  of why the weaker control exists.
- An IP allowlist was considered and rejected: ManyChat publishes no stable
  egress range, so it would break silently.
