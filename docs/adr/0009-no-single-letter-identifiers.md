# ADR-0009 — No single-letter identifiers

**Status:** accepted · **Date:** 2026-09-15

## Context

This repository is written to be read by people who did not write it. The specs,
the ADRs and the comment style all assume a reader arriving cold, and the
tests are meant to document behaviour rather than merely assert it.

Identifier names were the one place that assumption was not being honoured.
`for (const c of catalog.courses)` and `guards.find(g => !g.allowed)` require the
reader to hold a binding in their head that the code could simply have stated.

The reflexive choice is to leave this to reviewer judgment. That option has a
real case: `i` as a loop index, `a` and `b` as comparator parameters, and
`resolve` shortened to `r` are understood everywhere, cost a fluent reader
nothing, and a rule that forbids them buys no clarity at those sites. A
convention enforced only when someone notices it in review is also cheaper than
one enforced on 132 existing sites.

The counter-argument is that a convention applied by judgment is not a
convention. "Short names are fine when obvious" makes every occurrence a
judgment call, and the judgment is made by the author — the one person who
cannot evaluate it, because they already know what the letter stands for.

## Decision

Every identifier is at least two characters, enforced by ESLint's `id-length`
with no exceptions.

## Consequences

- A reader never has to resolve a letter to a meaning. The name is the
  documentation, at the point of use, in every file.
- The rule is mechanical, so it is settled by CI rather than argued in review,
  and it cannot decay as reviewers change.
- No exception list means no boundary to litigate. An exception list is where
  this kind of rule usually dies: each entry is defensible, and the set grows
  until the rule means nothing.
- It costs 132 renames across `src`, `test`, `evals` and `scripts`, landing as
  one large mechanical diff that touches files no feature change would have.
- Some sites read no better afterwards. A loop index named `index` is not
  clearer than `i`, and a comparator taking `left` and `right` is not clearer
  than one taking `a` and `b`. This is the price of having no boundary to
  argue about, and it is paid at a minority of sites.
- Library-shaped callbacks must now be named by us rather than copied from the
  library's own documentation — Drizzle's `(t, { desc })` becomes
  `(table, { desc })`, which diverges from the upstream examples a reader may
  be comparing against.
- If the rule starts producing names chosen to satisfy the linter rather than
  the reader — `idx`, `tmp`, `val` — it has failed at its purpose and should be
  revisited, most likely by narrowing it to semantic identifiers and exempting
  conventional indices.
