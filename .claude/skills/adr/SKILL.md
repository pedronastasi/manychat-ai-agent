---
name: adr
description: Write an architecture decision record in docs/adr/ using this repository's exact format, starting with an interview that pressure-tests the decision before recording it. Use when a non-obvious technical choice is being made or has just been made, when the user says "record this decision", asks for an ADR, supersedes an existing one, or changes a Constitution clause in specs/000-constitution.md.
---

# Writing an ADR

## First decide whether it is an ADR at all

| What is being written down                     | Where it belongs                |
| ---------------------------------------------- | ------------------------------- |
| Behaviour a test can assert                    | `specs/`                        |
| A non-negotiable rule for the whole repo       | `specs/000-constitution.md`     |
| Why this shape was chosen over the obvious one | `docs/adr/` — here              |
| How to run something                           | `CONTRIBUTING.md` / `README.md` |

An ADR earns its place when the rationale **cannot be recovered from the code**,
usually because the code is the _absence_ of something. `0004` exists because
nobody reading the repo can see the Redis that is not there.

Do not write one for a decision with no rejected alternative. "We used
TypeScript" is not an ADR; it is a fact about the repo.

## Step 0 — Interview before writing anything

**Write no ADR until the developer has answered.** The `/spec` interview gathers
decisions that were already made. This one is not that. An ADR written straight
from a brief records a decision taken blind, inside a document whose entire
purpose is to show that it was not — and it is convincing, because the format
supplies the confident voice for free.

These questions exist to **make** the decision, not to transcribe it. Expect
some of them to change the answer. That is the point; a question that could not
have changed anything was not worth asking.

### First, read

`ls docs/adr/` for the next number and the house voice,
`specs/000-constitution.md` if a clause is in play, and any existing ADR on the
same subject — which may mean this supersedes rather than adds.

### Then ask

At most two rounds of `AskUserQuestion`, load-bearing questions first.

1. **What forced this?** The constraint, limit, deadline or failure that made
   doing nothing impossible. A decision nothing forced is usually a preference,
   and preferences do not need ADRs.
2. **What is the reflexive alternative, and what is the strongest case _for_
   it?** Ask them to argue the side they are rejecting. If they cannot, the ADR
   will contain a strawman, and an option nobody can defend was never really
   considered. This is the question that most often changes the answer.
3. **Which of your reasons are measured, and which are assumed?** Take them one
   at a time. "Postgres is fast enough here" is either a measurement or a hope,
   and the finished ADR reads identically in both cases.
4. **If the main assumption turned out to be wrong, would the decision flip?**
   If yes, stop and go measure. Recording a coin flip in the voice of a decision
   is the precise failure this interview exists to prevent.
5. **What does this cost?** An answer that contains no cost is a pitch, not a
   decision, and Consequences will expose it.
6. **What would make this the wrong call later?** The revisit trigger. A
   decision with no condition that could reverse it is a belief.
7. **Is this one decision, and does it supersede anything?** If stating it takes
   more than a sentence it is two decisions. If an ADR already covers the
   ground, supersede it rather than filing a second opinion.

### When the code already exists

Recording a decision after building it is legitimate, but the questions above
stop working: everything reads as inevitable once it is running. Ask instead
what would have had to be true for the **other** option to win, and whether that
was ever checked. If the honest answer is "we never looked", the ADR says the
decision was made by default. That is a real finding and belongs in Context.

### Stop rather than write

| If                                              | Then                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------- |
| No rejected alternative can be named            | Not an ADR. It is a fact about the repo — say so and stop         |
| The decision flips on an unmeasured assumption  | Stop. Measure first, then come back                               |
| No cost can be named                            | Not ready. Return to question 2 and argue the other side properly |
| Stating the decision takes more than a sentence | Two decisions. One ADR each                                       |

### Then confirm

Play back the decision in one sentence, the alternative being rejected, the
cost, and the revisit trigger. Get an explicit go-ahead, then write without
stopping again.

## Steps — after the decision is confirmed

1. **Number it.** `ls docs/adr/` — take the highest and add one, zero-padded to
   four digits.
2. **Name the file** `docs/adr/NNNN-kebab-case-title.md`. The slug is the
   decision, not the topic: `0004-postgres-outbox-over-redis.md`, not
   `0004-queueing.md`.
3. **Get the date** with `date +%F`. Never guess it and never copy the date from
   a neighbouring ADR.
4. **Write it** in the format below.
5. **Add a row to the ADR table in `README.md`** (around line 68). The table is
   the index; an unlisted ADR is an unread one.
6. **Format it**: `npx prettier --write docs/adr/NNNN-*.md README.md`.

## Format — copy this exactly

```md
# ADR-0008 — Title as a decision, in sentence case

**Status:** accepted · **Date:** 2026-09-15

## Context

## Decision

## Consequences
```

An em dash in the title line, a `·` between Status and Date. Exactly three
sections, in that order, every time.

There is deliberately **no "Alternatives considered" heading**. The rejected
alternative belongs in Context, where it reads as part of the problem rather than
as a section someone has to fill in.

## What each section must contain

**Context** — the forcing constraint, and the choice a reader would expect you to
have made. Name the reflexive option outright, as `0004` does: _"The reflexive
choice is Redis with BullMQ."_ One or two short paragraphs. No solution here.

**Decision** — present tense, no hedging, often a single sentence. If it needs a
paragraph to state, the decision is still two decisions.

**Consequences** — the bill, not the pitch. An ADR listing only benefits was
written to justify a decision rather than record one. Cover three things:

- what this buys,
- **what it costs** — `0004` names the polling latency it accepts,
- **the revisit trigger**: the condition under which this becomes the wrong call.
  _"If throughput ever reaches thousands of messages per minute, revisit."_

## House rules

- **English** (Constitution C9), wrapped at 80 columns. Prettier preserves prose
  line breaks here, so wrap by hand.
- **No tenant data** (C1): no real prices, names, transcripts or account details,
  including as illustrative examples.
- **Status** is `accepted`, or `superseded by ADR-NNNN`.
- **Superseding**: never edit the old ADR's body — its reasoning is the record of
  what was believed then. Change only its Status line, and write a new ADR whose
  Context explains what changed.
- A change to `specs/000-constitution.md` **requires** an ADR that supersedes the
  clause. That rule is in `CONTRIBUTING.md`.

## Worked example

Read [`docs/adr/0004-postgres-outbox-over-redis.md`](../../../docs/adr/0004-postgres-outbox-over-redis.md)
before writing. It is the shortest complete one: reflexive alternative named in
Context, one-line Decision, and Consequences that admit a cost and state the
revisit trigger.
