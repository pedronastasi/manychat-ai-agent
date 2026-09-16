---
status: implemented
implemented: 2026-09-16
pr: 24
constitution: [C1, C8]
---

# 011 — Dependency Updates

Defines how dependency updates enter this repository: which bot opens them, how
they are batched into pull requests, which ones merge without a person reading
them, and what protects the ones that do. It deliberately excludes workspace
hoisting, private registry authentication, and any policy on which dependencies
are allowed in the first place.

## Twenty-four dependencies is a stream of pull requests nobody finishes reading

This package has 13 runtime and 11 development dependencies (measured
2026-09-16). Most are on active release trains — Fastify, Vitest, ESLint,
Drizzle, the AI SDK and three provider packages — and an unconfigured bot on a
weekly schedule will open something in the order of five to fifteen pull
requests a month, each one a single version bump.

Every one of those runs three CI jobs: the full `verify` pipeline, Gitleaks over
the entire history, and CodeQL. And every one arrives asking a human the same
question, to which the honest answer is almost always "I have no idea, did CI
pass?"

## An unread bot PR is the checkbox problem from 006, wearing a diff

`006-pull-requests.md` refused to put a checklist in the PR template, and the
reason generalises exactly:

> Asking an author to tick "I ran the tests" next to a job that ran the tests
> teaches people to tick boxes without reading them, and the cost is paid on the
> one line that actually needed a human.

A dependency bot left on its defaults is a machine for manufacturing that
situation. Fifteen PRs a month that a person approves on the strength of a green
check is not fifteen reviews; it is a habit of approving on the strength of a
green check. The habit is what carries over to the sixteenth PR, which is the
major version bump that changes a default, or the transitive package that
changed hands last week.

So the position is not "pick the better bot". It is:

> **Configure for a small number of pull requests that are actually read, and
> be explicit about which ones nobody is going to read — then let those merge
> themselves rather than pretending they were reviewed.**

A patch bump that auto-merges on green CI is honest. The same patch bump sitting
open until someone clicks approve without opening the diff is the same event,
with a false audit trail attached. The second is worse, because the repository's
history now records a review that did not happen.

Everything below follows from that. The tool is chosen for how well it expresses
this policy, not on popularity.

## Dependabot is the default, and the deciding difference is how auto-merge works

Dependabot is the reflexive choice, and the case for it is real: it is
GitHub-native, it needs one YAML file and no third-party app installation, and
its grouping has closed most of the gap since 2023. Grouping is not the reason
to reject it.

The reason is auto-merge. In Renovate, auto-merge is a field on a rule:

```json
{ "matchUpdateTypes": ["patch"], "automerge": true }
```

In Dependabot, auto-merge does not exist. What exists is a pattern: you write a
second GitHub Actions workflow, triggered on `pull_request` events from the bot,
which calls `dependabot/fetch-metadata` to find out what kind of update it is,
branches on the result, and shells out to `gh pr merge --auto`. That workflow
needs `contents: write` and `pull-requests: write`, and it runs on
bot-authored pull requests.

`010-release-workflow.md § The Release PR does not run CI` declined a
long-lived write-scoped token to buy CI runs on a three-file diff, on the
grounds that C1's premise is minimising what holds write access here. The same
reasoning applies with more force to a privileged workflow that runs on every
bot PR and decides, in code this repository maintains, what merges without
review. That is a piece of security-relevant logic to get right, keep right, and
review — in exchange for a capability the alternative offers as a boolean.

Renovate's pnpm handling is the secondary argument and is treated as such: it
resolves `pnpm-lock.yaml` through pnpm itself and rebases a grouped branch when
it falls behind, which matters here because every dependency PR touches the
lockfile and therefore conflicts with every other one. Grouping is the real
mitigation for that, and both tools group. It breaks a tie rather than deciding
one.

Renovate is free for public repositories through the Mend-hosted app, so the
adoption cost is installing an app rather than committing a file.

## Three streams, not one PR per dependency

Updates are partitioned by semver impact, because that is the axis on which the
required human attention actually differs:

| Stream  | Batching              | Auto-merge | Why                                                              |
| ------- | --------------------- | ---------- | ---------------------------------------------------------------- |
| `patch` | One combined PR       | Yes        | No interface change is claimed. CI is the whole review           |
| `minor` | One combined PR       | No         | New surface, additive by contract — read the notes, then merge   |
| `major` | One PR per dependency | No         | Breaking by declaration. Batching them hides which upgrade broke |

