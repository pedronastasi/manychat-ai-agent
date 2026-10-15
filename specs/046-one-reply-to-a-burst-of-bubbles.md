---
status: implemented
implemented: 2026-10-15
pr: 227
constitution: [C6, C7, C8]
adr: [0001]
---

# 046 — One Reply to a Burst of Bubbles

Defines what happens when a contact splits one message over several bubbles
sent seconds apart: which turns call the model, which reply is sent, and what
the reply reads. It builds on `037`, which orders the turns, and amends it,
listed at the end.

## A message in five bubbles got five replies

A contact wrote one question as five WhatsApp bubbles, a second or two apart.
ManyChat sends each bubble as its own request, so the agent ran five turns.
`037` ran them one at a time, and each read the replies before it, but every
one of them still called the model and sent a reply. The contact got five
answers in a row, the first to a greeting, each one repeating part of the last.

| Way to answer a burst once                            | Why not                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Wait a few seconds before every turn for more bubbles | Every turn pays the wait out of the 10-second budget (C7), to fix the few that are split (`037`) |
| Abort the running model call when a bubble arrives    | The call is paid for whether it is aborted or not, and a flow it sent cannot be recalled (`029`) |
| Answer each bubble, as `037` does                     | The cascade above                                                                                |

## A waiting message is folded into the next one

A turn that has waited for the contact's previous turn (`037`), and finds that
the contact has written again behind it, does not call the model. It records
the contact's message and gives a silent response. The contact's latest turn
reads every folded message from history and answers them together.

- Only a turn that will answer the contact counts as one behind it: a turn
  that reads their history, so never an unbound or first turn while tokens
  are enforced (`019`), and whose message is not the opening sentinel, whose
  scripted reply answers nothing the contact wrote.
- A message is folded only when the turn behind it can read it the way the
  model would have: text, never media, whose words alone the turn behind
  would not have answered differently. A media message, the opening sentinel,
  and a message carrying an escalation keyword run their own turn.
- Only a turn that reads the contact's history folds. Any other runs its own
  turn, which reads the token state again once its wait is over, so a message
  that turns out unbound stays out of history (`019`).
- A folded turn cancels a pending nudge (`025`), as any message does, and
  counts toward the turn cap (`018`). It costs no model call, and so is not
  counted against the rate limit or the budget.
- The first bubble of a burst is not folded: no turn was waiting for it. That
  is what the next section is for.

Folding is always on. It costs nothing: a folded turn would have spent a model
call on a reply the next turn makes redundant.

## A reply the contact wrote past is superseded

With `rules.foldBursts` set, a turn whose model call finishes after the
contact has written again behind it drops its reply. The turn is recorded with
outcome `superseded`, its spend counted and its staged actions discarded, and
its response is silent, or nothing is queued when it had lost the race (`002`).
The contact's latest turn answers everything since the last reply sent.

- A reply that sent a flow is never superseded: the flow has reached the
  contact, and the reply it precedes is owed (`029`, `030`).
- A reply that escalates, or a failed call, is never superseded (C6).
- A reply to media is never superseded: history keeps only its marker, or a
  transcript at most, so the turn behind would answer without the image or
  video the contact sent (`020`).
- A superseded reply is never sent, so it is left out of the history the
  model reads (`018`) and of the transcripts the learning job reads (`031`).
- Off by default. The model call is paid for whether its reply is sent or
  not, and a tenant decides whether one reply to a burst is worth it.

With both, a burst that arrives while the first bubble's model call runs is
answered once. A bubble that arrives after a reply was sent is answered on its
own, as before.

## What is not covered

- **A burst spread wider than the model call.** A bubble sent after the reply
  to the previous ones went out gets its own reply.
- **Two server processes** for one contact (`037`): the order, and so the
  folding, is kept by the process that receives the requests.

## Amendments

- `037 § Turns that enter history run one at a time`: a turn that waited and
  has a turn behind it records its message and gives a silent response.

## Verification

1. A unit test asserts that a turn is followed only by a later turn that has
   claimed its place and not left, and never by one of another contact.
2. An integration test sends four bubbles while the first turn's model runs.
   The middle ones call no model and get silent responses, and the last turn's
   history holds them all, in order.
3. An integration test asserts that a media message, the opening sentinel and
   a message with an escalation keyword are not folded, and that nothing is
   folded into, or superseded by, a turn that reads no history, and that a
   turn that read no token before its wait is not folded.
4. An integration test asserts that with `foldBursts` the first turn's reply
   is superseded, recorded with its spend, left out of the next turn's
   history, and that only the last bubble's reply is sent, inline or from the
   outbox, and that a reply to media is still sent.
5. An integration test asserts that without `foldBursts`, or when the first
   turn sent a flow, the first reply is sent.
