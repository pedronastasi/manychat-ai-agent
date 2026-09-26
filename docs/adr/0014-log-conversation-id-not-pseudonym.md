# ADR-0014 — Logs identify a contact by the conversation's random ID, not a hash of the subscriber ID

**Status:** accepted · **Date:** 2026-09-26

## Context

Constitution C5 keeps PII out of logs, but following one contact's turns
through the logs needs a stable identifier. Today that is `pseudonymize`: a
32-bit FNV-1a hash of `TENANT_ID:subscriber_id`. FNV is not a cryptographic
hash, 32 bits collide, and the salt is ordinary configuration. ManyChat
subscriber IDs are numeric, so anyone holding the logs can hash every candidate
ID and recover the real one.

The reflexive fix is a salted SHA-256. A salt defeats precomputed tables, not
enumeration: with the salt known and the input space this small, every ID is
hashed in minutes. The real alternative is an HMAC under a secret key, which
works. Its case is that it can be computed before any database write, so every
log line carries it, including a request whose database write failed. It is
rejected because it is a secret to manage and rotate, for an identifier the
database already provides. `conversations.id` is a random UUID, one per
contact, stable for as long as the row exists.

## Decision

Log lines about a turn carry `conversation`, the row's UUID, and no value
derived from the subscriber ID reaches the logs.

## Consequences

- Nothing in the logs can be reversed to a subscriber ID. Mapping a
  conversation to its contact requires the database, which already holds
  `subscriber_id`.
- No key to manage, and correlation never breaks across a rotation.
- `pseudonymize` is removed.
- Cost: the identifier exists only after `startTurn` writes the row. A request
  that fails before that, such as when the database is down, logs no contact
  identity. Authentication and rate-limit rejections never had a trusted one.
- Revisit if requests that fail before the database write ever need
  correlating by contact. A keyed HMAC is then the answer.
