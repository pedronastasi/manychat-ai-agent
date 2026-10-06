---
status: implemented
implemented: 2026-10-06
pr: 176
constitution: [C6, C7, C8]
adr: [0001, 0004]
---

# 037 — One Turn at a Time per Contact

Defines what happens when a contact writes while their previous turn is still
running, or while its reply is still queued: the order the two turns run in,
what the second one reads, and the order their replies reach the contact. It
amends `002` and `030`, listed at the end.

## Two turns for one contact ran side by side

A contact's first message lost the race (`002`) and got the holding line.
While the model was still answering it, the contact wrote again. The second
turn started at once, beside the first. It read the contact's history, which
did not hold the first reply yet because the first turn had not written one,
so it answered both messages. The first turn had sent a flow, and both replies
were held for it (`030`). When the flow ended they went out one after the
other. The first reply closed with a question, and the second followed it
straight away, repeating half of the first and answering what the contact had
asked before the question.

`030 § What is not covered` named the gap and left it here. `002 § Messages to
one contact are paced` spaces such a burst out; it does not change what the
second reply says or when it is sent.

| Way to keep two turns apart                             | Why not                                                                                                        |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Fold the second message into the running turn and rerun | The first call is paid for, a flow it sent cannot be recalled (`029`), and the rerun can miss the deadline too |
| Wait a few seconds before every turn for more messages  | Every turn pays the wait to fix the few that overlap                                                           |
| A Postgres lock held across the model call              | Holds a connection for up to `MODEL_ABORT_MS` per writing contact, to order turns one process already receives |
| Leave them side by side                                 | The repeated, out-of-order replies above                                                                       |

## Turns that enter history run one at a time

A turn that enters the contact's history, any turn but an unbound one while
tokens are enforced (`019`), starts only after the contact's previous such turn
has settled: its reply recorded and, when the race was lost, queued in the
outbox. Turns wait in the order their requests arrived.

- The wait comes before the turn starts, so before the contact's message is
  recorded. The message lands in history after the previous reply, in the
  order the contact saw them, and the turn reads that reply.
- An unbound turn while tokens are enforced enters no history (`019`). It
  neither waits nor is waited for, so a request without the contact's token
  cannot hold up the contact's own turns.
- The wait counts against the turn's deadline, which runs from the request's
  arrival. If the previous turn has not settled by then, the response is
  silent, as a response is while a flow plays (`030`), and the turn runs once
  the previous one settles, with its reply going through the outbox. The
  contact already has the previous turn's holding line, or its flow.
- A turn that fails after that silent response is past the route's error
  handler, which answers a failure with the handoff (`017`). The handoff goes
  through the outbox instead, and the conversation is marked escalated (C6).
- A previous turn that has not settled after `MODEL_ABORT_MS` plus the race
  deadline is no longer waited for, and the log line `turn wait expired` says
  so. Everything a turn runs is bounded by then. A turn stuck past that bound
  would otherwise silence the contact for good (C6).

The order is kept by the process that receives the requests. A deployment
that spreads one contact's requests over more than one server process does
not get it, and the shipped deployment runs one.

## A reply never overtakes an earlier one

A contact's queued reply goes out before any reply the agent writes them
later.

- A reply row is due no earlier than every reply row already queued for the
  same contact, pending or being delivered. A row that has failed for good,
  or that was delivered, holds nothing back, and neither does a contact token
  write.
- A turn whose contact has a reply queued delivers through the outbox, behind
  it, with a silent response, even when it finished inside the deadline. This
  includes a scripted opening, an escalation before the model and a media
  fallback, not only a model reply.
- A turn that loses the race while a reply to the contact is queued sends no
  holding line: a reply is already on its way.

The worker then delivers the contact's rows in the order they were written,
with the gap between them (`002`).

## What is not covered

- **Nudge turns** (`025`) do not wait. A contact's message cancels a pending
  nudge, and a nudge turn already running when they write is not ordered
  against their turn.
- **Inline actions.** Actions staged on an inline turn are performed after
  its response (`012`). The next turn can start before they finish, and then
  reads them as staged.
- **Two server processes** for one contact, above.

## Amendments

- `002 § Latency budget`: the race deadline runs from the request's arrival,
  and a turn's wait for the contact's previous turn counts against it.
- `002 § Response contract`: the response's `messages` may also be empty when
  a reply to the contact is already queued, or when the turn could not start
  before its deadline.
- `002 § Messages to one contact are paced`: what the second reply says, and
  when it is sent, is this spec's.
- `030 § What is not covered`: a contact who writes while a reply is held is
  now answered after it.

## Verification

1. A unit test asserts that a contact's turns enter one at a time in arrival
   order, that another contact's turn never waits for them, and that a wait
   ends at its bound.
2. An integration test sends a second message while the first turn's model is
   still running. The second turn's history holds the first reply, and the
   recorded order is the first message, its reply, the second message.
3. An integration test asserts that a second turn still waiting at its
   deadline gets a silent response, and that its reply is queued after the
   first turn's. Another fails the database under such a turn and asserts the
   handoff is queued and the conversation marked escalated.
4. An integration test asserts that a turn finishing inside the deadline while
   a reply to the contact is queued is answered silently and its reply is
   queued behind that one, and that a race lost in that state sends no holding
   line.
5. A queue test asserts that a reply row is due no earlier than a reply queued
   for the same contact, and that a delivered row, a failed row, a token write
   and another contact's reply hold nothing back.
6. An integration test asserts that an unbound turn while tokens are enforced
   neither waits for a bound turn nor holds one up.
7. A test through the server asserts that two requests for one contact share
   the order, which a handler built per request would not.

**What this does not prove.** How a silent response reads on a phone: the
contact who wrote twice sees nothing for their second message until the queued
replies arrive. That is visible only on a live account.
