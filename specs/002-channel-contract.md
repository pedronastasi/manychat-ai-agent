---
status: implemented
implemented: 2026-09-14
pr: 1
constitution: [C7]
adr: [0001, 0004, 0005, 0012]
---

# 002 — Channel Contract (ManyChat / WhatsApp)

Defines the wire contract between the chat platform and this service, and the
latency budget every inbound request must respect.

## Integration point

ManyChat **Dynamic Block** (Dev Tools). ManyChat POSTs to our HTTPS endpoint and
renders the JSON we return. Dev Tools require a **ManyChat Pro** plan.

- Endpoint: `POST /v1/channels/manychat/message`
- Auth: shared secret in a request header, configured in the Dynamic Block UI.

## Authentication and its limits

ManyChat does **not** sign its requests (no HMAC, no timestamp nonce). The only
available mechanism is a static secret header that ManyChat sends verbatim.

Consequences, first accepted in ADR-0006 (superseded by ADR-0012):

- The secret is a bearer credential. TLS is mandatory; it is the only thing
  preventing replay.
- Compared with `crypto.timingSafeEqual`, never `===`.
- Rotatable via env without redeploying ManyChat flows (two valid secrets during
  a rotation window).

The secret proves the caller holds it, and nothing about which contact the
request speaks for. The checks every request passes, and the controls that bound
a leaked secret, are specified in
[`017-inbound-request-trust.md`](017-inbound-request-trust.md). The contact
token ManyChat holds and sends back (ADR-0012) is specified in
[`019-contact-tokens.md`](019-contact-tokens.md).

## Response contract (Dynamic Block v2)

```jsonc
{
  "version": "v2",
  "content": {
    "messages": [/* ≤ 10 */],
    "actions": [/* ≤ 5  */],
    "quick_replies": [/* ≤ 11 — NOT on WhatsApp, see below */],
    "external_message_callback": {/* optional */},
  },
}
```

`messages` is empty only when a flow the turn sent is still playing and the
reply follows it from the outbox; `external_message_callback` is registered
all the same (`030`).

### Channel capability matrix

| Capability     | WhatsApp | Instagram | Messenger | Telegram |
| -------------- | -------- | --------- | --------- | -------- |
| Quick replies  | **no**   | yes       | yes       | **no**   |
| Buttons / text | 3        | 3         | 3         | 10       |
| Messages       | 10       | 10        | 10        | 10       |
| Actions        | 5        | 5         | 5         | 5        |

WhatsApp is the target channel. **Emitting `quick_replies` on WhatsApp is a
silent failure** — ManyChat accepts the payload and the contact never sees them.
The renderer must omit the key entirely rather than send an empty array.

All URLs must be HTTPS. Media ≤ 25 MB.

## Owning the conversation loop

The response may include `external_message_callback`, which registers a URL that
ManyChat calls when the contact sends their **next** message (`timeout` in
seconds, default and max 86400). `{{last_input_text}}` in the payload is replaced
with the contact's message text, and `{{ai_token}}` with the contact's token
from their custom field (specs/019).

This is what keeps the conversation loop in this service rather than in
ManyChat's visual flow builder, and is the reason the agent stays portable across
channels. Re-register it on every turn.

## Latency budget (Constitution C7)

```
ManyChat hard timeout              10 000 ms
├─ race deadline                    8 000 ms   Promise.race resolves here
└─ reserve: network, render, db     2 000 ms

model abort (safety net)           30 000 ms   AFTER the deadline, not before
```

**The abort must fire after the race deadline, never before.** Losing the race
does not cancel the model call — it keeps running and delivers through the
outbox, which is the entire mechanism of ADR-0001. An abort set below the
deadline kills every slow turn instead, and the deferred path can never run.
`EnvSchema` enforces the ordering, so a bad pairing fails at boot.

**Race won** — render the reply inline, re-register `external_message_callback`.
A turn that sent a flow holds the response until the flow has played, never
past the deadline; one that would play past it is delivered through the outbox
when the flow ends (`030`).

**Race lost** — return a short acknowledgement immediately. The in-flight model
call continues and writes its result to the `outbox` table; a worker delivers it
as described below. The reply is never dropped, only deferred. When a flow the
turn sent is still playing, the response carries no message instead: the flow
is the holding line (`030`).

## Deferred delivery goes through a flow, not the Send API

The reflexive choice is `POST /fb/sending/sendContent` — ManyChat's own endpoint
for sending a message, one call, the obvious counterpart to the inbound webhook.
It is rejected.

WhatsApp permits free-form messages only within 24 hours of the contact's last
inbound message; outside that window Meta allows only pre-approved templates.
This is Meta's platform policy, not a ManyChat limitation. `sendContent` enforces
it by refusing the send:

```jsonc
{
  "status": "error",
  "message": "Content can’t be sent to the subscriber without a message tag. Subscriber’s last interaction was over 46h ago (more than 24 hours ago)",
  "code": 3011,
}
```

The escape hatch that used to exist — `message_tag` — is gone: ManyChat now
rejects the field outright ("Message tags are no longer supported"). So
`sendContent` has no way to reach a contact who has gone quiet, and a reply the
agent has already generated and charged for is undeliverable.

Delivery is therefore **two calls**: write the reply text to a per-subscriber
custom field, then trigger a flow whose message body renders that field.

| Step | Endpoint                                   | Carries                                 |
| ---- | ------------------------------------------ | --------------------------------------- |
| 1    | `POST /fb/subscriber/setCustomFieldByName` | `subscriber_id`, field name, reply text |
| 2    | `POST /fb/sending/sendFlow`                | `subscriber_id`, `flow_ns`              |

