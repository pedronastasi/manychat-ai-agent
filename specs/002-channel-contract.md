---
status: implemented
implemented: 2026-09-14
pr: 1
constitution: [C7]
adr: [0001, 0004, 0005, 0006]
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

Consequences, accepted in ADR-0006:

- The secret is a bearer credential. TLS is mandatory; it is the only thing
  preventing replay.
- Compared with `crypto.timingSafeEqual`, never `===`.
- Rotatable via env without redeploying ManyChat flows (two valid secrets during
  a rotation window).
- Requests are also rate-limited per IP and per subscriber, so a leaked secret
  is bounded in blast radius rather than unlimited.

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
with the contact's message text.

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

**Race lost** — return a short acknowledgement immediately. The in-flight model
call continues, writes its result to the `outbox` table, and a worker delivers it
via the ManyChat Send API (`sendContent`, Bearer auth, ~25 rps). The reply is
never dropped, only deferred.

## WhatsApp 24-hour window

WhatsApp permits free-form messages only within 24h of the contact's last
message; outside it, only approved templates may be sent.

The deferred push lands seconds after the inbound message, so it is always inside
the window. This constraint binds only if proactive follow-ups are added later —
that feature would require template management and is explicitly out of scope.

## Inbound payload

ManyChat sends the fields configured in the Dynamic Block UI. We require at
minimum a stable subscriber identifier and the message text. Inbound schemas are
`.strict()`: unknown keys are rejected rather than silently ignored, so a
ManyChat-side change surfaces as a 400 instead of as degraded behavior.
