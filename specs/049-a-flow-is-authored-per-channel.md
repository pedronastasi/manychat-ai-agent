---
status: implemented
implemented: 2026-10-22
constitution: [C3, C6]
---

# 049 — A Flow Is Authored per Channel

Defines how `tools.json` names a ManyChat flow for each Meta channel, and how a
turn picks the one for the channel it arrived on (`048`). It leaves out
per-channel `description`s and prompt copy, tags and fields, which belong to
the subscriber rather than a channel, and Telegram.

## A flow built for WhatsApp sends nothing on Instagram

A ManyChat flow is authored for one channel: its message steps are WhatsApp
steps, Instagram steps or Messenger steps. `012` gives each `flows[]` entry one
`flowNs`, so a deployment that answers Instagram (`048`) would send an
Instagram contact the WhatsApp flow. On an Instagram-only contact that flow has
nothing to deliver, and ManyChat may still answer `{"status":"success"}`. On a
contact ManyChat has merged across channels it is worse: the gallery the
contact asked for on Instagram can arrive on WhatsApp, which tells anyone who
shares that phone that the two accounts are one person (`048 § A reply goes to
the channel of the turn it answers`).

Two reflexive fixes are rejected:

- **One `flowNs` that the tenant makes work on every channel**, with a
  condition inside the flow that picks each channel's step. The condition reads
  the contact's state, not the request, so it guesses a channel this service
  already knows. The guess is wrong exactly for a merged contact.
- **Falling back to the WhatsApp flow** when a channel has none of its own.
  That is the cross-channel send above, done on purpose.

So the rule is:

> **A flow is sent through the namespace authored for the turn's channel, or
> not at all.**

## `flowNs` is a string or a map per channel

`flows[].flowNs` and `events[].flowNs` (`027`) take either shape:

```jsonc
{
  "flows": [
    {
      "id": "student_work",
      "flowNs": {
        "whatsapp": "content00000000000000_000003",
        "instagram": "content00000000000000_000203",
      },
      "description": "Photos of work by students who started with no experience.",
    },
  ],
}
```

- **A map** names a flow for any of `whatsapp`, `instagram` and `messenger`. It
  has at least one key, no other key, and no empty value; each violation is a
  load failure (C3).
- **A string is the flow for `CHANNEL` alone**, the deployment's default
  channel (`048`). Every `tools.json` written before this spec keeps its
  meaning: on a WhatsApp deployment its flows are WhatsApp flows, and turning
  on Instagram sends none of them there until the tenant adds Instagram's.
- **A key for a channel outside `CHANNELS` loads and is never used.** A tenant
  can author and commit a channel's flows before the channel is turned on.

## A turn sees only the flows its channel has

A flow is _available_ on a turn when its `flowNs` names a flow for the turn's
channel. Everything that offers or sends a flow is limited to available ones:

- `send_flow`'s enum is built per turn from the available flows. A turn with
  none is not offered `send_flow`, as a deployment with no flows is not
  (`012`).
- A flow that is not available is never sent, by the model or the server, and
  is never replaced by the same flow on another channel.

The model's view of a flow is unchanged: its `id` and `description`, the same
on every channel. A flow that is available on WhatsApp but not Instagram is
missing from Instagram's enum, which is the whole of what the model learns
about the difference.

## Sent once per contact, on any channel

`023 § Every content flow is a leaf, sent once` counts per contact, and a
contact is one subscriber on every channel (`048 § One subscriber is one
contact on every channel`). So a flow performed on WhatsApp is not sent again
on Instagram, and the `012` history note lists it as performed on later turns
whichever channel they arrive on. The contact has seen the gallery; a second
copy on another app would repeat it, not deliver it. A `repeatable` flow is
sent again as `023` allows, on the channel of the turn that sends it.

## The server's own flows follow the same rule

The flows the server sends rather than the model obey availability too. Each
one that has no flow for the turn's channel is skipped, and the skip has a
consequence the tenant needs to know:

- **The opening flow (`032`, `034`).** When the prospect turn's channel has no
  opening flow, the turn is handled as on a deployment with no opening: the
  opening is not claimed or sent, and `set_field`'s result carries no
  `openingQueued`, so the reply greets and asks as it would without one. It is
  not sent later on another channel, as an opening an escalation prevented is
  not (`032 § The opening flow is the server's, not the model's`): a welcome
  that arrives mid-conversation is not an opening.
