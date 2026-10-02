---
status: implemented
implemented: 2026-10-02
constitution: [C1, C6, C9]
adr: [0015]
---

# 023 — Sales Funnel

Defines how the agent takes a new lead from first reply to the payment-link
flow: the funnel stage it keeps, the order it works in, what it may say to
close, and how success is measured. It leaves out reading the contact's record
and free-text notes (`024`), following up a lead who went quiet (`025`),
anything after the payment link (a human confirms payment), and every message
outside WhatsApp's 24-hour window.

## A fixed drip sends the same content to every lead

The reflexive sales automation is a sequence: on entry, send the syllabus,
wait, send the FAQ, wait, send the results, wait, send the testimonials. Every
lead gets every piece, in the same order, on a timer. It is the default in
every chat-marketing builder, and it is what a tenant typically runs before
this service exists.

It is wrong here for three reasons. It answers no question: a lead who asked
"is it online?" gets the syllabus first. It cannot stop: a lead who said "send
me the link" still gets four more messages. And it collides with the agent:
since `012` the agent can send the same flows, so a drip running beside it
sends each piece twice.

So the drip is retired, not supplemented. **Each piece of the drip becomes a
flow in `tools.json` that the agent sends when the conversation calls for it,
and the entry flow hands the contact to the agent instead of starting a
sequence.** That change is made in the tenant's ManyChat account, not here,
and is a precondition of rollout: an agent and a drip on the same contact is
the duplication described above.

## The funnel is a field the agent moves, not a sequence the contact is pushed through

The agent's position in the sale is a `set_field` enum field from `012`,
declared with `"funnel": true` in `tools.json`. Its values are the stages, in
order:

| Stage        | Meaning                                                     |
| ------------ | ----------------------------------------------------------- |
| `new`        | The contact has replied; nothing is known about them yet    |
| `qualifying` | The agent is asking what it needs to choose a course        |
| `nurturing`  | The agent knows the fit and is sending content to build it  |
| `offered`    | A course and its catalog price have been put to the contact |
| `link_sent`  | The payment-link flow was performed                         |

`enrolled` exists in the tenant's ManyChat account but is **not** in the
agent's enum. Only a human who has seen the payment sets it.

The stage only moves forward. A staged write to a stage earlier than the last
one recorded as `performed` for this contact is refused with
`{ staged: false }`, so a confused turn cannot send a lead back to
`qualifying` after the offer. Only one field per `tools.json` may be marked
`funnel`, and a marked field must list its values in funnel order; both are
checked at load.

`link_sent` is never staged by the model. It is written by the server when the
payment-link flow is performed (see "The sale ends at the payment-link flow"),
and is removed from the model's enum.

## Every content flow is a leaf, sent once

A content flow must not start another flow. If the syllabus flow ends by
starting the FAQ flow, the agent believes it sent one piece and the contact
received two, and the `012` history note is wrong from then on. This is a
rule for the tenant's flows, and nothing in this repository can see inside
them.

Each `flows[]` entry is sent at most once per contact. A flow recorded as
`performed` for this contact within the history window (`018`) is removed
from `send_flow`'s enum, so a repeat is unrepresentable rather than
discouraged. A flow marked `"repeatable": true`
is exempt; the payment-link flow is the expected case.

## Qualify before sending content

Content chosen without knowing the lead is the drip again, one piece at a
time. So the system instructions tell the model to learn, before the first
content flow, the facts the tenant's qualification fields ask for, and to
record them with `set_field` as it learns them. Which facts those are is
tenant configuration: the demo tenant asks for prior experience
(`none`, `some`) and preferred schedule (`weekday_evenings`, `weekends`).

The model asks one question per turn, not a form. A contact who asks a direct
question gets the answer first; qualification never delays a grounded answer.
A contact who asks for the link before qualifying gets the link.

## The agent asks for the sale, and never invents a reason to buy now

Once the stage is `offered`, the agent's closing question asks for the
enrolment, plainly. That is the change ADR-0015 makes.

What it may not do is unchanged from `001`: no invented urgency, no
"only two places left" or "price goes up Friday" unless that exact fact is in
the catalog, no promised job outcome, no claim of being human. A model asked
to sell reaches for these first, so they are named in the system
instructions, and the golden set carries a case for each.

## Objections are answered from the catalog; anything else still escalates

