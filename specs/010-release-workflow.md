---
status: implemented
implemented: 2026-09-16
constitution: [C1, C8, C9]
---

# 010 — Release Workflow

Defines how a version in this repository reaches a git tag and a published
changelog: which tool decides the number, what a release contains, and where a
human sees it before the public does. It covers a single package, and
deliberately excludes registry publication, container images, and monorepo
manifests.

## Today there is no release, and that is a gap a stranger notices first

`package.json` says `0.1.0`. It has said `0.1.0` since the first commit, there
are no tags, and there is no `CHANGELOG.md`. Nineteen pull requests have landed
against a version number that never moved.

The cost is not internal. Everyone working here reads `git log`. The cost is
paid by the audience `006-pull-requests.md` was written for — the stranger
following `git blame` → commit → pull request — who arrives at a repository
with no releases page and no way to answer "what changed between the version I
read about and the one in front of me?" A repository that is published but
never released is a repository whose history is only legible to people who
already have it cloned.

Cutting that release by hand is the thing that will not happen twice. Deciding
whether nineteen merged PRs constitute a minor or a patch, writing the notes,
tagging, and remembering to bump `package.json` is a chore with no forcing
function. It gets done once, enthusiastically, and then never again.

## semantic-release is the popular answer, and it puts the only review after publication

The reflexive choice is `semantic-release`. It is the most-downloaded tool in
this category by a wide margin, it reads the conventional commits this
repository already writes, and it needs no human in the loop: push to `main`,
and a tag, a changelog and a GitHub Release appear.

That last property is the one to reject, and not because automation is
suspect. It is because **the only point at which a human could read the release
notes is after they are public.**

`006-pull-requests.md` already identified the shape of this problem:

> `.gitignore` protects the repository. It does not protect a pull request body.

A generated changelog is that same hole, one step further out. Release notes
are assembled from commit subjects, and a commit subject is free text a person
typed. Nothing in C1's enforcement — `.gitignore` plus Gitleaks — reads it for a
tenant's course name, a real price, or a customer's number quoted in a fix
description. Gitleaks scans for credentials, not for a business's data.

A PR body with that mistake in it is edited in place, and the damage is bounded
by who read it in the interim. A release is worse in three specific ways: it is
rendered on a Releases page, it is pushed to that page's Atom feed, and it is
attached to an immutable tag. By the time anyone notices, the text has been
distributed by mechanisms that have no edit path.

So the requirement is not "automate the release". It is:

> **The changelog must be reviewable as a diff before the tag exists.**

`semantic-release` cannot satisfy that; the model is push-to-publish. That is
what rules it out, and it is the only reason it is ruled out.

`changesets` satisfies it, by a different route — a contributor writes an
intent file per change, and the release is a PR. It is rejected for a narrower
reason: it does not read conventional commits, so it would add a second,
parallel vocabulary for describing a change to a repository that already
mandates one (`006 § Title`). Its payoff is coordinating versions across a
workspace, and there is one package here.

## The Release PR is the review surface

`release-please` watches `main`, accumulates conventional commits, and keeps a
single open pull request that contains the version bump and the rendered
changelog. Merging that PR is what cuts the release; the tag and the GitHub
Release are created from the merge.

This inverts the property that disqualified `semantic-release`. The changelog
arrives as a diff, in the review surface this repository already uses, and the
checkbox that `006` put in the PR template — _no tenant data_ — is in front of
the person approving it. The release is still automatic in the sense that
matters: nobody decides the number, writes the notes, or remembers to tag.

The Release PR is also the answer to "is it time to release?", which otherwise
has no answer. It sits open, showing exactly what an unreleased `main` has
accumulated. Merging it is a decision with the evidence already attached.

## Before 1.0, a breaking change bumps the minor

This package is `0.1.0` and is not ready to promise a stable interface.
`release-please` must therefore be told to treat a breaking change as a minor
bump rather than promoting to `1.0.0` on the first `!` commit:

```json
"bump-minor-pre-major": true
```

Without it, the first commit marked breaking silently declares the project
stable, which is a claim nobody made. Reaching `1.0.0` is a deliberate act:
flip this flag off, in a pull request that argues the interface is settled.

Also set, and for the same reason:

```json
"bump-patch-for-minor-pre-major": false
```

`feat:` commits continue to move the minor while below `1.0.0`, so the version
still distinguishes a release that added behaviour from one that only fixed it.

## The default changelog sections do not match this repository's commit vocabulary

`release-please` renders only `feat` and `fix` by default, and hides everything
else. Applied here, that would be wrong in a way that is easy to miss: this
repository's conventions (`CLAUDE.md`, `006 § Title`) admit six prefixes, and
the two that carry the most consequential changes are among the hidden ones.

A `refactor:` in this codebase is not cosmetic — `refactor: English throughout,
and no customer copy in source` moved every customer-facing string out of
`src/`. A `docs:` commit is how a spec lands, and this project's specs are
binding on its tests (C8). Both would be invisible.

The sections are therefore declared explicitly:

| Prefix     | Section heading | Hidden |
| ---------- | --------------- | ------ |
| `feat`     | Features        | No     |
| `fix`      | Bug Fixes       | No     |
| `refactor` | Refactors       | No     |
| `docs`     | Specs and Docs  | No     |
| `test`     | Tests           | Yes    |
| `chore`    | Chores          | Yes    |
| `ci`       | CI              | Yes    |

Hidden means the commit still counts toward the version bump but does not
appear in the notes. `test`, `chore` and `ci` are hidden because they describe
work on the repository rather than changes to the thing being released, and a
changelog that lists lockfile bumps beside behaviour changes is one nobody
finishes reading.

