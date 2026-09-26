---
status: specified
constitution: [C5]
adr: [0012, 0013]
---

# 019 — Contact Tokens

Defines which contact a request speaks for, and so whose history it may read:
the per-contact token ManyChat holds and sends back, what a request without it
gets, and how tokens reach existing contacts before they are required. The
checks every request passes first are `017`, and how far back history reaches is
`018`.

## The shared secret proves the caller, not the contact

The body's `subscriber_id` is a claim. Before ADR-0012 the service believed it
from any caller holding the shared secret, so that caller could name any contact
and get a reply built on that contact's last ten turns. Measured 2026-09-26: a
second caller naming a contact's ID had the contact's name and phone number
passed to the model as history.

The shared secret still authenticates every request, entry and callback alike
(`017`). What it no longer does is unlock a contact's history. That takes the
contact's token.

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
  alongside `text` and `subscriber_id`, including on the handoff `017` returns
  for an error. Not yet verified; see § Verification.
- `ManyChatInbound` accepts an optional `ai_token` string.
- **No response ever contains a token**, and no log line does. The only way to
  present one is to be the contact ManyChat fills it in for.

A token is issued when the contact has none yet, and again after an unbound
request (§ A request without the contact's current token reads no history), at
most once an hour per contact. Issuing writes the field in parallel with the
model call. A write that has not succeeded by the time the response is returned
is retried through the outbox worker. The previous token stays valid until the
next issue, so a message sent before the new one landed still binds.

## A request without the contact's current token reads no history

| Request                                         | Result                                          |
| ----------------------------------------------- | ----------------------------------------------- |
| No valid shared secret                          | 401 (`017`)                                     |
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

## Only bound turns enter history and the turn cap

`018`'s history window and turn cap count bound turns only. Unbound turns do not
count toward the cap; the per-contact rate limit bounds them. Until this spec is
implemented, every turn counts as bound.

## Tokens reach existing contacts before they are required

Tokens have to be in ManyChat before any request can carry them. Enforcing them
on the day of the deploy would leave every existing contact unbound, and
everyone would lose context at once. The rollout is:

1. Set `CONTACT_TOKENS_ENFORCED=false` in the deployment, then deploy. The
   default is `true`, so the order matters.
2. Run the backfill. It issues a token to every contact with a turn in the past
   `historyDays`.
3. Add `"ai_token": "{{ai_token}}"` to the Dynamic Block body in ManyChat.
4. On devtest, check that entry and callback requests arrive bound, and that no
   contact with a turn in the past `historyDays` lacks a token hash.
5. Set `CONTACT_TOKENS_ENFORCED=true` and restart.

Until step 5 the old exposure remains, and `SECURITY.md` says so. After it, a
contact without a token has either never written or has no turn inside the
history window, so there is nothing to expose.

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

| Clause                                 | The test                                                                                                                                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token in ManyChat, never in a response | Issuing calls `setCustomFieldByName` with the contact's ID and field. No response or captured log line in the suite contains an issued token. The callback payload carries the field variable |
| No history without the token           | With history seeded, a request with no token and one with a wrong token each reach the runner with empty history, record unbound turns, and do not appear in a later bound request's history  |
| Reissue                                | An unbound request writes a fresh token once; a second within the hour writes none; the previous token still binds                                                                            |
| First request for a new contact        | Issues a token and records bound turns that the next bound request sees                                                                                                                       |
| Rollout flag                           | With `CONTACT_TOKENS_ENFORCED=false`, a request without a token reads history                                                                                                                 |
| Bound turns only                       | Unbound turns neither enter history nor count toward the turn cap                                                                                                                             |

What these cannot catch:

- **That ManyChat fills the field into the callback payload.** Every test fakes
  ManyChat. Substitution into the Dynamic Block body was verified on devtest on
  2026-09-26; the callback payload is checked in rollout step 4. If it fails,
  callbacks fall back to a short-lived token in their header (ADR-0012).
- **That the flow keeps sending the field.** If an operator removes it from the
  Dynamic Block body, every contact becomes unbound. Only the logged share of
  unbound turns shows it.
- **Whether the secret is secret.** These tests prove the service refuses a
  forged claim. Keeping the secret out of other hands is operational.
