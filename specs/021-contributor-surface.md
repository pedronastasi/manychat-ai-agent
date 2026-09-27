---
status: implemented
implemented: 2026-09-28
pr: 105
constitution: [C1, C9]
---

# 021 — Contributor Surface

Defines what a stranger meets before reading any code: how issues and questions
are taken in, the README's first screen, the opening of CONTRIBUTING, the Code
of Conduct, and the repository settings. It deliberately leaves out promotion,
the documentation site (`014-docs-site.md`), and which issues get opened.

## An issue is the unguarded half of 006

`006-pull-requests.md` closed one route for tenant data to reach the public
internet: the text a human types into a pull request. Its argument was that
`.gitignore` protects the repository, not the prose around it, and that the
only moment to stop a pasted transcript is the moment it is being written.

Issues are the same route with no template at all. The reflexive setup for a
small project is a blank issue box, because templates feel like ceremony and
nobody has filed anything yet. Here that default is wrong for a specific
reason: the most natural bug report this project will ever receive is "the
agent said the wrong thing to a customer", and the most natural way to write
it is to paste the conversation. That conversation is a real contact's words,
often a phone number, and the tenant's real prices. It reaches the public
internet on submit, and deleting the issue later does not remove it from
notification emails or anything that indexed it.

So the rule is:

> **Every public text box this repository offers carries the C1 reminder at
> the moment of writing, and none of them can be skipped.** Issues and
> discussions get the treatment `006` gave pull requests.

The Wiki is the one text box that cannot carry the reminder, so it is off (see
the settings section below).

## Blank issues are disabled, or the template is optional

`.github/ISSUE_TEMPLATE/config.yml` sets `blank_issues_enabled: false`. With
blank issues enabled, GitHub offers "Open a blank issue" beside every template,
and the template becomes a suggestion the author scrolls past. A reminder that
is optional is not at the moment of writing; it is somewhere nearby.

## Issue forms, not Markdown templates, because only a form can require the acknowledgement

A Markdown issue template is prefilled text in a textarea. The author can
delete it, and a checkbox in it is a character pair the author can ignore.
GitHub issue forms (`.yml`) render real fields, and a checkbox field with
`validations: required: true` blocks submission until it is ticked.

There are exactly two issue forms:

| Form                  | Label         | Required acknowledgement                                           |
| --------------------- | ------------- | ------------------------------------------------------------------ |
| `bug_report.yml`      | `bug`         | No real transcripts, prices, names, phone numbers or `.env` values |
| `feature_request.yml` | `enhancement` | The same                                                           |

The acknowledgement names what to leave out in the same terms as the pull
request template, so a contributor meets one rule, not two phrasings of it.

Both forms, their labels, descriptions and placeholders are English (C9).

## A bug report asks for a reproduction against the fixture tenant, not a transcript

The checkbox tells an author what not to paste. The bug form also has to give
them something to paste instead, or the reminder only makes the report worse.

The form's reproduction field asks for the message sent and the reply received
with `pnpm simulate` against the fixture tenant
(`CONFIG_DIR=test/fixtures/config`) and the mock model. That configuration is invented (C1), deterministic, and
what a maintainer would run first anyway. A bug that only reproduces against a
real tenant's configuration is described by what the configuration does (for
example "a course whose FAQ answer mentions a second price"), never by quoting
it.

## Questions go to Discussions, vulnerabilities to SECURITY.md

`config.yml` adds two contact links in place of the disabled blank issue:

| Link             | Target                                                               |
| ---------------- | -------------------------------------------------------------------- |
| Questions        | The repository's Discussions, Q&A category                           |
| A security issue | GitHub's private vulnerability reporting, as `SECURITY.md` describes |

Routing questions to Discussions moves text off the issue tracker; it does not
make that text safe. The Q&A category therefore has its own form,
`.github/DISCUSSION_TEMPLATE/q-a.yml`, with the same required acknowledgement.
Without it, this section would move the leak rather than close it.

## The README's first screen says who it is for and shows it running

The first screen is everything in `README.md` above the first `##` heading. A
visitor who stops there has to leave knowing three things: that the project is
maintained, who it is for, and that it runs without accounts.

**Badges, and which ones.** Directly under the title: CI status for
`ci.yml`, the license, the latest release, and the Node version from
`engines.node`. The CI badge is GitHub's own workflow badge; the other three are
shields.io reading public repository metadata. No badge sends anything from CI
to a third party.

There is deliberately no coverage badge. CI fails below the thresholds in
`vitest.config.ts`, so a passing CI badge already says coverage held. A
separate badge would need either a third-party service receiving every
coverage report or a self-published endpoint, and it would add nothing a
reader can act on.

**Who it is for, in one sentence.** Anyone putting an LLM behind a platform
that enforces a hard webhook timeout. ManyChat is the adapter that ships, not
the audience: the race and the outbox are what a stranger can reuse.

