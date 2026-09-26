---
status: implemented
implemented: 2026-09-26
pr: 91
adr: [0013]
---

# 018 — History Window and Turn Cap

Defines how far back the model's history reaches, and when the per-conversation
turn cap starts counting again. Which turns count as the contact's own, and so
enter history and the cap, is `019`. Transcript retention is left out, except
for the floor this spec puts under it.

## A turn cap that never resets escalates a returning student for good

There is one conversation row per contact, and its turn count only ever goes up.
After `maxTurnsPerConversation` (default 25) every message from that contact
escalates before the model runs. That is not a busy afternoon being handed to a
person. It is permanent, so a student who asked 25 questions in March is sent
to a human for every question they ask in May.

The reflexive fix is a rolling limit per contact per day. The per-contact rate
limit already bounds volume, though (`rules.rateLimit`). What the cap bounds is
one stretch of conversation that has gone on too long for the agent to be
helping.

So `maxTurnsPerConversation` counts the contact's messages since the last gap of
at least `rules.idleResetHours` (integer, default 24). The first message after
such a gap starts the count at one. 24 hours follows WhatsApp's customer-service
window (ADR-0013).

## History reaches back 30 days, not one day and not forever

The model receives the contact's last ten turns recorded in the past
`rules.historyDays` (integer, default 30).

- **Not one day.** The first draft ended a conversation after 24 hours of
  silence, history included. Students come back 7 to 30 days later, often in
  reply to a retargeting message, and the agent should still know what they
  asked about. The 30 days is the operator's figure for how long students take
  to return (2026-09-26), not a measurement.
- **Not forever.** Until now history had no boundary in time: the last ten turns
  however old. A contact returning after half a year is better served by a clean
  start than by the agent picking up a thread whose prices and dates have
  changed since.

History and the cap are counted separately on purpose. A student who returns
after two weeks gets their context and a fresh cap.

Turns are not deleted. Transcripts must be kept at least `historyDays`, so any
retention period starts from 30 days.

## Both are tenant rules

`historyDays` and `idleResetHours` are positive integers in `rules.json`,
validated by the rules schema, defaulted when absent, and reloaded on `SIGHUP`
like every other rule (`003`).

## Verification

| Clause    | The test                                                                                                                   |
| --------- | -------------------------------------------------------------------------------------------------------------------------- |
| Turn cap  | 25 messages and then a 25-hour gap lets the next message reach the model; 25 messages with no gap escalates the 26th       |
| History   | A turn recorded 31 days ago is not passed to the runner and one recorded 29 days ago is; no more than ten turns are passed |
| The rules | A `rules.json` without either field loads with 30 and 24; zero or a fraction is refused                                    |

What these cannot catch:

- **Whether 30 days and 24 hours are right.** Both are configurable, and neither
  is measured.
- **Old turns misleading the agent**, such as a price quoted a month ago being
  repeated after it changed. Only an eval case that seeds such a turn would
  show it, and ADR-0013 names it as the reason to revisit.