A flow may contain a template, which is what lets it leave the 24-hour window.
Because the message body is a variable rather than literal text, the flow
delivers model output that did not exist when the flow was authored.

Verified against a live account on 2026-09-15: a contact whose last interaction
was 640 hours earlier — unreachable by `sendContent` — received the text through
this path.

## The reply field is per-subscriber, never a bot field

ManyChat exposes two kinds of variable, and only one is safe here.

|                       | Bot field                    | Custom field                          |
| --------------------- | ---------------------------- | ------------------------------------- |
| Endpoint              | `/fb/page/setBotFieldByName` | `/fb/subscriber/setCustomFieldByName` |
| Scope                 | the whole account            | one contact                           |
| Takes `subscriber_id` | no                           | yes                                   |

A bot field holds one value for the entire account. Two conversations in flight
would overwrite each other between step 1 and step 2, and the contact whose flow
fires second receives **the other contact's reply**. That is a disclosure of one
customer's conversation to another, so it violates Constitution C5 rather than
merely producing a wrong answer.

The absence of `subscriber_id` in the bot-field endpoint is the tell: an API that
is not told who the value belongs to cannot be storing it per contact.

## The two calls are one delivery

Steps 1 and 2 are not atomic. A failure between them leaves the field set and
nothing sent; a retry that assumes the field survived may send whatever the
field holds now, which after an intervening turn is the wrong reply.

Therefore: **the field is re-set immediately before every trigger, including
every retry.** The outbox row is the only durable record of what should be sent;
the custom field is scratch space and is never read back as a source of truth.

A partial delivery counts as a failed attempt and re-enters the retry schedule
whole. Retry and dead-lettering are unchanged — see ADR-0004.

## Messages to one contact are paced

A deferred reply of several messages used to go out back to back, a field write
and a trigger per message with nothing between them. Two replies queued for one
contact, a race lost on each of two messages or both waiting out the same flow
(`030`), then arrived as one burst of seven messages, the first reply's
question followed at once by the second reply.

**A delay in the tenant's flow is not the fix.** The flow reads the field when
its message step runs. A wait before that step lets the agent write the next
message, and then the reset value, into the field while the flow waits, so
the contact receives the last message several times, or the reset value itself.
Observed on a live account on 2026-10-06, and undone the same day.

So the agent paces, per contact, `MANYCHAT_REPLY_GAP_MS` (default 2000, at most
10000):

- Each message of a reply after the first is written that long after the
  previous message's flow was triggered. This also gives a flow time to read
  the field before the next message overwrites it.
- A contact's next reply starts that long after the previous one ended. The
  caller of the previous reply is not held for the gap; only the contact's
  next send is.
- One contact never waits for another. The worker delivers each contact's rows
  in the order they were written, and different contacts at the same time.

What this does not cover:

- **Inline replies.** ManyChat renders the Dynamic Block's messages itself, and
  the agent cannot space them.
- **Two processes delivering to one contact.** The pacing lives in the process
  that sends. A deployment with more than one worker can still send two
  replies to one contact back to back.
- **What the second reply says.** Pacing spaces the burst; it does not stop a
  reply written without the one before it in its history from repeating it.
  That is ordering turns per contact, a separate spec.

## Inbound payload

ManyChat sends the fields configured in the Dynamic Block UI. We require at
minimum a stable subscriber identifier and the message text. The body also
carries `"ai_token": "{{ai_token}}"`, the contact's token, without which a
request reads none of the contact's history (specs/019). A tenant with a course
field adds `"course": "{{course}}"`, rendered from that field (specs/028): it is
optional, and an empty, unrendered or unknown value is treated as no course
rather than refused. The reply's callback asks ManyChat for both. Inbound schemas are
`.strict()`: unknown keys are rejected rather than silently ignored, so a
ManyChat-side change surfaces as a 400 instead of as degraded behavior.

## Verification

The channel port is stubbed by the outbox suite, so no test there sees the wire
format. These are the checks that would actually catch a violation:

1. A unit test over `fetchImpl` pins both request bodies: the custom-field write
   carries `subscriber_id`, and the flow trigger carries `subscriber_id` and
   `flow_ns`. This is the check that a stale field like `message_tag` defeated
   for as long as nothing asserted the bytes.
2. A test asserts the field write targets `/fb/subscriber/…` and **not**
   `/fb/page/…`. A path-level assertion is used deliberately: the two endpoints
   accept near-identical bodies, so only the URL distinguishes a per-contact
   write from an account-global one.
3. A test drives two subscribers through one worker batch and asserts each
   trigger was preceded by a field write carrying **that** subscriber's text.
   This is what fails if the implementation ever hoists the field write out of
   the per-row loop.
4. A test asserts a retry re-writes the field rather than only re-triggering.
5. Tests over fake timers assert the gap before each message after the first,
   before a contact's next reply but not after the caller's own, never
   between two contacts, and after a failed reply as after a delivered one.
6. A worker test holds one contact's first reply and asserts another contact's
   is delivered meanwhile, and the held contact's second reply only after its
   first. A queue test asserts a claimed batch reads back in the order written.

What this misses: none of it proves WhatsApp delivered anything. ManyChat
returns `{"status":"success"}` when it accepts a trigger, and acceptance is not
delivery — a misconfigured flow, an unapproved template or a variable pointing
at the wrong field all return success and send nothing useful. Only a human
reading a phone closes that gap, and no test in this repository can.

Equally: the flow and the custom field live in the tenant's ManyChat account,
not in this repository. Renaming either breaks delivery at runtime with no
failing test anywhere. The runtime symptom is a dead-lettered outbox row whose
`last_error` names the rejected field or flow.
