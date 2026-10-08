---
status: implemented
implemented: 2026-10-03
pr: 151
constitution: [C1, C3, C6]
adr: [0015]
---

# 028 — Multi-Offering Funnels

> Written for a tenant that sells courses; `042` renamed the course to the
> offering throughout, and the rules below are unchanged by it.

Defines how one deployment sells several catalog offerings through one funnel:
an offering field set by the entry flow or the agent, content flows tied to an
offering, and the rule for when the offering may change. It amends `023` in two
places and `002` in one, listed at the end, and leaves out a separate funnel
stage per offering, bundles and cross-selling (one offering per contact at a time),
and a separate payment flow per offering.

## One deployment per offering splits the contact in two

`023` assumes one sale per deployment: one `funnel` field, one set of content
flows, one payment-link flow. A tenant running ads for two offerings has two
reflexive ways to fit that.

**A deployment per offering.** Each has its own `tools.json` and its own
database. But a contact is one WhatsApp number in one ManyChat account: the
same person who came from the first offering's ad and asks about the second has
two histories, two funnel stages and two turn caps, and the deployment they
reach depends on which ad they clicked last. Neither copy of the agent knows
what the other said.

**One flat flow list.** Every offering's syllabus and results go into one
`flows[]`, with descriptions that name the offering. The model then chooses
between near-identical entries ("syllabus, course A" and "syllabus, course
B") on wording alone, and a wrong pick sends the other offering's content with
no check to stop it. `023`'s sent-once rule makes it worse: the right flow is
still available, but the agent believes the syllabus was sent.

So **the offering is a recorded fact about the contact, and the server, not the
model, decides which flows that fact makes available.**

## The offering is an enum of catalog ids, set by the entry flow or by the agent

`fields[]` gains an optional marker, `"offering": true`, on at most one field
(`"course": true` before `042`).
Its `values` must be exactly the `catalog.json` offering ids, in any order, or
the file fails at load, so the field cannot name an offering the agent cannot
quote a price for (C6). A `flows[].offering` must be one of those ids too, and a
flow may carry one only when a field is marked `offering`: without it no turn has
an offering, and the flow could never be sent.

```jsonc
{
  "fields": [
    {
      "id": "course",
      "field": "course",
      "offering": true,
      "values": ["foundation", "advanced", "weekend-intensive"],
      "description": "The course this contact is buying. Set it as soon as the contact chooses one.",
    },
  ],
}
```

The offering is set from either side:

- **The entry flow.** A campaign's entry flow in the tenant's ManyChat account
  sets the field before the contact reaches the agent, so a lead from an offering's
  ad starts on that offering.
- **The agent.** With `set_field`, like any `012` field, once the contact
  chooses or the fit is clear. Qualifying for an offering is `023 § Qualify before
sending content`; this field is where its answer goes.

### The server learns the offering from the inbound request

Filtering flows needs the offering before the model runs, and `get_contact` runs
inside the loop, when the tools are already built (ADR-0016). So the Dynamic
Block request gains an optional `"offering": "{{offering}}"`, rendered by
ManyChat from the contact's field (`"course"` before `042`, still read when
`offering` is absent, as `002` says). It is validated against the offering enum (C3). An
empty, unrendered (`{{offering}}`) or unknown value is treated as absent, never
as an offering. The reply's `external_message_callback` asks for the same key, so
the contact's next message carries it too.

The conversation row keeps the current offering, updated from each inbound
value and from each `performed` write to the offering field. Inbound wins when
both exist: it is ManyChat's value at request time, which already includes
every write this service performed. A nudge turn (`025`), which has no inbound
request, uses the stored value. The inbound value narrows the turn's flows
whether or not the request carried the contact's token (`019`), but only a
bound request stores it: an unbound one must not change the contact's own
state. A stored offering the catalog no longer has, after a reload drops it, is
treated as no offering until a request carries one.

## A flow belongs to one offering or to all

`flows[]` entries gain an optional `offering`, a catalog offering id. An entry
without one serves every offering (an intro audio, testimonials that are not
offering-specific, the payment-link flow).

`send_flow` accepts a flow only if it has no `offering` or its `offering` is the
turn's offering: the one staged on the offering field earlier in the same turn, or
else the contact's current offering. Anything else returns `{ staged: false }`,
or `{ sent: false }` on an inbound turn, where a flow is sent when called
(`029`).
A turn with no known offering accepts only flows without one, so the agent's
first job with an unplaced lead is to place them.

