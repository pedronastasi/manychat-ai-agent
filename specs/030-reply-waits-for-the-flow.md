---
status: implemented
implemented: 2026-10-03
pr: 153
constitution: [C6, C7, C8]
adr: [0001, 0004, 0019]
---

# 030 — The Reply Waits for the Flow

Defines how long a reply waits after a flow the agent sent on an inbound turn,
so it lands after the flow's last message rather than inside it. It amends
`002`, `003`, `012` and `029`, listed at the end, and leaves out what a flow
contains, which is the tenant's.

## Accepted is not finished

`029` sends a flow when the model calls it and writes the reply after it.
`performed` means ManyChat accepted the request; it then plays the flow with
its own timing. A flow of several messages, an image, a text and a card with a
button, takes seconds to reach WhatsApp even without a Smart Delay, and a
Smart Delay adds its own length. The reply, written in a second or two,
arrived inside the flow: its closing question sat above the flow's last
message. `029` asked tenants to keep delays out of flows the agent sends. On a
live deployment that did not hold: a flow with no delay still took longer than
the reply, and some flows need their delay.

Nothing in ManyChat reports that a flow has finished, so the time is declared,
not observed:

| Way to know when a flow ends                     | Why not                                                                                                     |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| A ManyChat signal that the flow finished         | There is none: `sendFlow` answers when the flow starts                                                      |
| The flow's last step sends the reply             | A second sender beside the outbox; two sends that interleave show one text twice and lose the other (`029`) |
| Hold only the closing question back              | Same second sender, and the rest of the reply still lands inside the flow                                   |
| Reply at the deadline whatever the flow is doing | The flow's tail lands after the question, which is what this spec fixes                                     |

## A flow declares how long it plays

A `tools.json` flow entry may carry `settleSeconds`, an integer from 0 to 30:
how long the flow takes to play in ManyChat, Smart Delays and the sending of
its media included. Absent means 0, and the reply waits for nothing, as under
`029`. 30 is a bound, chosen not measured: the wait runs in a process that has
to stay up for it, and a flow that plays longer than half a minute is not
content to reply after. The value is the tenant's estimate; nothing measures
it, and a flow edited to play longer needs its value raised.

## The reply waits for the flow to play

A flow's play time starts when ManyChat answers its request. A turn that sent
flows waits until the last of them has played, the latest answer plus its
`settleSeconds`, before its reply is delivered. A flow ManyChat refused does
not count. Every reply of a turn that sent a flow waits, an escalation
included: the handoff message lands after the flow too.

- **It ends before the deadline:** the response is held until then and sent
  inline. The race deadline (`002`) is still the bound: the wait never takes
  the response past it.
- **It ends after the deadline:** the turn settles as it would have, and its
  reply is queued in the outbox for when the flow ends, with its staged
  actions, which the worker performs after delivering it (`012`). The response
  is sent now, and says nothing (below).

A reply delivered from the outbox this way keeps the outcome it settled with,
`answered_inline` for one the model wrote, since the model did not lose the
race; the log line `reply held for flow`, with `path` `inline` or `outbox` and
the wait in `heldMs`, tells the two apart. A failure to queue the reply sends
it inline at once: inside the flow is better than never.

### A flow still playing is the holding line

The response that hands a reply to the outbox, here or when the model loses
the race (`002`), carries the acknowledgement so the contact is not left
without an answer. While a flow is playing the contact already has one, and a
holding line would land inside it as the reply did. So the response carries no
message when a flow the turn sent is still playing: its `messages` array is
empty, and `external_message_callback` is registered as always, so the
contact's next message still comes back here.

When the model loses the race, whether a flow is still playing is decided at
the deadline. A flow sent after it, by the call still running, has its play
time waited for by the queued reply all the same. A flow whose request is still
in flight at the deadline has no answer yet, so it is not counted as playing,
and the holding line goes out. A deferred call that fails after a silent
response queues the holding line it held back, for when the flow ends, so the
contact still receives what any other failed deferred turn receives.

## What is not covered

- **Nudge turns** stage their flows and perform them after their text (`029 §
Nudge turns keep flows staged`); there is nothing to wait for.
- **The outbox's own delivery** of a reply whose model lost the race already
  follows the flow by however long the model took; it now also waits for the
  flow's play time.
- **Whether `settleSeconds` is right** is only visible on a phone.
- **A contact who writes while a reply is held.** Their next turn runs as
  usual and may be answered inline before the held reply goes out, and its
  history already holds that reply. The race-lost path has always had this
  gap; a held reply widens it to the flow's play time, at most 30 seconds.
  Ordering a turn behind a held reply is left to a later spec.

## Amendments

- `002 § Response contract`: the response's `messages` may be empty, when a flow the
  turn sent is still playing; the callback is registered as always.
- `002 § Latency budget`: a turn that sent a flow may hold its inline response for
  the flow, never past the deadline.
- `003 § tools.json`: `flows[]` entries take an optional `settleSeconds`, 0 to 30.
- `012 § Actions follow the text, on both delivery paths`: a reply held for a flow takes its staged
  actions to the outbox with it.
- `029 § ManyChat accepting a flow is not ManyChat finishing it`: the reply
  waits for the flow's declared play time; flows may keep their delays.

## Verification

1. A config test asserts `settleSeconds` loads from 0 to 30 and that a value
   outside that range or not an integer fails the load.
2. A unit test asserts `FlowSends` keeps when the last accepted flow ends, by
   its `settleSeconds` from ManyChat's answer, ignores a refused flow and a
   flow without the field, and takes the latest of several.
3. A unit test asserts the ManyChat renderer returns an empty `messages` array
   and still registers the callback when the response is silent.
4. An integration test asserts, over the ManyChat HTTP boundary, that an inline
   reply after a flow is held until the flow's play time ends, that one which
   would pass the deadline is queued in the outbox for that time with its
   staged actions while the response is silent, and that a turn with no flow,
   or a flow with no `settleSeconds`, is not held.
5. An integration test asserts that when the model loses the race after
   sending a flow still playing, the response is silent and the queued reply
   is due when the flow ends, and that a deferred call failing after a silent
   response queues the holding line.

**What this does not prove.** That ManyChat delivers an empty response without
an error, and that a flow's real play time matches its `settleSeconds`. Both
are visible only on a live account.
