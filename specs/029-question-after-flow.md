---
status: implemented
implemented: 2026-10-03
pr: 152
constitution: [C5, C7, C8]
---

# 029 — The Closing Question Follows the Flow

Defines the order in which the contact receives a reply that sends a flow: the
reply's text, then the flow, then the reply's closing question. It amends `012`
in one place, listed at the end, and leaves out what a flow contains (built in
the tenant's ManyChat account) and the order of actions among themselves.

## The question arrives before what it asks about

Every reply ends on a question (`001`), and a reply that sends a flow
announces it in a line ("here is the syllabus"). The text and its question are
the Dynamic Block response; the flow is performed through the API after that
response is sent (`012 § Actions follow the text`). ManyChat then plays the
flow with its own timing, including any Smart Delay inside it.

So the contact reads, top to bottom: the announcing line, the question ("would
you like the prices?"), then the syllabus. The next step comes before the thing
it follows from, and the question scrolls out of sight under the flow's
content, which is where a contact stops reading.

Two reflexive fixes were rejected:

| Fix                                               | Why not                                                                                        |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| No closing question on a turn that sends a flow   | The turn ends with no next step, which is what `001`'s question exists to prevent              |
| A fixed question as the last message of each flow | The model's question, chosen for this conversation, is replaced by one written for all of them |

## The question waits for the flow

When a turn stages at least one `send_flow` and its reply ends on a question,
the question is **held**: it leaves the response and is sent after the turn's
actions, through the same deferred-delivery path the outbox uses (`002 §
Deferred delivery goes through a flow`).

### What is held

The reply's last message, if it ends on a question (the same check `001`'s
guardrail applies) and something precedes it. That is the appended
`closing_question`, or the model's own question when it wrote one into the
body instead. A reply that is nothing but its question keeps it: the response
must carry a message. An escalation stages no action, so it holds nothing.

The turn is recorded with its whole reply, question included. What is held is
when the contact receives the question, not what the reply was, so history,
repetition checks (`013`) and the model's next turn all see the reply as it
was written.

### How long it waits

A flow entry in `tools.json` may declare `settleSeconds`, an integer from 0
to 30: how long the flow takes to play out in ManyChat, Smart Delays
included. The question waits for the longest `settleSeconds` among the flows
the turn staged, counted from when the turn's actions have been performed.
Absent, it is 0, and the question follows as soon as ManyChat has accepted the
flow.

The value is copied onto the staged action, so a reply that completes into the
outbox carries it without reading the configuration again.

30 seconds is a bound, chosen not measured. The wait runs in a process that
has already answered ManyChat, so it costs nothing against the 10-second
budget (C7), but a longer flow than that is a sequence, and its last message
should carry its own question.

`performed` means ManyChat accepted the flow, not that it finished playing; the
settle time is the tenant's estimate of the difference. Nothing here measures
it. A flow edited to run longer needs its `settleSeconds` raised.

## Both delivery paths

- **Race won:** the response carries the reply without its question. After it
  is sent, the actions are performed (`012`), then the question waits and is
  sent.
- **Race lost, and a nudge (`025`):** the outbox row carries the reply without
  its question, and the question beside it. The worker delivers the text,
  performs the actions, then sends the question once its wait is over. The
  wait does not hold the batch: the next row is delivered meanwhile. A row that
  is dead-lettered sends neither its actions nor its question.

A deployment with no way to send text after the response (no API token) holds
nothing, and the question stays in the response.

## One attempt

The question is sent once, whether or not the flows were performed: a failed
flow leaves the question the reply's last word, which it would have been
anyway. A failed send is logged and not retried, as an action is (`012 § A
failed action is logged, never retried`): a question that lands minutes later,
after the contact has written again, is worse than none. The log line carries
ManyChat's reason with the question's text and the subscriber taken out (C5).

A crash between the response and the send loses the question, as it would
lose the actions.

## Amendments

- `012 § Actions follow the text, on both delivery paths`: the closing
  question of a turn that sends a flow follows the actions (`029`).
- `003 § tools.json`: `flows[]` entries take an optional `settleSeconds`.

## Verification

1. A config test asserts `settleSeconds` loads from 0 to 30 and fails the load
   outside it or when not an integer, and that a staged `send_flow` carries
   its flow's value.
2. Unit tests assert `holdQuestion` holds the trailing question only when a
   flow is staged, the last message is a question and something precedes it,
   and waits for the longest settle time among the staged flows.
3. An integration test asserts, on the race-won path, that the response omits
   the question, the turn records it, and the ManyChat requests run flow, then
   question, with the configured wait between them.
4. An integration test asserts the same order on the outbox path, that the
   worker's batch is not held by the wait, and that a dead-lettered row sends
   no question.
5. Tests assert the question is sent when the flow fails, and that a failed
   send is logged once, without the question's text, and not retried.

**What this does not prove.** Every check stops at ManyChat accepting the
request. Whether `settleSeconds` matches how long a flow really takes is only
visible on a phone; a flow with a 10-second Smart Delay and `settleSeconds: 0`
still puts the question in its middle.