The tool's description lists every flow it can accept on the turn, with its
offering, and omits the others. A flow becomes available in the same turn the
agent sets its offering; the tool result of that `set_field` lists the flows it
made available, as `flowsAvailable`. So that it can, `send_flow`'s enum holds
every unsent flow of every offering, and the refusal is in the tool, not the
schema.

## The offering may change until the offer, and is locked after it

A contact who asked about one offering and turns out to fit another is normal,
and the agent may move them: a `set_field` on the offering field is accepted
while the funnel stage is before `offered`.

From `offered` onward the offering is locked, counting a payment link sent or in
flight this turn at `link_sent` (`029`). A write to it returns
`{ staged: false }`, and the system instructions tell the model to escalate
as `explicit_request` when the contact asks to switch. At that point an offering
and its catalog price have been put to the contact, and from `link_sent` a
payment link for it has been sent. A model that silently switches offering
after that leaves the contact holding one offering's price and another's
payment link; a person deciding the switch costs one handoff.

The entry flow is not bound by the lock: it writes ManyChat directly, and a
contact who clicks a second offering's ad mid-sale arrives with the new offering
on the inbound request. The server takes it and records the change in the
conversation row; the stage is not reset (`023`'s stage only moves forward).
The system instructions tell the model, when the inbound offering differs from
the one it last saw, to confirm which offering the contact wants before
continuing.

## Sent once means once per contact, whatever the offering

`023 § Every content flow is a leaf, sent once` removes a performed flow from
the contact's `send_flow` enum. An offering change does not restore it: a flow
the contact received is still in their chat. Offering-specific flows of the new
offering were never sent, so they are available; shared flows already sent stay
sent.

## One payment flow serves every offering; the offering is in the field

`023` allows exactly one `payment_link` flow, and that stays. It carries no
`offering`. The tenant's flow reads the offering field and branches inside
ManyChat to the right payment link. That branching is the tenant's, and nothing
here can see it.

Because the offering is locked from `offered`, the field the payment flow reads
is the one the agent offered. A deployment that wants a payment flow per offering
instead is out of scope here: it would make `role: "payment_link"` per offering,
which `023` refuses.

## What this changes elsewhere

- `023 § Every content flow is a leaf, sent once`: availability of a flow also
  depends on its `offering`, as above.
- `023 § The funnel is a field the agent moves`: a second marked field,
  `offering`, may exist beside `funnel`. They may not be the same field.
- `002 § Inbound payload`: the strict inbound schema gains the optional
  `offering` key.
- `003` documents `fields[].offering` and `flows[].offering`.

These are edited in the pull request that implements this spec.

## Verification

1. Config tests assert two `offering` fields, an `offering` field whose values
   differ from the catalog's offering ids, a `flows[].offering` that is not a
   catalog id, and one field marked both `funnel` and `offering`, each fail at
   load.
2. A unit test asserts `send_flow` refuses another offering's flow, accepts a
   flow without an `offering` on a turn with no known offering, and accepts the new
   offering's flow after `set_field` on the offering field earlier in the turn.
3. A unit test asserts a write to the offering field returns `{ staged: false }`
   once the stage is `offered` or later, and is accepted before it.
4. A contract test asserts the inbound `offering` is accepted when it is a
   catalog id and treated as absent when empty, unrendered or unknown.
5. An integration test against PGlite asserts the conversation's offering is
   updated from inbound values and from `performed` writes, that inbound wins,
   and that a nudge turn uses the stored value.
6. A unit test asserts a shared flow sent before an offering change is not
   offered after it, and the new offering's flows are.
7. Golden eval cases, demo tenant: a lead with no offering asks for the
   syllabus and is asked which offering first; a lead on one offering asks about
   another before the offer and the offering is switched; the same after the
   offer escalates as `explicit_request`.

What this misses: the payment flow's branching on the offering field is inside
ManyChat, and a branch that sends the wrong link passes every check here. The
entry flow's field write is the tenant's too; an ad whose entry flow sets no
offering, or the wrong one, is invisible until a person reads the conversation.
And whether the agent places an undecided lead on the right offering is a
judgement no assertion makes; evals sample it.
