---
status: specified
constitution: [C1, C3, C5, C6]
adr: [0015]
---

# 031 — Window-Closing Flow

Defines one flow the server sends a contact, with no model call, just before
their WhatsApp 24-hour window closes. It amends `003`, `023` and `025`, listed
at the end, and leaves out anything sent after the window closes (which needs
a paid template), more than one such flow per tenant, and any choice of its
content by the model.

## A timer in ManyChat cannot see the conversation

A tenant who wants a last word before the window closes (a thank-you, links to
their channels, a reminder of the store) reaches for the builder's timer: a
Smart Delay of 23 hours after the contact's last message, then the flow. It is
how such a flow ran before this service existed.

It is wrong beside the agent for the reason `023 § A fixed drip sends the same
content to every lead` gives: ManyChat does not know what the agent did. It
sends the flow to a contact the agent escalated, on top of the person now
handling them, and to a contact who has just been sent the payment link, as
if the sale had not happened. It also cannot be stopped by any of the
conditions `025` already checks before a nudge.

The other reflex, a nudge the model may spend on this flow, makes the flow
depend on the model having scheduled a follow-up and then choosing it, which
is a different message on a different timer. The tenant wants the same flow at
the same point for everyone it is right for, so no model is involved.

So **the server sends the tenant's closing flow at a fixed time after the
contact's last message, and skips every contact for whom `025` would cancel a
nudge.**

## The tenant names one flow, and the agent never sends it

`tools.json` gains an optional section:

```jsonc
{
  "windowClosing": { "flowNs": "content20260101000000_000001" },
}
```

`flowNs` is validated like a `flows[]` entry's (C3). The flow is not listed in
`flows[]` and is never offered to the model: no tool, enum or catalog line
names it, so the agent cannot send it early or twice. A flow namespace in both
places fails the load, since the agent would then be able to send what the
server sends once. Absent, nothing here runs.

## It goes out 1380 minutes after the contact's last message

The flow is due at the contact's last inbound message plus **1380 minutes**,
the same bound as a nudge delay (`025 § The agent schedules a nudge; it does
not send one`), chosen, not measured: an hour inside the window for the
worker's poll and a retry. The time is fixed; it is not a tenant setting,
because any earlier time is a follow-up, which is the nudge's job, and any
later one risks the window.

"Last inbound" is the latest contact turn this service recorded, bound or not:
the window is WhatsApp's, and any message the contact sent opens it. A message
that arrives before the flow goes out moves the due time with it.

## A contact receives it once, ever

The flow is sent at most once per contact, recorded on the contact, not the
conversation, so an idle reset (`018`) does not make it due again. A contact who
returns weeks later and falls silent again gets nothing: the flow is a
sign-off, and a second one reads as a campaign. A send that fails is retried
while the window is still open, and then given up; giving up counts as sent,
so a contact the flow never reached does not get it on their next silence
either.

## It is skipped for anything that makes it wrong

At due time the worker checks, in this order, and records the first reason
that applies instead of sending:

| Reason            | Checked                                                                   |
| ----------------- | ------------------------------------------------------------------------- |
| `contact_replied` | A contact turn later than the one the due time was computed from          |
| `escalated`       | Any turn of the contact's conversation escalated                          |
| `link_sent`       | The funnel field reached `link_sent` (`023`), counting `performed` writes |
| `human_active`    | The contact has the tag named in `nudge.humanActiveTag`                   |
| `read_failed`     | The `human_active` check could not be made                                |

The checks are `025`'s, read the same way: `escalated` from the conversation's
`escalated_at`, `link_sent` from the `performed` funnel writes, and
`human_active` through the `024` read path with the client's 10-second
timeout. A failed read skips the flow (C6): an unprompted message on top of a
human conversation is worse than a missing sign-off. A tenant with no
`nudge.humanActiveTag` gets no such check and no read.

A skip is final, like a send: the contact is marked so the flow is not
reconsidered. `contact_replied` is the exception, since the contact's new
message gives them a new due time.

Budget, rate and turn caps do not apply: there is no model call and nothing
the caps measure. A skip never escalates; the contact asked nothing.

## It may follow a nudge, and cancels one still pending

A contact may receive both a nudge and this flow in the same silence: the
agent's follow-up, chosen for them, and later the tenant's sign-off. This
widens `025`'s bound. After a contact's last message they receive at most two
unprompted messages, then nothing until they write again.

A nudge still pending when the flow goes out is cancelled, with reason
`window_closing`, the reason `025` already uses for a nudge due too late. The
two can then never arrive together, and the sign-off is always the last thing
sent.

## It is recorded so the agent knows it was sent

A sent flow is recorded as an agent turn with outcome `window_closing_sent`,
no text, and the flow as its one `performed` action. History shows it as any
performed action is shown, so a contact who replies to it is answered by an
agent that knows what they are replying to. The turn names the flow by its
config key, never its content; a skip is recorded with the reason and the
conversation id only (C5).

The reply rate to it (a contact turn within 24 hours of a
`window_closing_sent` turn, over all of them) is reported beside `025`'s
nudge reply rate. It is the only evidence the flow helps.

## Amendments

- `003 § tools.json`: an optional `windowClosing` section, `{ flowNs }`, whose
  flow may not also be a `flows[]` entry.
- `023 § A fixed drip sends the same content to every lead`: one fixed message
  stays, the window-closing flow, sent by the server under this spec's
  checks, not by a ManyChat timer.
- `025 § At most one nudge waits per contact, and a nudge never schedules
another`: after a contact's last message they receive at most two unprompted
  messages, a nudge and then the window-closing flow.
- `025 § A nudge is cancelled by anything that makes it wrong`:
  `window_closing` also cancels a nudge pending when the flow is sent.

## Verification

1. A config test asserts `windowClosing.flowNs` is validated, that a namespace
   also in `flows[]` fails the load, and that no tool or system instruction
   names the flow.
2. An integration test against PGlite asserts the flow is sent at the last
   inbound plus 1380 minutes, through the ManyChat HTTP boundary, and recorded
   as a `window_closing_sent` turn that history shows as a performed action.
3. An integration test drives each skip reason and asserts nothing is sent,
   the reason is recorded, and only `contact_replied` leaves the contact due
   again.
4. A test asserts a contact who was sent the flow, in one conversation, is not
   sent it again after an idle reset and a new silence.
5. A test asserts a nudge pending at send time is cancelled as
   `window_closing`, and a nudge already sent does not stop the flow.

**What this does not prove.** The window is computed from this service's
record of the last inbound message, as in `025`: a contact who wrote through a
flow this service never saw has a later window, which errs toward sending
early, never late. Whether the flow helps or annoys is visible only in its
reply rate and in conversations.
