# ADR-0017 — The agent may write bounded free-text notes that no flow renders

**Status:** accepted · **Date:** 2026-10-02

## Context

`012 § Free-text field values are refused` limited `set_field` to configured
enum values, for two reasons: a free-text write puts unvalidated model output
into a field a ManyChat flow may later render to the contact, which bypasses
C3; and it invites the model to copy the contact's own words, names and
phone numbers included, into the CRM.

ADR-0015 removes the human from most of the sale, and with them the person who
used to remember why a lead was interested and what held them back. An enum
cannot hold that. "Wants to work from home but is worried about the schedule"
is the useful sentence, and no tenant can list it in advance.

The reflexive option is to keep `012`'s rule and widen the enums. Its case:
nothing unvalidated ever reaches the CRM, and an enum is trivially safe to
render. It was turned down because the enums that would capture motivation and
objections either grow without bound or collapse to `other`, which tells the
human nothing.

## Decision

The agent may write free text only to a fixed set of note fields that the
tenant declares are never rendered to the contact, with the length capped and
contact identifiers stripped before the write.

## Consequences

- Enum fields keep `012`'s rule. Free text is a separate kind of field in
  `tools.json`, so it cannot be enabled by mistake on an existing field.
- Cost: C3 now holds only by the tenant's word. Nothing in this repository can
  see whether a ManyChat flow renders a note field, so a tenant who builds one
  that does sends model output to a contact unchecked. `024` says so rather
  than claiming a check it cannot make.
- Cost: notes can carry PII the stripping misses: a name, a town, a health
  detail. They are redacted from logs and from the `turns.actions` record
  (C5), but they do reach the tenant's CRM, which is outside this service's
  control.
- Revisit if a note is ever found rendered to a contact, or if the stripping is
  found to let a phone number or email through on a real conversation. Either
  means the enum-only rule comes back.
