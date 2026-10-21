---
status: implemented
implemented: 2026-10-21
pr: 254
constitution: [C3, C5, C6, C7]
adr: [0005]
---

# 048 — One Deployment Answers Every Meta Channel

Defines how one deployment answers WhatsApp, Instagram and Messenger contacts
through ManyChat: where a turn's channel comes from, what it decides about
rendering, deferred delivery, nudges and media, and what a contact ManyChat has
merged across channels looks like. It leaves out Telegram, per-channel prompt or
persona copy, and Instagram comments and story replies, which are not direct
messages.

## The channel belongs to the request, not the deployment

The reflexive way to add Instagram is a second deployment with
`CHANNEL=instagram`. That is the shape the code has today: `CHANNEL` is read
once at boot and fixes the capabilities every reply is rendered against. It
looks harmless until a ManyChat account sends both channels to one URL, which
is what an account with one External Request in a shared flow does. Then an
Instagram contact is rendered as a WhatsApp one: a reply of four messages
joined into one, where ten were allowed. A WhatsApp contact on an `instagram`
deployment is worse: four messages of which ManyChat delivers only the first
(`002 § Channel capability matrix`).

So the rule is:

> **Each turn is rendered, delivered and nudged for the channel its request
> names. `CHANNEL` is only the default for a request that names none.**

The inbound body carries `channel`, which the tenant writes as a literal in each
channel's External Request (`"channel": "instagram"`). It is one of `whatsapp`,
`instagram` or `messenger`. Its capabilities come from the capability table, per
turn, never from a value fixed at boot.

- A request with no `channel`, or an empty one, is read as `CHANNEL`.
- A request naming a channel outside the table, or outside `CHANNELS`, is
  refused with a 400, after authentication and without saying why (`017`) (C3).
- `CHANNELS` lists the channels this deployment accepts, comma-separated, and
  may list only `whatsapp`, `instagram` and `messenger`. It defaults to
  `CHANNEL`, so a deployment that sets neither behaves as it did before this
  spec. That includes `CHANNEL=telegram` alone, which this spec neither adds
  to a multi-channel deployment nor takes away.
- The `external_message_callback` the reply registers carries the turn's
  channel back as a literal, so the contact's next message names the same
  channel without the tenant configuring the callback.

## One subscriber is one contact on every channel

ManyChat can merge one person's WhatsApp, Instagram and Messenger into a single
subscriber with one `subscriber_id`. `038` keys a plugin channel's contacts as
`<name>:<platform ID>`, because a plugin platform's IDs share nothing with
ManyChat's. Copying that here would split a person ManyChat already says is one
into three conversations, three turn caps and three histories. The lead who
asked about the price on Instagram would be asked to start again on WhatsApp.

So a ManyChat contact stays keyed by `subscriber_id` alone, whatever the
channel:

- one conversation and one history window (`018`), with every turn recording
  the channel it arrived on;
- one turn cap, counted across channels;
- one turn at a time (`037`): a message on Instagram waits for the contact's
  running WhatsApp turn, and folds with it as `046` and `047` describe;
- one contact token (`019`), because the token lives in a custom field and the
  merged subscriber has one set of custom fields.

## A reply goes to the channel of the turn it answers

An inline reply goes back on the request it answers, so its channel needs no
rule. A deferred reply does. Every outbox row for a ManyChat contact records
the channel of the turn that wrote it, as `manychatChannel` in its payload:
`038`'s `channel` is not reused, because its absence already means "ManyChat".
A row written before this spec carries none and is read as `CHANNEL`.

The worker delivers each row through that channel's reply flow. A ManyChat flow
is authored per channel, so `002`'s two calls need a flow per channel:

| Channel     | Flow                               |
| ----------- | ---------------------------------- |
| `whatsapp`  | `MANYCHAT_REPLY_FLOW_NS`           |
| `instagram` | `MANYCHAT_REPLY_FLOW_NS_INSTAGRAM` |
| `messenger` | `MANYCHAT_REPLY_FLOW_NS_MESSENGER` |

The reply field (`MANYCHAT_REPLY_FIELD`) is shared: it is per subscriber, and
`002 § Messages to one contact are paced` already serialises a contact's sends.

Instagram or Messenger in `CHANNELS` without its flow is a boot error whenever
deferred delivery is configured, which is whenever `MANYCHAT_API_TOKEN` is set.
A deployment that accepts Instagram and cannot defer a reply there would
silently strand every race it lost (C6). A deployment that answers one channel
alone delivers through `MANYCHAT_REPLY_FLOW_NS` when that channel has no flow
of its own set, so a single-channel deployment of any channel, Instagram and
Messenger included, boots and delivers as it did before this spec.

