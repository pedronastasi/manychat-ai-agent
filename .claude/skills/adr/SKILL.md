---
name: adr
description: Write an architecture decision record in docs/adr/ using this repository's exact format. Use when a non-obvious technical choice has just been made, when the user says "record this decision", asks for an ADR, supersedes an existing one, or changes a Constitution clause in specs/000-constitution.md.
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

## Steps

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