`catalog.json` gains an optional `paymentOptions` list: one entry per option
the tenant offers (instalments, a deposit, a private-class rate), each an `id`
and a tenant-language `description`. `003` is amended to add it in the pull
request that implements this spec.

| The contact says                             | The agent                                                                    |
| -------------------------------------------- | ---------------------------------------------------------------------------- |
| "It's too expensive" / "can I pay in parts?" | Presents the catalog's `paymentOptions`, if any                              |
| "I don't have time" / "I'm not sure I can"   | Sends the content flow that addresses it, if not yet sent                    |
| "Can you do it cheaper?" / "any discount?"   | Escalates as `price_negotiation`, unless a `paymentOptions` entry answers it |
| Anything the catalog cannot answer           | Escalates as `out_of_scope`, as today                                        |

A payment option the tenant has published is a catalog fact, not a
negotiation. With no `paymentOptions`, "can I pay in parts?" escalates as
`price_negotiation`, exactly as today.

This narrows `001 § Escalation`, whose `price_negotiation` trigger lists
instalments and payment plans outright. In the pull request that implements
this spec, alongside `§ Role`, that trigger becomes: discounts, "is that the
best?", and instalments or payment plans that no `paymentOptions` entry
covers.

## The sale ends at the payment-link flow

Exactly one `flows[]` entry may carry `"role": "payment_link"`; a second is a
load failure. When that flow is performed, the server writes the funnel field
to `link_sent` as a follow-on action. It is recorded in `turns.actions` like
any other, is not staged by the model, and does not count against the
per-turn cap. If the flow fails, the stage is not written.

After `link_sent` the agent's job is answering questions about the course and
the link. A contact who says they have paid, or sends a receipt, is escalated
with a new reason, `payment_reported`, added to `001`'s closed set: the agent
cannot see the payment and must not confirm it.

## The selling voice is the tenant's; the funnel rules are the system's

The rules above (stage meanings, forward-only stages, one question per turn,
the never-list, the escalation rows) are system instructions in source,
English and system-facing, the same for every tenant. They are not customer
copy under C9.

How the agent sounds while doing it, which proof points it leans on and what
it says to an objection are the tenant's, in `config/prompt.md` and in each
flow's `description`. Examples in this repository use the fictional demo
tenant only (C1): no real course names, prices, flow names or flow ids.

## Success is measured twice

| Measure        | Definition                                                                                         | Source                        |
| -------------- | -------------------------------------------------------------------------------------------------- | ----------------------------- |
| Link-sent rate | Contacts whose payment-link flow was `performed`, over contacts with a first turn in the same week | `turns.actions`, this service |
| Paid enrolment | Contacts the tenant tagged `enrolled`, over the same denominator                                   | The tenant's ManyChat account |

Link-sent rate is the leading indicator: this service can compute it, daily.
Paid enrolment is the outcome, and this service cannot see it. They are
reported separately and never combined. A rising link-sent rate with a flat
enrolment rate means the agent is asking too early (ADR-0015's revisit
trigger).

**Baseline: not yet measured.** Before rollout, both rates are measured from
production over the four weeks preceding it, and the figures and the dates
they cover are written here. Without them, no claim that this spec improved
anything can be made.

## Verification

1. A unit test asserts a `set_field` on the funnel field to an earlier stage
   than the last `performed` one returns `{ staged: false }`, and that
   `link_sent` is absent from the model's enum.
2. A config test asserts two `funnel` fields, or two `payment_link` flows, fail
   at load.
3. A unit test asserts a flow recorded as `performed` for the contact is absent
   from the next turn's `send_flow` enum, and a `repeatable` one is present.
4. An integration test asserts that performing the payment-link flow writes
   `link_sent` after it, records both, and writes nothing when the flow fails.
5. Golden eval cases, written for the demo tenant, cover: a qualifying first
   turn; a direct question answered before qualifying; a request for the link
   before qualifying; each objection row in the table; a discount request with
   and without a matching `paymentOptions` entry; a reported payment; and a
   case for each item on the never-list, asserting it does not appear.
6. `001 § Verification` item 3 (no price absent from the catalog) now also
   covers `paymentOptions`.

What this misses: whether a tenant flow chains into another is invisible here,
and only a person opening the flows can check it. The never-list cases catch
the phrasings the golden set thought of; a real model will find others, and
reading real conversations after rollout is the actual check. And link-sent
rate can rise because the agent got better or because it got pushier. Only
paid enrolment tells them apart, which is why both are measured.
