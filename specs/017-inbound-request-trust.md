---
status: specified
constitution: [C5, C6]
adr: [0012, 0013, 0014]
---

# 017 — Inbound Request Trust

Defines what the message endpoint believes about a request: who sent it, which
contact it speaks for, and how much history it may read. It also names the test
that shows each control firing. It deliberately leaves out the deploy pipeline,
dependency scanning, transcript retention, and the race between the budget check
and the spend it records.

## A control that no test fires does not exist

The reflexive way to secure a service is to list its controls. ADR-0006 named a
per-IP and per-subscriber rate limit as what bounds a leaked secret,
`SECURITY.md` repeated it, and `002` promised it. It never ran.
`@fastify/rate-limit` attaches itself to routes as they are declared, and
`buildServer` declared every route before `registerPlugins` registered the
plugin. Measured 2026-09-26: 320 requests to the message endpoint returned 320
× 401 and no 429. The per-subscriber key could not have worked either, because
it read `req.body` in a hook that runs before the body is parsed.

The list was not the problem. What was missing was a test that made the limiter
say no.

So the rule is: **every control this spec, `SECURITY.md` or an ADR relies on has
a test that makes it fire through the production composition.** That means the
`buildServer` a process gets, not an app assembled inside the test. A control
with no such test is removed from the documents rather than listed. Each clause
below names its test in § Verification.

The composition also changes so the ordering cannot go wrong again:
`buildServer` declares routes only after its plugins are registered, which
leaves no call for `main.ts` to make in the wrong order.

## The shared secret proves the caller, not the contact

The body's `subscriber_id` is a claim. Before ADR-0012 the service believed it
from any caller holding the shared secret, so that caller could name any contact
and get a reply built on that contact's last ten turns. Measured 2026-09-26: a
second caller naming a contact's ID had the contact's name and phone number
passed to the model as history.

