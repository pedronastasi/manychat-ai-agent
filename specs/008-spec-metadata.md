---
status: implemented
implemented: 2026-09-15
pr: 9
constitution: [C8]
---

# 008 — Spec Metadata

Defines the frontmatter every file in `specs/` carries, so a reader can tell
whether the behaviour a spec describes actually exists in the code. It fixes the
status vocabulary and the evidence each value requires. It does not track effort,
ownership, estimates, or delivery dates.

## The problem is a spec that reads as finished when nothing was built

`007-local-model.md` describes registry wiring, a compose service, and three
settings that must change with it. None of it exists yet. Nothing on the page
says so, and it is written in the same voice as `002-channel-contract.md`, which
describes code that has been serving since the first commit.

A reader cannot tell those two apart. The cost is not confusion, it is misplaced
trust: someone who believes `007` is live will debug the wrong layer for an hour
before thinking to check `src/`.

## A hand-maintained status field is not the fix

The reflexive answer is a `status: implemented` line, edited by whoever
remembers. That is worse than no metadata at all.

An absent field makes a reader check the code. A stale field makes them skip the
check, which is precisely the behaviour the metadata was introduced to prevent.
And status fields rot quietly: an implementation gets reverted, a spec gains a
section nobody built, a PR lands half of what was described — and the field still
says `implemented`, because correcting it was never anybody's job.

So the rule is stronger than "record the status". It is:

> **A status must be a claim the repository can falsify.** `implemented` is
> permitted only where a test cites the spec, and a test asserts that link on
> every push. A status nothing can check is decoration.

Constitution C8 already requires behavioural tests to cite the spec clause they
enforce. That citation is the evidence. This spec only makes it load-bearing.

## Four statuses are enough, and "partial" is deliberately absent

| Status        | The claim it makes                                      | Evidence required                        |
| ------------- | ------------------------------------------------------- | ---------------------------------------- |
| `standing`    | Principles in force repo-wide, not a unit of work       | None. Reserved for `000-constitution.md` |
| `specified`   | Written down, not built. Assume `src/` does not do this | None                                     |
| `implemented` | The described behaviour exists in the code              | At least one file under `test/` cites it |
| `superseded`  | No longer in force                                      | `superseded_by` names a spec that exists |

There is deliberately no `partial`. Every spec is partial at some zoom level, so
the value would attach to everything and distinguish nothing — and it offers an
author an easy way to avoid deciding. A spec whose implementation genuinely
stopped half way is two specs: the part that shipped, and the part that did not.

## Every field is specified; unrecognised keys are failures

```yaml
---
status: implemented # required; one of the four above
implemented: 2026-09-14 # required if and only if status is `implemented`
pr: 1 # optional; the pull request that landed it
superseded_by: 012 # required if and only if status is `superseded`
constitution: [C4, C6] # optional; clauses this spec is the detailed form of
adr: [0007] # optional; decisions that produced this shape
---
```

`implemented` is the date the behaviour reached `main`, which is the merge date
of the pull request in `pr` — not the date the spec was written. Where a spec
landed across several pull requests, `pr` names the one that completed it.

`constitution` and `adr` earn their place by being checkable: every clause must
have a heading in `000-constitution.md` and every ADR must exist and not be
superseded. Both also repair a link that only runs one way today. The
Constitution points down to specs, and two specs happen to mention an ADR in
prose — so "which spec enforces C6?" and "which decision produced this shape?"
are currently grep questions with no reliable answer.

Frontmatter goes above the `#` title, and no other keys are permitted. An
unrecognised key is a failure, not an extension point: the moment this file
becomes a place to stash arbitrary notes, the guarantees above stop meaning
anything.

## What is derived, and therefore never written down

Which tests enforce a spec is **computed** from the citations C8 already
requires, on every run of `pnpm spec:index`. It is not a field.

The distinction is the same one that rules out a hand-maintained status: a list
of enforcing tests typed into frontmatter is wrong the first time a test is
renamed, and wrong silently. The same reasoning excludes a `revised:` date,
which `git log` already knows more accurately than an author will remember.

The rule generalises: **if git or the test suite can answer it, it is not
frontmatter.**

## Fields this spec deliberately refuses

| Field                   | Why not                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| `owner`                 | Unfalsifiable, and stale the first time someone changes team. Use `git log` and the PR               |
| `effort`, `target_date` | Estimates, not properties of the repository. They belong in an issue tracker                         |
| `reviewed: <date>`      | The most tempting and the worst: it decays into a rubber stamp, and reads as assurance while it rots |
| `stability`             | Subjective, and `specified` versus `implemented` already carries the part of it that is checkable    |

The pattern in every rejection is the same: a field nobody can be proved wrong
about will drift until it is actively misleading, and the reader has no way to
tell the moment that happens.

## `specs/README.md` is generated, never edited

The table of every spec and its status is produced by `pnpm spec:index` from the
frontmatter. It is committed so it is readable on the repository's front page,
and a test asserts the committed copy matches what the generator produces, so a
hand-edit or a forgotten regeneration fails CI rather than drifting.

## Verification

- A test asserts, for every file in `specs/`: frontmatter is present, `status`
  is one of the four values, `implemented` is present exactly when the status is
  `implemented` and absent otherwise, `superseded_by` resolves to a spec that
  exists, and no unrecognised key appears.
- The same test asserts every `implemented` spec is cited by at least one file
  under `test/`, which is the evidence C8 already requires.
- The same test asserts every clause in `constitution` has a heading in
  `000-constitution.md`, and every entry in `adr` names a file in `docs/adr/`
  that is not superseded.
- The same test asserts `specs/README.md` equals the generator's output.

**What this does not prove.** A citing test shows that _something_ in the spec is
enforced. It cannot show that _all_ of it is. A spec could gain three unbuilt
sections and stay `implemented` on the strength of one test covering the first
paragraph, and nothing here would object.

That limit is accepted deliberately. The failure this spec exists to stop is a
wholly unimplemented document read as finished — `007`, not a spec that drifted
by a paragraph. Closing the remaining gap needs per-clause citation, which is a
larger change to C8 and should be argued on its own merits rather than smuggled
in here. Review remains the real enforcement.
