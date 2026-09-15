---
name: spec
description: Write a specification in specs/ using this repository's conventions, starting with an interview so the developer makes the decisions the spec records. Use when the user asks for a spec, says "let's specify" or "spec this out", wants behaviour defined before it is implemented, or is about to implement something non-trivial that no spec covers yet.
---

# Writing a spec

## Spec, ADR, or neither

| What is being written down                     | Where it belongs            |
| ---------------------------------------------- | --------------------------- |
| Behaviour a test can cite and assert           | `specs/` — here             |
| Why this shape was chosen over the obvious one | `docs/adr/` — use `/adr`    |
| A non-negotiable rule for the whole repo       | `specs/000-constitution.md` |
| How to run or contribute                       | `CONTRIBUTING.md`           |

An ADR records a decision **once** and is then frozen. A spec is the standing
description of how something behaves, and gets edited as the behaviour changes.
If you are tempted to write "we decided", it is an ADR.

## Know which of the two kinds you are writing

**Contract specs** (`002`, `003`) are reference material: wire shapes, exact
values, tables, budgets. They are read _while_ writing code, so they are dense
and skimmable.

**Position specs** (`004`, `005`, `006`) argue a rule that a competent engineer
would otherwise get wrong by default. They are read once and then cited.

A position spec whose default nobody would have chosen anyway is a summary. If
you cannot name the reflexive approach you are rejecting, you are writing a
contract spec — or nothing.

## Step 0 — Interview before writing anything

**Write no spec file until the developer has answered.** A spec records
decisions that are theirs to make; guessing at them produces a document that
reads like a spec and commits the repository to choices nobody chose.

### First, read — so the questions are informed

Ask nothing until you have read `specs/000-constitution.md`, run `ls specs/`,
and skimmed any existing spec that overlaps. Questions you could have answered
yourself waste the developer's turn, and the most useful question — "this
contradicts `004`, which wins?" — is one you can only ask after reading.

If that reading shows the work is already specified, say so and stop. Editing
an existing spec beats adding a near-duplicate.

### Then ask

Put these to the developer with `AskUserQuestion`, batched into one round.
Skip any the prompt already answers unambiguously — and say which you skipped
and what you assumed, so a wrong assumption gets corrected rather than
silently baked in.

1. **What behaviour are we specifying?** If the brief is vague ("spec out
   caching"), propose a concrete scope and have them confirm it. Do not
   proceed on the vague version.
2. **Contract or position?** Offer both with the distinction restated:
   _contract_ is reference material read while coding; _position_ argues a
   rule someone would get wrong by default. If they are unsure, ask what the
   obvious approach is that this rejects — an answer means position, no
   answer means contract.
3. **What does this deliberately leave out?** This is the second half of the
   opening paragraph, and asking now is what stops the draft sprawling.
4. **Position specs only: what default are we rejecting, and why is it
   wrong?** This is the thesis. If they cannot name it, the spec is not ready
   — tell them so rather than writing something that fills the shape.
5. **Which numbers are load-bearing, and where did they come from?**
   Timeouts, limits, thresholds, costs. Every one needs a source, and a
   measurement date if measured.
6. **Which Constitution clauses does this touch?** Name the candidates from
   your reading (C1–C9) and have them confirm — do not ask them to recall
   clause numbers.

### Then confirm the outline

Play the answers back as a short outline — title, kind, opening paragraph,
and the headings as claims — and get an explicit go-ahead. Once they approve,
write the whole spec without stopping again.

If a spec turns out to need a decision nobody has made yet, that decision is
an ADR, not a paragraph you improvise here. Use `/adr` first.

## Steps — after the outline is approved

1. **Number it.** `ls specs/` — next integer, **three digits**. (ADRs are four.
   Do not mix them.)
2. **Name the file** `specs/NNN-kebab-case.md`.
3. **Open** with the title line and two or three lines saying what this defines
   and what it deliberately leaves out. No `## Overview` heading — the paragraph
   under the title is the overview.
4. **Write it**, following the house style below.
5. **End with `## Verification`** for a position spec. A contract spec that is
   pure reference may omit it.
6. **Link it**: from `CONTRIBUTING.md` if a contributor needs it day to day, and
   from the Constitution clause it backs, if it backs one.
7. **Format**: `npx prettier --write specs/NNN-*.md`. Prose line breaks are
   preserved, so wrap at 80 columns by hand.
8. **Commit the spec on its own**, before the implementation. The convention here
   is specs on `main`, implementation in the PR that follows.

## Format

```md
# 007 — Title in Title Case

Defines <what this fixes>, and <what it deliberately does not cover>.

## A heading that states a claim
```

## House style — the parts that are not obvious

- **Headings are claims, not labels.** `## This is not a translation task`,
  `## Position on "test every file"`, `## The exception, scoped precisely`. A
  reader who scans only the headings should come away with the argument. Never
  `## Overview`, `## Details`, `## Notes`.
- **Name the default you are rejecting, then say why it is wrong.** `005` does it
  in one move: translating the hardcoded copy would produce _the same bug in a
  different language_.
- **Clauses have to be citable.** Constitution C8 requires tests to cite the
  clause they enforce — `specs/004-testing.md § Deliberately not unit tested`.
  Headings must therefore be specific and stable enough to name from a comment.
- **Any measured number carries the date it was measured** — `004` writes
  "measured 2026-09-15". An undated number rots without anyone noticing.
- **Verification says what would actually catch a violation, and admits what it
  misses.** `005` states outright that its accent check "catches accented prose
  and misses unaccented prose … Review is the real enforcement." Do not overclaim
  a heuristic.
- **English** (C9). **No tenant data** (C1) — no real prices, names or
  transcripts, including in examples. Use the fictional demo tenant.

## Changing a spec later

A spec change that breaks a test is a **real finding**, not a test to update
mechanically (C8). Change the spec in the same PR as the behaviour it describes.

A change to `specs/000-constitution.md` requires an ADR that supersedes the
clause — use `/adr`.

## Worked examples

Read [`specs/005-language.md`](../../../specs/005-language.md) for a position
spec: it opens by rejecting the obvious reading of its own task, and its
Verification names the limits of its own check.

Read [`specs/003-config-schema.md`](../../../specs/003-config-schema.md) for a
contract spec: tables, exact field names, no argument.