The shared secret still authenticates every request, entry and callback alike.
What it no longer does is unlock a contact's history. That takes the contact's
token (§ Each contact's token lives in ManyChat, never in a response).

The callback carries back the secret the caller presented. It used to carry
`MANYCHAT_SHARED_SECRET[0]` whichever secret the caller presented, so a caller
holding a retired secret was handed its replacement.

## Each contact's token lives in ManyChat, never in a response

| Property  | Value                                                                                    |
| --------- | ---------------------------------------------------------------------------------------- |
| Token     | 32 random bytes, base64url                                                               |
| Stored    | SHA-256 hash on the conversation row, current and previous                               |
| Held by   | The contact's ManyChat custom field named by `MANYCHAT_TOKEN_FIELD` (default `ai_token`) |
| Written   | `POST /fb/subscriber/setCustomFieldByName`, the per-subscriber endpoint of `002`         |
| Presented | The body field `ai_token`, which ManyChat fills in from the contact's field              |
| Compared  | By hash, in constant time, against the current and the previous hash                     |

- **The Dynamic Block body** carries `"ai_token": "{{ai_token}}"`, set once by
  the operator in the flow. Verified on devtest on 2026-09-26: a field set on a
  real contact arrived in the request.
- **The callback payload** this service writes carries the same variable,
  alongside `text` and `subscriber_id`. Not yet verified; see § Verification.
- `ManyChatInbound` accepts an optional `ai_token` string.
- **No response ever contains a token.** The only way to present one is to be
  the contact ManyChat fills it in for.

A token is issued when the contact has none yet, and again after an unbound
request (§ A request without the contact's current token reads no history), at
most once an hour per contact. Issuing writes the field in parallel with the
model call. A write that has not succeeded by the time the response is returned
is retried through the outbox worker. The previous token stays valid until the
next issue, so a message sent before the new one landed still binds.

## A request without the contact's current token reads no history

| Request                                         | Result                                          |
| ----------------------------------------------- | ----------------------------------------------- |
| No valid shared secret                          | 401                                             |
| The contact has no token issued                 | Starts the contact's history; a token is issued |
| `ai_token` matches the current or previous hash | Bound: reads history, turn recorded as bound    |
| `ai_token` missing or not matching              | Unbound: no history, turn recorded as unbound   |

- An unbound request is answered from its own message alone. Its turns, the
  contact's and the agent's, are stored but never enter history, so a holder of
  the shared secret cannot plant text in a contact's conversation. A fresh token
  is then written to the contact's field, which repairs a cleared field or a
  failed write. It is harmless, because the fresh token goes only to the real
  contact.
- The first request for a contact with no token starts that contact's history,
  and its turns are bound. That is the one place a forger can write: the first
  turn of a contact who has never written, listed in § What a holder of the
  shared secret can still do.
- Every unbound turn is logged, so a flow that stopped sending the field shows up
  as a rising share of unbound turns.

`CONTACT_TOKENS_ENFORCED` (default `true`) exists for the rollout only. Set to
`false`, a matching token still binds, but a missing or wrong one reads history
as before this spec.

## History reaches back 30 days, and the turn cap resets after 24 hours

- The model receives the contact's last ten bound turns recorded in the past
  `rules.historyDays` (integer, default 30). A student who returns after 7 to
  30 days, or replies to a retargeting message, arrives through the Dynamic
  Block carrying their token and gets their context. The 30 days is the
  operator's figure for how long students take to return (2026-09-26), not a
  measurement (ADR-0013).
- `maxTurnsPerConversation` counts the contact's bound turns since the last gap
  of at least `rules.idleResetHours` (integer, default 24). Until now the count
  never reset, and a contact who reached 25 was escalated on every message, for
  good. Unbound turns do not count; the per-contact rate limit bounds them.
- Turns are not deleted. Transcripts must be kept at least `historyDays`.

## Tokens reach existing contacts before they are required

Tokens have to be in ManyChat before any request can carry them. Enforcing them
on the day of the deploy would leave every existing contact unbound, and
everyone would lose context at once. The rollout is:

1. Deploy with `CONTACT_TOKENS_ENFORCED=false`.
2. Run the backfill. It issues a token to every contact with a turn in the past
   `historyDays`.
3. Add `"ai_token": "{{ai_token}}"` to the Dynamic Block body in ManyChat.
4. On devtest, check that entry and callback requests arrive bound, and that no
   contact with a turn in the past `historyDays` lacks a token hash.
5. Set `CONTACT_TOKENS_ENFORCED=true` and restart.

Until step 5 the old exposure remains, and `SECURITY.md` says so. After it, a
contact without a token has either never written or has no turn inside the
history window, so there is nothing to expose.

## Authentication runs before the body is read

The guard is an `onRequest` hook. A request with no valid shared secret gets 401
before its body is parsed or validated.

It used to run as a `preHandler`, after validation, so a caller with no
credential got a 400 naming the schema's fields. Measured 2026-09-26: the
response was `Unrecognized key: "evil"`.

## Rate limiting is attached before any route and keyed on an address the proxy vouches for

- **Per address: 300 requests a minute**, on `onRequest`, so requests that fail
  authentication count too. The figure is today's value in `server.ts` and has
  never been measured against traffic. ManyChat calls from a small set of
  addresses, so every contact shares that budget. Compare it with the peak turns
  per minute in `turns` before relying on it.
- **The address is `req.ip`**, with `trustProxy` set to `TRUST_PROXY_HOPS`
  (integer, default 0) instead of `true`. `true` believed any `X-Forwarded-For`,
  so a caller who rotated the header got a fresh budget on every request
  (measured 2026-09-26). The hop count must match the proxies actually in front
  of the service, which this repository cannot know.
- **Per contact**, the limit stays `rules.rateLimit.turnsPerSubscriberPerHour`,
  enforced by `BudgetGuard` in the database, where the body is available. The
  in-memory limiter's per-subscriber branch is removed; it could never fire.

## An error on the message route is a handoff, not a 500

An unhandled error on `POST /v1/channels/manychat/message` returns 200 with the
tenant's `messages.escalation`, rendered as Dynamic Block v2, so the contact
reaches a person (C6). It used to return Fastify's default 500 body, which
carries the error message. Measured 2026-09-26: a database failure put the
connection error into the response.

- The response body carries no error text. The log line carries the error's
  name and code, and its message passes through `redactText` first (C5).
- The callback is registered as usual. It carries the presented secret and the
  token variable, and neither depends on what failed.
- Every other route answers an unhandled error with 500 and
  `{ "error": "internal" }`.

## Callbacks are HTTPS or the process does not boot

`EnvSchema` requires `PUBLIC_BASE_URL` to start with `https://`. It used to
accept any URL, so `http://` passed boot and then every turn failed when the
response schema refused the callback URL (measured 2026-09-26).

## Logs name the conversation, never the contact

Log lines about a turn carry `conversation`, the row's random UUID. No value
derived from `subscriber_id` is logged, and `pseudonymize` is removed
(ADR-0014). The old pseudonym was a 32-bit FNV-1a hash salted with the public
`TENANT_ID`, and ManyChat IDs are numeric, so enumerating them recovered the ID.

A request that fails before `startTurn` has no conversation, so its log lines
carry no contact identity. Tokens are never logged.

## What a holder of the shared secret can still do

ADR-0012 narrows what a leaked secret gives away; it does not neutralise it.
With the secret and without a contact's token, a caller can no longer read,
extend or reset that contact's history. They can still:

- spend any contact's hourly turn allowance, which escalates them until the hour
  ends;
- have a reply delivered to any contact, because a request that loses the race
  is delivered through the outbox to the named `subscriber_id`;
- spend up to the tenant's daily token and cost caps, after which every contact
  is escalated until the next UTC day;
- write the first turn of a contact who has never written to the bot, which that
  contact will then have in their history;
- cause a token to be reissued at most once an hour per contact, costing a
  contact whose message is in flight at that moment its history for that one
  message.

Rotation is the only remedy for a leak. `SECURITY.md` carries this list.

## Verification

Each clause has a test through `buildServer` that cites its heading here.

| Clause                                 | The test                                                                                                                                                                                     |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rate limiting                          | The 301st request from one address gets 429. With `TRUST_PROXY_HOPS=0`, rotating `X-Forwarded-For` does not reset the count                                                                  |
| Authentication before the body         | No credential and an invalid body gives 401, not 400                                                                                                                                         |
| The shared secret proves the caller    | A request with the second secret gets a callback carrying the second secret                                                                                                                  |
| Token in ManyChat, never in a response | Issuing calls `setCustomFieldByName` with the contact's ID and field. No response in the suite contains an issued token. The callback payload carries the field variable                     |
| No history without the token           | With history seeded, a request with no token and one with a wrong token each reach the runner with empty history, record unbound turns, and do not appear in a later bound request's history |
| Reissue                                | An unbound request writes a fresh token once; a second within the hour writes none; the previous token still binds                                                                           |
| First request for a new contact        | Issues a token and records bound turns that the next bound request sees                                                                                                                      |
| Rollout flag                           | With `CONTACT_TOKENS_ENFORCED=false`, a request without a token reads history                                                                                                                |
| 30 days and 24 hours                   | A bound turn 31 days old is not passed and one 29 days old is. 25 bound turns and then a 25 h gap lets the next turn through. Unbound turns do not count toward the cap                      |
| Handoff, not 500                       | With the store throwing, the response is 200 with the escalation copy and contains no error text                                                                                             |
| HTTPS                                  | `loadEnv` with an `http://` base URL throws `ConfigError`                                                                                                                                    |
| Logs                                   | Captured log lines for a turn carry `conversation` and neither the subscriber ID nor a token                                                                                                 |

What these cannot catch:

- **That ManyChat fills the field into the callback payload.** Every test fakes
  ManyChat. Substitution into the Dynamic Block body was verified on devtest on
  2026-09-26; the callback payload is checked in rollout step 4. If it fails,
  callbacks fall back to a short-lived token in their header (ADR-0012).
- **That the flow keeps sending the field.** If an operator removes it from the
  Dynamic Block body, every contact becomes unbound. Only the logged share of
  unbound turns shows it.
- **The real hop count.** `TRUST_PROXY_HOPS` is set by the deployment. A wrong
  value either lets `X-Forwarded-For` through or keys every request to the
  proxy's address, and no test here sees the proxies.
- **Whether 300 a minute is right.** It is unmeasured; see § Rate limiting.
- **Whether the secret is secret.** These tests prove the service refuses a
  forged claim. Keeping the secret out of other hands is operational.
