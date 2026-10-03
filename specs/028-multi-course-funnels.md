---
status: specified
constitution: [C1, C3, C6]
adr: [0015]
---

# 028 — Multi-Course Funnels

Defines how one deployment sells several catalog courses through one funnel:
a course field set by the entry flow or the agent, content flows tied to a
course, and the rule for when the course may change. It amends `023` in two
places and `002` in one, listed at the end, and leaves out a separate funnel
stage per course, bundles and cross-selling (one course per contact at a time),
and a separate payment flow per course.

## One deployment per course splits the contact in two

`023` assumes one sale per deployment: one `funnel` field, one set of content
flows, one payment-link flow. A tenant running ads for two courses has two
reflexive ways to fit that.

**A deployment per course.** Each has its own `tools.json` and its own
database. But a contact is one WhatsApp number in one ManyChat account: the
same person who came from the first course's ad and asks about the second has
two histories, two funnel stages and two turn caps, and the deployment they
reach depends on which ad they clicked last. Neither copy of the agent knows
what the other said.

**One flat flow list.** Every course's syllabus and results go into one
`flows[]`, with descriptions that name the course. The model then chooses
between near-identical entries ("syllabus, course A" and "syllabus, course
B") on wording alone, and a wrong pick sends the other course's content with
no check to stop it. `023`'s sent-once rule makes it worse: the right flow is
still available, but the agent believes the syllabus was sent.

So **the course is a recorded fact about the contact, and the server, not the
model, decides which flows that fact makes available.**

## The course is an enum of catalog ids, set by the entry flow or by the agent

`fields[]` gains an optional marker, `"course": true`, on at most one field.
Its `values` must be exactly the `catalog.json` course ids, in any order, or
the file fails at load, so the field cannot name a course the agent cannot
quote a price for (C6).

```jsonc
{
  "fields": [
    {
      "id": "course",
      "field": "course",
      "course": true,
      "values": ["foundation", "advanced", "weekend-intensive"],
      "description": "The course this contact is buying. Set it as soon as the contact chooses one.",
    },
  ],
}
```

The course is set from either side:

- **The entry flow.** A campaign's entry flow in the tenant's ManyChat account
  sets the field before the contact reaches the agent, so a lead from a course's
  ad starts on that course.
- **The agent.** With `set_field`, like any `012` field, once the contact
  chooses or the fit is clear. Qualifying for a course is `023 § Qualify before
sending content`; this field is where its answer goes.

### The server learns the course from the inbound request

Filtering flows needs the course before the model runs, and `get_contact` runs
inside the loop, when the tools are already built (ADR-0016). So the Dynamic
Block request gains an optional `"course": "{{course}}"`, rendered by ManyChat
from the contact's field. It is validated against the course enum (C3). An
empty, unrendered (`{{course}}`) or unknown value is treated as absent, never
as a course.

The conversation row keeps the current course, updated from each inbound
value and from each `performed` write to the course field. Inbound wins when
both exist: it is ManyChat's value at request time, which already includes
every write this service performed. A nudge turn (`025`), which has no inbound
request, uses the stored value.

## A flow belongs to one course or to all

`flows[]` entries gain an optional `course`, a catalog course id. An entry
without one serves every course (an intro audio, testimonials that are not
course-specific, the payment-link flow).

`send_flow` accepts a flow only if it has no `course` or its `course` is the
turn's course: the one staged on the course field earlier in the same turn, or
else the contact's current course. Anything else returns `{ staged: false }`.
A turn with no known course accepts only flows without one, so the agent's
first job with an unplaced lead is to place them.

The tool's description lists every flow it can accept on the turn, with its
course, and omits the others. A flow becomes available in the same turn the
agent sets its course; the tool result of that `set_field` lists the flows it
made available.

## The course may change until the offer, and is locked after it

A contact who asked about one course and turns out to fit another is normal,
and the agent may move them: a `set_field` on the course field is accepted
while the funnel stage is before `offered`.

From `offered` onward the course is locked. A write to it returns
`{ staged: false }`, and the system instructions tell the model to escalate
as `explicit_request` when the contact asks to switch. At that point a course
and its catalog price have been put to the contact, and from `link_sent` a
payment link for it has been sent. A model that silently switches course
after that leaves the contact holding one course's price and another's
payment link; a person deciding the switch costs one handoff.

The entry flow is not bound by the lock: it writes ManyChat directly, and a
contact who clicks a second course's ad mid-sale arrives with the new course
on the inbound request. The server takes it and records the change in the
conversation row; the stage is not reset (`023`'s stage only moves forward).
The system instructions tell the model, when the inbound course differs from
the one it last saw, to confirm which course the contact wants before
continuing.

## Sent once means once per contact, whatever the course

`023 § Every content flow is a leaf, sent once` removes a performed flow from
the contact's `send_flow` enum. A course change does not restore it: a flow
the contact received is still in their chat. Course-specific flows of the new
course were never sent, so they are available; shared flows already sent stay
sent.

## One payment flow serves every course; the course is in the field

`023` allows exactly one `payment_link` flow, and that stays. It carries no
`course`. The tenant's flow reads the course field and branches inside
ManyChat to the right payment link. That branching is the tenant's, and nothing
here can see it.

Because the course is locked from `offered`, the field the payment flow reads
is the one the agent offered. A deployment that wants a payment flow per course
instead is out of scope here: it would make `role: "payment_link"` per course,
which `023` refuses.

## What this changes elsewhere

- `023 § Every content flow is a leaf, sent once`: availability of a flow also
  depends on its `course`, as above.
- `023 § The funnel is a field the agent moves`: a second marked field,
  `course`, may exist
  beside `funnel`. They may not be the same field.
- `002 § Inbound payload`: the strict inbound schema gains the optional
  `course` key.
- `003` documents `fields[].course` and `flows[].course`.

These are edited in the pull request that implements this spec.

## Verification

1. Config tests assert two `course` fields, a `course` field whose values
   differ from the catalog's course ids, a `flows[].course` that is not a
   catalog id, and one field marked both `funnel` and `course`, each fail at
   load.
2. A unit test asserts `send_flow` refuses another course's flow, accepts a
   flow without a `course` on a turn with no known course, and accepts the new
   course's flow after `set_field` on the course field earlier in the turn.
3. A unit test asserts a write to the course field returns `{ staged: false }`
   once the stage is `offered` or later, and is accepted before it.
4. A contract test asserts the inbound `course` is accepted when it is a
   catalog id and treated as absent when empty, unrendered or unknown.
5. An integration test against PGlite asserts the conversation's course is
   updated from inbound values and from `performed` writes, that inbound wins,
   and that a nudge turn uses the stored value.
6. A unit test asserts a shared flow sent before a course change is not
   offered after it, and the new course's flows are.
7. Golden eval cases, demo tenant: a lead with no course asks for the
   syllabus and is asked which course first; a lead on one course asks about
   another before the offer and the course is switched; the same after the
   offer escalates as `explicit_request`.

What this misses: the payment flow's branching on the course field is inside
ManyChat, and a branch that sends the wrong link passes every check here. The
entry flow's field write is the tenant's too; an ad whose entry flow sets no
course, or the wrong one, is invisible until a person reads the conversation.
And whether the agent places an undecided lead on the right course is a
judgement no assertion makes; evals sample it.