**The demo is recorded, not described.** "No API key and no database" is the
strongest claim the README makes, and a claim is weaker than a recording of it.
The first screen embeds a recording of `pnpm simulate` answering one question
and escalating one, committed as an animated SVG under `docs/assets/`, so it
renders on GitHub and on the site without an external host.

It is recorded with the mock model and the fixture tenant, like the bug form's
reproduction. A recording made against a real deployment would publish that
tenant's copy as an image, which no text check can see (C1, C9).

## CONTRIBUTING opens with the PR that needs no spec

The current CONTRIBUTING is correct and reads as a gate: specs before code, a
constitution, tests that cite clauses, a mandatory `## Why`. A first-time
contributor reading it top to bottom learns that any change needs a spec, which
is false for the changes a first-time contributor is most likely to make.

So CONTRIBUTING opens, directly after the three-line quick start, with a
section naming what needs **no** spec and **no** ADR: documentation fixes, new
or stronger tests, new eval cases, and bug fixes that restore specified
behaviour. It then gives one paragraph on when a spec is required (new or
changed behaviour) and when an ADR is (a choice between defensible options that
a later reader would question), and links `specs/` and `docs/adr/` from there.
Everything CONTRIBUTING says today stays; it moves below that section.

The PR template and CI apply to every pull request either way. The on-ramp
changes the order a newcomer reads the rules in, not which rules apply.

## Conduct reports go to a private form, not an address

`CODE_OF_CONDUCT.md` is the Contributor Covenant, unmodified except for the
enforcement contact. An unmodified code is one a contributor already
recognises; an edited one is a document they have to read to trust.

The contact is a link to a web form whose responses only the maintainers can
read. It is not an email address. An address in a published file is harvested
whether or not it is used for anything else, and it ties the project's conduct
process to one person's inbox. A form publishes nothing that can be mailed,
needs no account to fill in, and can be handed to another maintainer by sharing
its responses.

GitHub's own private route, content reported directly to maintainers, exists
only for repositories owned by an organization. This one is owned by a personal
account, so that route is not available. If the repository moves to an
organization, content reporting replaces the form.

This spec does not name the form. It is set when the file is written, it asks
for nothing a report does not need, and it is not a tenant's (C1).

## Repository settings are part of the surface, and the one part no test sees

Some of what a stranger meets is not in git. It is specified here because a
settings change nobody wrote down gets undone silently.

| Setting        | Value                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Topics         | `whatsapp`, `manychat`, `ai-agent`, `llm`, `chatbot`, `vercel-ai-sdk`, `fastify`, `typescript`, `outbox-pattern`, `customer-support` |
| Social preview | An image of the race diagram from the README, drawn with fixture values only; its source is committed under `docs/assets/`           |
| Discussions    | On, with a Q&A category                                                                                                              |
| Wiki           | Off                                                                                                                                  |
| Homepage       | The GitHub Pages URL of `014-docs-site.md`, set once that site deploys; empty until then                                             |

**The Wiki is off because it is a second copy of the docs outside review.**
`014` rejects a `docs/` tree of rewritten pages because the copy drifts from the
spec; a Wiki is that copy with no pull request at all. It is also a public text
box with no form, so it cannot carry the acknowledgement this spec requires
everywhere else.

**Topics are chosen for how a stranger searches, not for what the code
imports.** Each one is a term someone with the problem would type:
`outbox-pattern` and `customer-support` are there, `drizzle` and `zod` are not.

## Verification

- A test asserts `.github/ISSUE_TEMPLATE/` contains exactly `bug_report.yml`,
  `feature_request.yml` and `config.yml`, that `config.yml` sets
  `blank_issues_enabled: false` and links Discussions and security reporting,
  and that no Markdown issue template exists beside the forms.
- A test asserts each issue form and `.github/DISCUSSION_TEMPLATE/q-a.yml` has a
  checkbox field marked required whose text names transcripts, prices and
  phone numbers.
- A test asserts the bug form's reproduction field names `pnpm simulate` and
  the fixture tenant.
- A test asserts that the README above its first `##` heading contains the four
  badges, no coverage badge, and an image under `docs/assets/`.
- A test asserts that the first `##` section of CONTRIBUTING is the no-spec
  on-ramp, and that it precedes any mention of the Constitution.
- A test asserts `CODE_OF_CONDUCT.md` exists, names an HTTPS form as its
  enforcement contact, and contains no email address.

**What this does not catch.** A required checkbox proves the author clicked
it, not that they read it; the form makes the rule unavoidable to see, not
impossible to break. A pasted transcript is still possible, and review of new
issues is still the enforcement, exactly as `006` says of pull requests.

Nothing checks that the demo recording and the social preview were made from
the fixture tenant. They are images, and review is the only check.

Nothing checks that the conduct form's responses are private, or that anyone
reads them. The form lives outside GitHub, like the settings below.

**Settings are manual.** Topics, the social preview, Discussions, the Wiki and
the homepage live in GitHub, not in git, and no test in this suite can see
them. They are applied once by hand, and whoever applies them checks them
against the table above.