Majors are deliberately **not** grouped. A combined major PR that fails CI
leaves no way to tell which of four upgrades broke it without unpicking the
branch, and majors are precisely the updates most likely to fail.

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended", ":semanticCommits"],
  "timezone": "Etc/UTC",
  "schedule": ["before 9am on monday"],
  "prConcurrentLimit": 5,
  "minimumReleaseAge": "3 days",
  "packageRules": [
    { "matchUpdateTypes": ["patch"], "groupName": "patch dependencies", "automerge": true },
    { "matchUpdateTypes": ["minor"], "groupName": "minor dependencies" },
    { "matchUpdateTypes": ["major"] },
    { "matchManagers": ["github-actions"], "groupName": "github actions", "automerge": false },
    { "matchDepTypes": ["engines", "packageManager"], "groupName": "toolchain", "automerge": false }
  ],
  "lockFileMaintenance": { "enabled": true, "schedule": ["before 9am on monday"] }
}
```

A weekly schedule rather than a continuous one, because the batching is the
point: a group that re-opens the moment any package ships turns back into a
stream. Major PRs open automatically like everything else — they sit until a
person reviews and merges them, and the weekly schedule keeps them from arriving
mid-sprint.

**The last two rules are ordering-sensitive, and silently so.** Renovate merges
`packageRules` in sequence, so for a dependency matched by several, the later
rule wins. The GitHub Actions and toolchain exclusions below carry
`automerge: false` and must stay _below_ the patch rule that grants it —
otherwise a patch bump to an action auto-merges, which is precisely what
_Deliberately not automated_ forbids. Placed above, the exclusion is void and
the configuration still validates, so the failure has no symptom.

## Auto-merge is a claim about CI, and CI does not check for malice

Auto-merging patches is defensible here only because of what CI actually runs.
A patch that breaks this project fails typecheck, lint, the test suite under
coverage thresholds (85% statements, 85% lines), the offline eval suite, or the
build. That is a stronger gate than a human skimming a version number, and it is
the honest basis for the policy.

It is not a gate against a deliberately malicious release. A compromised package
that exfiltrates an environment variable at install or first import passes every
one of those checks — the tests go green, because the payload is not what the
tests are looking at. CodeQL raises the floor and does not close this.

An earlier revision of this spec mandated `minimumReleaseAge: "3 days"` as a
mitigation — delaying every update on the premise that compromised npm releases
are typically pulled within hours to a day or two.

That delay was removed because the cost exceeds the benefit for this project.
When a dependency ships a fix for a real vulnerability, the three-day hold
blocks the patch from landing — exactly the moment speed matters most. The
weekly schedule already spaces updates, and auto-merge only reaches patches that
pass the full CI pipeline. A supply-chain compromise that passes CI is not
stopped by an age gate anyway.

## Dependency PRs feed the release, and the titles are what make that work

The `:semanticCommits` preset titles Renovate's pull requests with the
conventional prefixes this repository already requires (`006 § Title`):
`fix(deps):` for runtime dependencies, `chore(deps):` for development ones.

That is not cosmetic. `010-release-workflow.md` derives the version from commit
subjects, so the prefix decides what an auto-merged dependency bump does to the
next release:

| Update                        | Commit prefix | Effect on the Release PR               |
| ----------------------------- | ------------- | -------------------------------------- |
| Runtime dependency, any level | `fix(deps)`   | Patch bump; appears under Bug Fixes    |
| Dev dependency, any level     | `chore(deps)` | Patch bump; appears under Dependencies |

Both produce a release. `010-release-workflow.md` maps `chore(deps)` to a
visible Dependencies section rather than hiding it under Chores, because a dev
dependency update still changes the lockfile that ships with the build — hiding
it would suppress legitimate entries from the changelog.

The consequence is worth stating plainly rather than discovering: **auto-merged
patches change the version number.** A week with nothing but dependency updates
still produces a Release PR. This is correct — a dependency patch is a change
to what ships — but it means the release cadence is partly driven by a bot, and
a reader of the changelog should find dependency bumps there rather than be
surprised by them.

A prefix Renovate emits that `010` does not declare a section for would vanish
from the changelog silently. That spec's verification already asserts the
section list covers every admitted prefix, which covers this case too.

## Deliberately not automated

**Which dependencies are allowed.** Nothing here reviews a _new_ dependency;
this spec governs updates to ones already present. Adding a dependency is a pull
request a person argues for, and C2's constraint on provider packages is
enforced by lint, not by this bot.

**Node and pnpm versions.** `engines.node` and `packageManager` pin the
toolchain, and moving them changes what CI runs on and what a contributor needs
installed. Renovate can propose those bumps; they are never auto-merged, and
they are reviewed as toolchain changes rather than as dependency updates.

**GitHub Actions versions.** In scope for update PRs and explicitly excluded
from auto-merge regardless of semver level. An action version is a reference to
code that runs with this repository's credentials — including, after `010`, a
workflow holding `contents: write`. A patch bump to a mutable tag is not the
same class of change as a patch bump to a library, and it does not get the
library's policy.

**Security alerts.** Dependabot's security advisories stay enabled and are
independent of this. They are not scheduled and not batched, because an advisory
is a reason to look now. Renovate handles routine updates; the advisory feed
handles urgent ones.

## Verification

- `renovate.json` validates against the published schema, so a malformed rule
  fails in CI rather than by the bot quietly doing nothing — the failure mode of
  a bad Renovate config is silence, which is indistinguishable from a working
  repository. This runs as a **CI step**, `npx renovate-config-validator`, not
  as a unit test: the validator ships inside `renovate`, which has 123 direct
  dependencies, and a spec arguing for a small dependency surface should not
  add the largest package in the ecosystem to the install path of everyone who
  clones the repository. The cost is that it is the one check here a contributor
  does not get from `pnpm test`.
- A test asserts the configuration enables `automerge` for no update type other
  than `patch`, and that `minimumReleaseAge` is present and at least three days.
  Both are the policy above stated as a predicate; without the test, either can
  be relaxed in a one-line diff that reads as a tweak.
- A test asserts no rule grants `automerge` to `github-actions` or to the
  toolchain manager, matching the exclusions above, **and that both exclusions
  appear after the rule that grants it.** Order is what makes them effective,
  and the validator has no opinion about it.
- The first grouped patch PR is observed end to end: it opens on schedule, CI
  runs, it merges without intervention, and the following Release PR contains
  the resulting `fix(deps)` entries.

**What this does not prove.** The tests check the configuration, not the bot.
Renovate runs as a hosted service against this repository; if the app is
uninstalled, its permissions are revoked, or its schedule silently stops, every
assertion above still passes against a `renovate.json` that nothing is reading.
A repository with no dependency PRs is not distinguishable, from inside CI, from
one that is fully up to date. The observable signal is the dependency dashboard
issue Renovate maintains, and noticing that it has gone stale is a human task
with no alarm attached.

The mitigation that would actually address supply-chain compromise — pinned
digests and a vetted internal mirror — is disproportionate here and is not
specified.
