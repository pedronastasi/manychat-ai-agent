---
status: implemented
implemented: 2026-10-15
constitution: [C3, C6, C8]
---

# 045 — A Tenant Can Keep the Offering Open After the Offer

Defines an opt-in that lifts `028`'s offering lock for a tenant whose payment
does not depend on the offering field. It leaves out the lock's default, which
is unchanged, and any change to how a stage moves (`023`).

## The lock is right for some tenants and a needless handoff for others

`028 § The offering may change until the offer, and is locked after it` locks
the offering from `offered` and has the model escalate a switch as
`explicit_request`. The reason is the payment flow: it branches on the
offering field inside ManyChat, so a silent switch after the offer would leave
the contact holding one offering's price and another's payment link.

That reason does not hold for a tenant whose agent writes each offering's
payment link in its reply, from the catalog, and whose `payment_link` flow
only records the checkout. For that tenant a contact who asked about one
offering and then asks about another, even after a price or a link, is an
ordinary question the catalog answers. Escalating it hands a person a
conversation the agent could have kept, and the `044` overrides cannot lift
it: offering locks are framework-owned.

## `switchable` on the offering field lifts the lock

The field marked `offering` may also carry `"switchable": true`. Any other
field carrying it fails at load (C3). With it:

- a `set_field` on the offering field is accepted at every stage, `offered`,
  `prepared` and `link_sent` included;
- the OFFERING RULES say the offering may change at any stage, that a
  question about another offering or a switch to it is not a reason to
  escalate, and that the model records the new offering and continues the
  sale with it.

Without it, or with `false`, `028` applies unchanged.

Nothing else moves. The funnel stage still only moves forward (`023`), so a
switch after `offered` does not walk the stage back and fires no second
conversion event (`027`). A flow already sent stays sent (`028 § Sent once
means once per contact`), the `payment_link` flow among them: a tenant that
turns this on writes the new offering's link itself. That is the condition
for turning it on, and the tenant's own spec records that it holds. The
inbound offering change of `028` (a second advert) is handled as before.

## Verification

1. A `set_field` on a switchable offering field is staged at every funnel
   stage, and one on a field without the flag is still refused from
   `offered`.
2. The system prompt of a switchable tenant says a switch is not a reason to
   escalate and carries no lock sentence; without the flag it carries `028`'s.
3. `switchable` on a field not marked `offering` fails validation.
4. The mock model switches a contact past the offer only when the prompt does
   not lock the offering.
