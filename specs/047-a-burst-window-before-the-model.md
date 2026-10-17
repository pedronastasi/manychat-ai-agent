---
status: implemented
implemented: 2026-10-17
constitution: [C6, C7, C8]
adr: [0001]
---

# 047 — A Burst Window Before the Model

Defines `rules.burstWindowMs`: how long a turn waits for the contact to write
again before it calls the model, and what that wait costs. It extends `046`,
which folds a burst only while a model call is running, and amends it, listed
at the end. How long a burst lasts on a tenant's channel is the tenant's
measurement, not this spec's.

## The first bubble of a burst still got its own reply

`046` folds the bubbles that arrive while an earlier turn of the contact runs,
and with `foldBursts` drops a reply the contact wrote past. Both depend on the
model call being slower than the contact's typing. A model that answers in two
seconds, to a contact who sends a bubble every three, answers every bubble:
nothing was running when the next one arrived.

`046` rejected waiting before every turn, because every turn pays the wait out
of the 10-second budget (C7). That stays true, and is why the window is off by
default: a tenant whose contacts write in bursts wider than the model call
turns it on, and pays for it in latency on every turn it applies to.

## A turn waits for the contact to go quiet

With `burstWindowMs` above 0, a turn that would fold if followed (`046 § A
waiting message is folded into the next one`) waits, once its place in the
contact's order comes (`037`), up to `burstWindowMs` for the contact to write
again.

- When a later turn of the contact claims its place inside the window, the
  wait ends at once, and this turn is folded: it records the message, calls no
  model, and gives a silent response. The later turn waits its own window.
- When the window passes in silence, the turn calls the model, and answers
  every message folded before it, as `046` does.
- Only a turn that could be folded waits: a media message, the opening
  sentinel, a message carrying an escalation keyword, and a turn that reads no
  history (`019`) run at once, as before.
- A bubble sent after the window has passed, and after the reply has gone
  out, is answered on its own.

The wait saves model calls, never adds one: a folded turn costs nothing, and
the turn that answers would have called the model anyway.

## The window is paid for out of the race

The wait runs from the request's arrival, after any wait for the contact's
previous turn, and counts against the race deadline (`002`, C7). What is left
is the model's.

- A turn still waiting at its deadline is answered silently, as a turn still
  waiting for its previous one is (`037`). It then folds, or runs and delivers
  its reply from the outbox (ADR-0001).
- A turn whose window leaves too little of the race for the model loses it,
  and its contact gets the holding line first (`002`).
- `burstWindowMs` is capped at 4,000 ms, half the default 8-second deadline,
  so the model keeps at least as much of the race as the wait takes. A config
  above it fails to load (`003`).
- 0, the default, waits for nothing, and a turn behaves as under `046` alone.

## What is not covered

- **A window that adapts** to the contact's typing, or to the model's latency.
  The window is one number per tenant.
- **Two server processes** for one contact (`037`): the window, like the
  folding, is kept by the process that receives the requests.

## Amendments

- `046 § A message in five bubbles got five replies`: waiting before a turn
  is no longer ruled out; it is what `burstWindowMs` does, off by default.
- `046 § A waiting message is folded into the next one`: with a window, the
  first bubble of a burst is folded too.

## Verification

1. A unit test asserts that a turn's wait ends as soon as a later turn of the
   contact claims its place, and only then, and settles false when the window
   passes in silence.
2. An integration test sends three bubbles inside the window, with a model
   that answers at once: only the last calls the model, one reply is sent, and
   its history holds the other two, in order.
3. An integration test asserts that a lone message is answered after the
   window, and that a bubble sent after the window gets its own reply.
4. An integration test asserts that a media message, the opening sentinel, a
   message with an escalation keyword and a turn that reads no history do not
   wait.
5. An integration test asserts that a turn whose window reaches the deadline
   is answered silently, and then folds, or delivers its reply from the
   outbox.
6. A unit test asserts that the window is 0 by default and that a value above
   4,000 ms is refused.
