---
status: specified
constitution: [C4, C5, C6, C9]
adr: [0010, 0015]
---

# 025 — In-Window Nudge

Defines the one turn this service may start without the contact writing
first: a single follow-up the agent schedules for a lead who has gone quiet,
delivered only while WhatsApp's 24-hour window is still open. It leaves out
anything sent after the window closes (which needs a paid template), more than
one nudge per silence, and nudges on any channel but WhatsApp through ManyChat.

## A lead who stops replying is lost by default

Every turn this service runs today is started by the contact. A lead who reads
the syllabus and goes quiet gets nothing more, and in a sale (ADR-0015) a
silence after the offer is the commonest way to lose one.

The reflexive fix is a timer rule: "if no reply after N hours, send flow X".
It is what the retired drip did (`023 § A fixed drip sends the same content to
every lead`) and it has the drip's fault: the same message whatever was said.
A lead who asked about instalments and a lead who asked about the schedule
need different follow-ups, and only the model has read the conversation.

So **the agent decides whether a nudge is warranted and when, and the server
decides whether it is still allowed when the time comes.**

## The agent schedules a nudge; it does not send one

`tools.json` gains a `nudge` section listing the delays the tenant permits:

```jsonc
{
  "nudge": {
    "delays": [
      { "id": "later_today", "minutes": 120 },
      { "id": "tomorrow", "minutes": 1200 },
    ],
  },
}
```

`schedule_nudge` takes a delay id, and is offered only when this section is
present. It is a write, and is staged like any `012` action: discarded if the
turn escalates, performed after the reply is delivered. Performing it means
inserting a row in a `nudges` table, not a ManyChat request.

A delay over **1380 minutes** (23 hours) is a load failure. A nudge has to be
delivered inside the 24-hour window, and the hour of margin, chosen, not
measured, covers the worker's poll interval, a deferred delivery and the
model call itself.

## At most one nudge waits per contact, and a nudge never schedules another

Scheduling a nudge replaces any pending one for the same contact. A nudge turn
is offered no `schedule_nudge` tool. Together these bound the outcome: after a
contact's last message, they receive at most one unprompted turn, and then
nothing until they write again.

## A nudge is cancelled by anything that makes it wrong

A pending nudge is cancelled, recorded with the reason, when:

| Reason            | Checked                                                              |
| ----------------- | -------------------------------------------------------------------- |
| `contact_replied` | Any inbound message, at the start of the turn                        |
| `escalated`       | Any turn of the contact's conversation escalates                     |
| `link_sent`       | The funnel field reaches `link_sent` (`023`)                         |
| `window_closing`  | Due time is past the contact's last inbound + 1380 minutes           |
| `human_active`    | At due time, the contact has the tag named in `nudge.humanActiveTag` |
| `read_failed`     | At due time, the `human_active` check could not be made              |
| `cap_reached`     | At due time, a budget, rate or turn cap would refuse the turn        |

`human_active` is the only check that needs ManyChat. The worker reads the
contact's tags through the `024` read path just before running the turn. If
the read fails, the nudge is cancelled as `read_failed`: an unprompted
message on top of a human conversation is worse than a missed follow-up (C6).
A tenant who sets no `humanActiveTag` gets no such check, and the spec says so
rather than pretending to detect a takeover it cannot see.

A cap never escalates a nudge. The contact asked nothing, so there is nothing
to hand off.

## A nudge turn is a model turn on a system-authored trigger

At due time the worker claims the row with `FOR UPDATE SKIP LOCKED`, as the
outbox worker does, and runs the agent with the conversation history and, in
place of an inbound message, a system note such as
`[no reply from the contact since <time>; decide whether to follow up]`. The
note is English and system-facing, never shown to the contact (C9), and sits
outside the contact fence because no contact wrote it (C4).

The model may send a follow-up, with any tool except `schedule_nudge`. If it
sets `escalate: true`, nothing is sent: no escalation message, because the
contact asked nothing. The turn is recorded with outcome `nudge_skipped` and
no human is notified.

A nudge turn has no race. Nobody is waiting on a Dynamic Block response, so the
reply goes straight to the deferred path in `002 § Deferred delivery goes
through a flow, not the Send API`, and its actions follow the text as `012`
requires. It counts against the budget, rate and turn caps like any model
turn.

## A nudge is recorded like a turn

Two outcomes are added to the turn outcome set: `nudge_sent` and
`nudge_skipped`. A cancelled nudge is not a turn; its row in `nudges` holds
the reason from the table above, with the conversation id and no contact data
(C5).

| Column            | Holds                                       |
| ----------------- | ------------------------------------------- |
| `conversation_id` | The conversation the nudge belongs to       |
| `due_at`          | When it may run                             |
| `status`          | `pending`, `sent`, `skipped` or `cancelled` |
| `cancel_reason`   | One of the reasons above, when `cancelled`  |

The reply rate to a nudge (a contact turn within 24 hours of a `nudge_sent`)
is reported beside `023`'s two measures. It is the only evidence a nudge
helps rather than annoys.

## Verification

1. A config test asserts a delay over 1380 minutes fails at load, and
   `schedule_nudge` is absent without a `nudge` section.
2. A test asserts scheduling twice leaves one pending row, and a nudge turn is
   offered no `schedule_nudge`.
3. An integration test against PGlite drives each cancellation reason and
   asserts the row ends `cancelled` with that reason and no model call is made.
4. A test asserts a failed read at due time cancels the nudge as
   `read_failed`.
5. A test asserts a nudge turn whose model escalates sends nothing, records
   `nudge_skipped`, and performs no staged action.
6. A test asserts the trigger note is outside the fence and that a sent nudge
   is delivered through the reply field and flow, text before actions.
7. A golden eval case, demo tenant, asserts a nudge after an instalment
   question and one after a schedule question choose different follow-ups.

What this misses: the 24-hour window is computed from this service's record of
the last inbound message. A contact who wrote to the tenant through a flow
this service never saw has a later window than the one computed here, which
errs toward cancelling, not toward an undeliverable send. A human takeover
the tenant does not tag is invisible. And whether a nudge reads as helpful or
as pressure is a judgement no assertion makes; reading real nudge
conversations is the check.
