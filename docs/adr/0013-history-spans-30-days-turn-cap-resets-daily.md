# ADR-0013 — History reaches back 30 days, and the turn cap resets after 24 hours of silence

**Status:** accepted · **Date:** 2026-09-26

## Context

There is one conversation row per contact, and its turn count never resets.
After `maxTurnsPerConversation` (default 25) every message from that contact
escalates before the model runs, permanently. History has no boundary in time
either: the model receives the last ten turns however old they are.

The first draft ended a conversation after 24 hours of silence, turn cap and
history together. That matched the callback's lifetime and would have bounded
what a leaked secret could read. The operator rejected it: students come back 7
to 30 days later, often in reply to retargeting, and the agent should still
know what they asked about. Once ADR-0012 binds history to a token held by
ManyChat, a long history no longer widens what a forged request can read. The
reason to keep history short is gone, while the reason to keep it long is the
business's.

The reflexive fix for the cap is a rolling limit per contact per day, with
history left alone. That is close to this decision, but it keeps the unbounded
history.

## Decision

The model receives the contact's last ten bound turns from the past
`historyDays` (default 30), and the turn cap counts turns since the last gap of
`idleResetHours` (default 24).

## Consequences

- A student returning after up to 30 days, or replying to a retargeting message,
  gets their context. A conversation older than that starts clean.
- The cap bounds one stretch of conversation, not a contact's lifetime, so a
  returning student is never escalated for having talked before.
- 30 days is the operator's statement of how long students take to come back
  (2026-09-26), not a measurement. 24 hours follows WhatsApp's customer-service
  window. Both are configurable.
- Cost: transcripts must be kept at least `historyDays`, so any retention period
  starts from 30 days, not 7.
- Cost: a 30-day history is more text in the prompt than a single day's. It is
  bounded by the ten-turn limit, not by time.
- Revisit if evals show old turns misleading the agent, such as a price quoted
  a month ago being repeated after it changed, or if retention has to drop below
  30 days.
