---
status: implemented
implemented: 2026-09-15
pr: 6
constitution: [C1, C5, C8, C9]
---

# 006 — Pull Requests

Defines what a pull request in this repository must say, and fixes it in a
template so it does not depend on who opens it.

## Why this spec exists

The diff already says **what** changed. Nothing in the repository says **why**,
and that is the part that stops being obvious within a month.

This repo is written to be read by strangers (Constitution C9's companion
premise: it is going to be public). The trail a stranger follows is
`git blame` → commit → pull request. If the pull request restates the diff, that
trail ends in a description of code they were already looking at. The reasoning —
which alternative was rejected, which constraint forced this shape, what was
measured — exists nowhere else, because it is the one thing code cannot express.

There is a second, sharper reason, specific to this project.

> `.gitignore` protects the repository. It does not protect a pull request body.

Constitution C1 is enforced by git for files. Nothing enforces it for the text a
human types into GitHub. The most plausible route for a deploying tenant's data
to reach the public internet is not a committed file — that is blocked — it is
somebody pasting a real WhatsApp transcript, a screenshot of a conversation, or
the real price list into a PR to illustrate a bug. The template has to put that
in front of the author at the moment they are writing, which is the only moment
it can be prevented.

## The rule: why first

The first heading of every pull request is `## Why`. Not "Summary", not
"Changes", not "Description".

A description that opens with a bulleted list of changes is a worse-formatted
version of the diff, and it trains the reviewer to skim. A description that opens
with the problem gives the reviewer the one thing they need in order to judge
whether the diff is a good answer: what question it is answering.

The test for a sufficient `Why`:

> Somebody who thinks this change is wrong should be able to point at the
> sentence they disagree with.

If no such sentence exists, the section is a summary wearing the heading.

## Sections

| Section           | Required               | Contains                                                                        |
| ----------------- | ---------------------- | ------------------------------------------------------------------------------- |
| `## Why`          | Always, and first      | The problem, the constraint, or the decision. Alternatives rejected, if any.    |
| `## What changed` | Always                 | Short. The diff has the detail; this orients the reader inside it.              |
| `## Verification` | Always                 | What was actually run and what it returned. Numbers, not adjectives.            |
| `## Risk`         | When behaviour changes | What could break, and what happens if it does. "Nothing" is an answer if true.  |
| `## Follow-ups`   | Optional               | Deliberately deferred work, so it reads as a decision rather than an oversight. |

Sections that do not apply are deleted. `Risk: n/a` is noise.

`Verification` is where Constitution C8 lands: a behavioural change cites the
spec clause it satisfies, so a reviewer can check the change against the spec
rather than against their expectations.

## What the template deliberately does not contain

**No checklist of things CI already enforces.** CI runs typecheck, lint, format,
the full test suite with a coverage gate, the eval suite, secret scanning and
CodeQL. Asking an author to tick "I ran the tests" next to a job that ran the
tests teaches people to tick boxes without reading them, and the cost is paid on
the one line that actually needed a human.

A checkbox earns its place only where a machine cannot do the job. Two qualify:

- **No tenant data** — no real transcripts, prices, names, phone numbers or
  screenshots (C1, C5). A scanner catches credentials; it does not catch a
  customer's message pasted as an example.
- **Specs updated** — if behaviour changed, the spec that describes it changed in
  the same PR, or the PR says why it did not (C8).

Both are judgement calls a human makes and a job cannot.

## Title

The title matches the commit subject: a conventional-commit prefix and an
imperative sentence, in English (C9).

```
feat: implement the agent gateway MVP
test: specify and implement the testing strategy
refactor: English throughout, and no customer copy in source
```

## Worked examples

PRs #1, #2 and #3 in this repository are the reference standard. Each opens with
the problem — a 10-second platform timeout, an outbox worker at 0% coverage,
copy hardcoded in source — and only then shows what was done about it.

## Verification

- `.github/pull_request_template.md` exists; GitHub pre-fills it on every new PR,
  including from the `gh` CLI.
- A test asserts the template's first `##` heading is `Why`, and that it contains
  no non-ASCII Latin letters (C9). This is the same cheap guard used in
  [005-language.md](005-language.md): it protects the one invariant the spec
  exists for and nothing else. Review is the real enforcement.
- Template prose is prompts to the author, in HTML comments, so an author who
  deletes nothing still produces a body with no instructions rendered in it.
