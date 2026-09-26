# ADR-0012 — Each contact has a token held by ManyChat, and only a request carrying it reads that contact's history

**Status:** accepted · **Date:** 2026-09-26

## Context

ADR-0006 accepted ManyChat's unsigned webhooks on the grounds that a forged
request "can waste model budget but cannot exfiltrate conversation history".
That is false. The body's `subscriber_id` selects the conversation, and the
model receives that contact's last ten turns as history. Measured 2026-09-26:
a second caller holding the secret and naming a contact's ID had the contact's
name and phone number passed to the model. The callback registered on every
turn also carries `MANYCHAT_SHARED_SECRET[0]` whichever secret the caller
presented, so a caller holding a retired secret is handed its replacement.
ManyChat still offers no request signing.

The reflexive response is to keep the shared secret as the only credential and
correct the documents. The strongest case for it is that only a holder of the
secret can do any of this, and the secret is held by ManyChat and the operator.
It loses because production carries real contacts' conversations, and the
secret is less contained than it looks. It is written into every callback
registration inside ManyChat, and handed back to anyone who authenticates.

The first alternative drafted was a signed token carried in the callback's
headers. It fails the contacts who matter most. A callback lives 24 hours at
most, and students come back 7 to 30 days later, often in reply to a
retargeting message. That reply enters through the Dynamic Block, whose
headers are fixed and can carry only the shared secret. A header token cannot
reach it, so the returning student would get no history at all. It also needed
a signing key whose early rotation refuses every open conversation.

What fixes both is that ManyChat already knows who the contact is. It
substitutes a contact's custom field into a Dynamic Block body. That was
verified on devtest on 2026-09-26, with a field set on a real contact arriving
in the request. Substitution into the callback payload, which this service
writes, has not been verified yet.

## Decision

Each contact has a random token, kept in a ManyChat custom field and stored
here only as a hash. Only a request carrying the contact's current token reads
or extends that contact's history.

## Consequences

- The token never appears in a response. It is written only to the contact's
  ManyChat field, through the API, so the only way to present it is to be the
  contact ManyChat sends it for. A holder of the shared secret can no longer
  read a contact's history, add to it, or reset it.
- A returning contact carries the token in the Dynamic Block body, so history
  survives flow re-entry for as long as ADR-0013 keeps it.
- A request with a missing or wrong token is answered from its own message
  alone. Its turn is recorded but never enters history, and a fresh token is
  written to the contact's field. That repairs a cleared field or a failed
  write, and is harmless, because the fresh token goes only to the real
  contact.
- No signing key. The shared secret still authenticates every request, and the
  callback carries back the secret the caller presented, not always the first.
- Cost: one ManyChat API write when a token is issued. Nothing else changes
  per turn.
- Cost: the security now rests on ManyChat substituting the field. The flow's
  Dynamic Block body must include it, and if an operator removes it every
  contact becomes unbound: no history, until someone notices.
- Cost: landing it takes a flag and a backfill rather than one deploy. Tokens
  must reach existing contacts' fields before the Dynamic Block starts sending
  them, or everyone loses context at once.
- Residual: a holder of the shared secret can still spend a contact's hourly
  allowance, have a reply delivered to any contact, spend up to the daily caps,
  and plant the first turn for a contact who has never written.
- If ManyChat turns out not to substitute custom fields into the callback
  payload, callbacks fall back to a short-lived token in their header, issued
  from the same stored hash. The decision stands.
- Revisit if ManyChat adds request signing, if unbound turns from real contacts
  show up often enough to matter, or if a second channel adapter brings its
  own identity.