A turn on one channel never sends to another. A reply to an Instagram turn is
not rerouted to WhatsApp because WhatsApp's window is still open. The contact
asked where they asked, and an unprompted message on a second app is a
disclosure that they are the same person, to anyone who shares that phone.

## Outside the window, only WhatsApp has a way back

All three channels give free-form messages 24 hours from the contact's last
inbound message (Meta platform policy, the same window `002` cites). Only
WhatsApp lets a flow leave it, with a pre-approved template. Instagram and
Messenger have no equivalent ManyChat can send, and `002` already records that
message tags are gone.

So a deferred reply for Instagram or Messenger is checked before it is sent.
The window is measured from the contact's last inbound turn **on that
channel**, because a message on WhatsApp opens no window on Instagram. A reply
whose send would fall outside it is not attempted. Its row is dead-lettered with
`last_error` `window_closed`, and the contact's conversation is escalated, so a
person sees a reply the contact never received (C6). It is never retried, and
never sent through `sendContent`, which would refuse it anyway.

A WhatsApp reply is unchanged: its flow carries the template.

## Nudges follow each channel's window

`025` covers WhatsApp only. It now covers all three channels:

- A nudge is scheduled for the channel of the turn that scheduled it, and runs
  on that channel. Its reply is delivered through that channel's flow.
- `window_closing` is computed from the contact's last inbound turn on the
  nudge's channel, with `025`'s 1380-minute margin unchanged.
- `contact_replied` cancels it on a message from any channel. A contact who
  answered on WhatsApp has answered.

## Media is recognised per channel, and only once a shape has been observed

`020` recognises media by the exact host and path ManyChat stores a WhatsApp
file under, with `wa` as the channel segment. No Instagram or Messenger file
URL has been observed for this service, so none is specified here. Guessing
one would let a wrong pattern decide which URLs this server downloads.

Until a shape is observed and added to `020`:

- A `text` that matches `020`'s host, with a channel segment other than `wa`,
  is media of kind `unsupported`. It gets `rules.messages.mediaFallback` and is
  never downloaded, and never reaches the model or storage as text (`020 § The
URL never reaches storage or logs`) (C5).
- The `media_url_unmatched` warning logs its shape, without the URL, which is
  how the first sample is found.

Adding a channel's shape is an edit to `020`'s table, with the date it was
observed, and nothing else.

## Verification

1. A route test sends one request with `channel: instagram` and one with
   `channel: whatsapp` to a single server, with the same reply of four
   messages. It asserts the Instagram response carries four messages, and the
   WhatsApp one a single message holding all four. This is the check that fails
   if capabilities are ever fixed at boot again. Quick replies are not part of
   it: the agent's reply has none to render on any channel.
2. A route test asserts a request without `channel` is rendered as `CHANNEL`,
   and that one naming `telegram`, or a channel outside `CHANNELS`, gets a 400
   after authentication and never reaches the model.
3. A test asserts the registered callback's body carries the turn's channel.
4. An integration test sends a WhatsApp turn and then an Instagram turn for one
   `subscriber_id`. It asserts one conversation, the second turn's history
   holding the first, each turn recording its channel, and the turn cap
   counting both.
5. An outbox test loses the race on an Instagram turn and asserts the trigger
   carries `MANYCHAT_REPLY_FLOW_NS_INSTAGRAM`. Another reads a row without the
   channel field and asserts it is delivered through `MANYCHAT_REPLY_FLOW_NS`.
6. A boot test asserts `CHANNELS=whatsapp,instagram` with deferred delivery
   configured and no Instagram flow fails to start.
7. A worker test over a fake clock queues an Instagram reply whose contact's
   last Instagram turn is 25 hours old and a WhatsApp turn 1 hour old. It
   asserts no ManyChat call is made, the row is dead-lettered as
   `window_closed`, and the conversation escalates.
8. A nudge test asserts `window_closing` on an Instagram nudge is measured from
   the last Instagram turn, not a later WhatsApp one, and that a WhatsApp
   message cancels it as `contact_replied`.
9. A route test sends an invented URL on `020`'s host with an `ig` segment and
   asserts kind `unsupported`, no download, no model call, the URL's shape in
   the log, and no URL in the stored turn or the log.

**What this does not catch.** The per-channel flows live in the tenant's
ManyChat account. A flow authored for the wrong channel, or one whose message
step reads a different field, returns `{"status":"success"}` and sends nothing
useful, exactly as `002`'s Verification admits for WhatsApp. The literal
`channel` in each External Request is also the tenant's: an Instagram flow that
says `whatsapp` is rendered as WhatsApp, and only someone reading the contact's
Instagram closes that gap. The window is computed from this service's own record
of inbound turns. A message the contact sent to a flow that never called this
service opens a window it cannot see, so the check errs towards dead-lettering a
reply that could have been sent, which is the failure C6 prefers.
