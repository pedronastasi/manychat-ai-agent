---
status: specified
---

# 040 — The README Is a Landing Page

Defines what `README.md` holds below its first screen, and where everything
else it used to hold goes instead. It deliberately leaves out the first screen
itself (`021-contributor-surface.md`), the length of `config/README.md`, and
the site's navigation, which `014-docs-site.md` derives.

## Every feature appends to the README, and the README stops being read

The README is the one page every visitor opens, so it is where the author of a
new feature reaches first when the feature needs explaining. Contact tokens,
inbound media, agent tools, contact reads and notes, follow-ups and the sales
funnel each arrived with a README section of its own, and the Docker
walkthrough grew a curl example per step. Each addition was reasonable on its
own.

Together they made a 650-line page (measured 2026-10-07). The first screen and
the problem the project solves were its first 76 lines. The rest was a local
setup walkthrough, ManyChat configuration, and the reference for every optional
feature, in the order the features were merged. A visitor deciding whether the
project fits had to scroll past the curl output to learn it can sell. A tenant
setting up follow-ups had to know the README was where that lived, rather than
the guides beside `getting-started.md`.

The default is wrong for a specific reason: the README has two readers who want
opposite things. The visitor wants to know in a minute what this is and whether
it fits. The operator wants every step for the one thing they are configuring,
and nothing else. A page that serves the second reader fails the first, and
appending is how it comes to serve the second.

So the rule is:

> **The README says what the project is and where to read more. Anything with
> steps to follow or settings to look up lives in exactly one other page, and
> the README links to it.**

## The README holds the problem, one line per capability, and a map

Below the first screen, the README has these sections and no others:

| Section                 | What it holds                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------- |
| The problem this solves | The 10-second limit, the race diagram and why the losing call is not cancelled      |
| What it can do          | One bullet per capability, each naming the spec that defines it                     |
| Documentation           | A table from what a reader wants to do to the one page that tells them              |
| Development             | The commands a contributor runs, without explanation; the explanation is in a guide |
| Status, License         | As before                                                                           |

A capability bullet says what the agent does, not how to turn it on. When a new
capability needs explaining, it gets a bullet here and its explanation goes
elsewhere.

## Steps and reference live in exactly one guide, spec or config/README.md

| Content                                                     | Its one home                  |
| ----------------------------------------------------------- | ----------------------------- |
| What the agent must do, as a rule a test cites              | A spec under `specs/`         |
| Why a shape was chosen                                      | An ADR under `docs/adr/`      |
| Every key a tenant's configuration file accepts             | `config/README.md`            |
| Steps a person follows: run, deploy, connect, turn on, move | A guide under `docs/guides/`  |
| The design as a whole, and the list of decisions            | `docs/guides/how-it-works.md` |

A guide explains and links; it does not restate a spec's rules or the
configuration reference. Where a guide and a spec disagree, the spec wins, as
`docs/guides/getting-started.md` already says of itself.

## Nothing is said twice: the race lives in the README, and guides link to it

`014-docs-site.md` rejects a copy of a page because the copy is the one that
stops being edited. The same holds for a section copied between two pages that
are both published. The race is the reason this project exists, so it stays in
the README, where a visitor meets it, and `how-it-works.md` links to it rather
than repeating it.

This is not the move 014 forbids. 014 forbids rewriting a file so the site can
publish it. Moving prose from one published file to another changes where it is
read, on GitHub and on the site alike, and leaves one copy.

## A new guide goes in docs/guides/ and gets a row in the map

`docs/guides/` is on the site's allowlist as a directory, so a guide added
there is published and in the sidebar without touching `.vitepress/` (014). It
is not in the README's Documentation table until someone adds a row, because
that table is ordered by what a reader is trying to do, which no derivation
knows. A guide nobody would look for from the README does not need a row.

## Verification

- A test asserts `README.md` is at most 200 lines. It was 135 when this spec
  was written (2026-10-07), which leaves room for a few capability bullets and
  map rows, and none for a walkthrough.
- `pnpm docs:build` fails on a relative link to a file that does not exist
  (014), so a map row left pointing at a renamed or deleted guide fails CI.
- `test/unit/contributor-surface.test.ts` already pins the first screen (021);
  moving content below it does not change what that test checks.

**What this does not catch.** A line cap measures length, not purpose. A
200-line README that is half walkthrough passes, and so does a guide that
restates a spec. Text duplicated between two pages is not detected at all.
Review is the enforcement for all three.