- **A stage-tied flow (`032 § A stage move can carry a flow`).** A funnel write
  to its stage on a channel without it sends nothing, as when the flow's
  `offering` is not the turn's. `set_field`'s result names no flow, so the
  model may still describe the content itself.
- **The payment-link flow (`023`).** It is not offered where it is not
  available, so `link_sent` is not written on that channel, and the funnel
  stops at `prepared` there. A tenant who lists a channel in `CHANNELS` gives it
  a payment flow before expecting a sale on it.
- **Nudges and deferred actions.** A flow staged on a nudge turn (`029 § Nudge
turns keep flows staged`) or on a lost race (`030`) is resolved when it is
  performed, on the channel of the turn that staged it. That channel is the
  nudge's own (`048 § Nudges follow each channel's window`).

## Events take the same shape

A tracking flow (`027`) is authored per channel too, since it runs on the
contact's channel like any flow. An event whose `flowNs` has no flow for the
channel of the turn that advanced its stage is not fired, and is not recorded
as fired. The stage only moves forward (`027 § One event per stage per
contact, because the stage only moves forward`), so that event is lost for
that contact. The ad signal it would have reported is the tenant's to restore
by adding the channel's tracking flow.

## Every namespace in a map is checked at load

The checks that `012 § The flow set may not include the reply flow or field`
and `027` apply to a `flowNs` apply to every value of a map:

- no value may equal `MANYCHAT_REPLY_FLOW_NS`,
  `MANYCHAT_REPLY_FLOW_NS_INSTAGRAM` or `MANYCHAT_REPLY_FLOW_NS_MESSENGER`,
  whichever key it sits under;
- no value of an event may equal a value of any flow or of another event.

The uniqueness `027` requires is over values, not over `(channel, value)`
pairs, so a tracking flow can never be fired as content, on any channel.

`agent upgrade` changes nothing: a string is still valid, and its meaning on a
deployment that sets no `CHANNELS` is the one it had.

## What this changes elsewhere

- `003 § tools.json`: `flows[].flowNs` and `events[].flowNs` are a string or a
  map, as above.
- `012`: `send_flow`'s enum is per turn, and the reply-flow check covers map
  values.
- `027`: an event is fired only where its channel has a tracking flow.
- `032`: the opening and stage-tied flows are skipped on a channel without
  them.

## Verification

1. A config test loads a string `flowNs` and a map, and refuses an empty map, a
   key outside the three channels, an empty value, a map value equal to any
   channel's reply flow, and an event value equal to a flow's value under
   another key.
2. A route test on one server with `CHANNELS=whatsapp,instagram` and a flow
   whose `flowNs` is a string asserts it is in `send_flow`'s enum on a WhatsApp
   turn and absent on an Instagram one. A turn with no available flow is not
   offered `send_flow`.
3. A route test sends a map flow on an Instagram turn and asserts ManyChat's
   `sendFlow` received the `instagram` value, never the `whatsapp` one.
4. An integration test performs a flow on a WhatsApp turn and asserts an
   Instagram turn for the same subscriber does not offer or send it, and that
   its history note lists it as performed.
5. A test on a prospect turn on Instagram, with an opening flow that has only a
   WhatsApp value, asserts no opening is claimed or sent, no `openingQueued`
   reaches the model, and a later WhatsApp prospect write sends none either.
6. A test advances the funnel on an Instagram turn to a stage whose tied flow
   and event have only WhatsApp values, and asserts neither is sent or recorded
   as performed.
7. A nudge test stages a map flow on an Instagram nudge and asserts it is
   performed with the `instagram` value.

**What this does not catch.** Whether the namespace under `instagram` is a
flow authored for Instagram is the tenant's: a WhatsApp flow written under the
`instagram` key loads, is sent, and behaves as the flows this spec replaces. A
tenant who adds Instagram to `CHANNELS` without adding a single map gets an
Instagram deployment with no flows at all, no opening and no payment link; the
agent still answers in text, and nothing fails to warn them. A config check
that names the channels with no payment flow would close the second gap, and is
left out until a tenant asks for it.