## `CHANGELOG.md` must be excluded from the format check

`pnpm format:check` runs Prettier across the repository and is a required CI
step. `release-please` generates `CHANGELOG.md` to its own template, which is
not Prettier's output — most visibly in line wrapping, since this repository
sets `printWidth: 100`.

The failure this produces is confusing out of proportion to its cause. The
Release PR does not run CI (below), so the malformed file merges cleanly. The
failure then surfaces on the **next unrelated pull request**, as a format error
in a file that pull request did not touch.

`CHANGELOG.md` is therefore added to `.prettierignore`, alongside the other
generated artefacts already listed there (`pnpm-lock.yaml`, `db/migrations/`).
The file is generated, so formatting it by hand would be reverted by the next
release anyway.

## The Release PR does not run CI, and that is accepted

A workflow authenticated with the default `GITHUB_TOKEN` cannot trigger another
workflow. The pull request `release-please` opens will therefore show no checks,
and no amount of configuration in `ci.yml` changes that — the constraint is in
the token, not the workflow.

This is accepted rather than worked around. The Release PR's diff is exactly
three files:

| File                            | Change                    |
| ------------------------------- | ------------------------- |
| `CHANGELOG.md`                  | Prepended release section |
| `package.json`                  | `version` field           |
| `.release-please-manifest.json` | Current version           |

None is reachable by typecheck, lint, the test suite, the eval suite or the
build, and the one that Prettier _would_ have objected to is excluded in the
section above. Every commit the release contains already passed CI on its own
pull request.

The escape hatch — a GitHub App token or PAT, which does trigger workflows — is
deliberately not used. It trades a long-lived credential with write access for
CI runs over a three-file diff that CI cannot fail on, and C1's premise is that
credentials in this repository's blast radius are the thing to minimise.

## What a release contains

| Artefact            | Produced | Notes                                      |
| ------------------- | -------- | ------------------------------------------ |
| Git tag             | Yes      | `vX.Y.Z`, on the Release PR's merge commit |
| GitHub Release      | Yes      | Body is the changelog section              |
| `CHANGELOG.md`      | Yes      | Cumulative, newest first                   |
| `package.json` bump | Yes      | `version` only                             |
| npm publish         | No       | See below                                  |
| Container image     | No       | See below                                  |
| Build artefacts     | No       | Consumers build from source                |

The workflow runs on push to `main`, and needs write access that `ci.yml`
deliberately does not have:

```yaml
name: Release
on:
  push: { branches: [main] }
permissions:
  contents: write
  pull-requests: write
jobs:
  release-please:
    runs-on: ubuntu-latest
    steps:
      - uses: googleapis/release-please-action@v4
        with:
          config-file: release-please-config.json
          manifest-file: .release-please-manifest.json
```

The workflow points at the two configuration files and declares nothing about
the release itself. The action also accepts a `release-type` input inline, which
would put the release's shape in two places — the changelog sections and the
pre-1.0 bump rules have to live in the config file regardless, so the workflow
is kept to permissions and wiring.

There is no `actions/checkout` step. The action operates through the GitHub API
rather than a working tree, so a checkout would be cost with no effect.

This lives in `.github/workflows/release.yml`, separate from `ci.yml`. Keeping
them apart is what lets `ci.yml` keep `permissions: contents: read` — the
workflow that runs against every fork's pull request never needs write access,
and merging the two would hand it some.

## Deliberately not in scope

**npm publish.** `package.json` sets `private: true`, so publication is not
merely unimplemented, it is refused by the tooling. Publishing is a separate
decision about supporting external consumers, and it brings a registry token
into the release path. When it is made, it is an added step keyed off
`release-please`'s `release_created` output, and it does not change anything
specified here.

**Container images.** The deployment artefact is built outside this repository
(`rossy-nails-deploy`). A release here is a source-level marker; what consumes
it is that repository's concern.

**Monorepo manifests.** `release-please` supports releasing many packages from
one repository. There is one package. The manifest file exists only because v4
of the action uses it in the single-package case too.

**Pre-releases and release branches.** No `next`, `beta` or `rc` channel, and no
maintenance branches. Every release is cut from `main`. A project with no
released versions has no users to maintain an old line for, and adding channels
before anyone is on one is complexity with no reader.

## Verification

- A release cut end to end produces a tag, a GitHub Release whose body matches
  the new `CHANGELOG.md` section, and a `package.json` version equal to the
  tag. This is checked once, on the first release, by reading it.
- `.prettierignore` contains `CHANGELOG.md`, and `pnpm format:check` passes on
  a working tree containing a generated changelog. A test asserts the entry is
  present, because its absence fails on an unrelated pull request, which is the
  hardest kind of failure to attribute.
- A test asserts `release-please-config.json` declares a section for every
  commit prefix this repository admits, so a prefix added to the conventions
  without a section — which would silently vanish from every changelog — fails
  in CI rather than at the next release.
- `ci.yml` retains `permissions: contents: read`. A test asserts no workflow
  other than `release.yml` requests `contents: write`.

**What this does not prove.** Nothing here checks the changelog for tenant data
(C1). The Release PR puts the text in front of a human with the `006` checklist
attached, and that is the whole mechanism. It is a review gate, not a scanner,
and it fails exactly as a review gate fails: when the reviewer is the person who
wrote the commit and reads what they meant instead of what they typed.

The versioning is also only as honest as the commit subjects. A behaviour change
committed as `chore:` produces a patch release that changed behaviour, and no
test can catch that without understanding the diff. C8's requirement that a
behavioural change updates its spec is the closest thing to a backstop, and it
is enforced by review as well.
