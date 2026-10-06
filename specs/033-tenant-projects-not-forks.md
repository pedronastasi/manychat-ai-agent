---
status: implemented
implemented: 2026-10-06
pr: 166
constitution: [C1, C6, C8, C9]
adr: [0021, 0018]
---

# 033 — Tenant Projects Depend on the Agent, Not Fork It

Defines what a tenant project contains, the published package and image it
depends on, how it upgrades and patches the agent, and when the existing
deployment fork has finished moving over. The contract holds for the TypeScript
package now and the Python service of ADR-0018 later. It leaves out the agent's
behaviour, which stays in the specs that already define it, and the hosting a
tenant deploys onto. The `create` scaffolder that generates a tenant project is
`035`, and the plugins that extend the agent without patching it are `036`.

## Forking makes every tenant a maintainer of the whole repository

The reflexive way to deploy an open-source service is to fork it: clone,
add configuration beside the source, and pull upstream when a release lands.
It is how the one deployment of this agent works today, and it is the only way
the README offers.

What that fork actually holds shows the cost. Measured on 2026-10-04, it
carries 162 commits that upstream does not, adding 23 files and 3,496 lines,
and none of those commits touches `src/`. Everything it adds belongs to the
tenant: configuration, an eval suite, two tenant tests, Compose files, deploy
and promote workflows, a reverse-proxy config and its own specs. To keep that
on top of upstream it also edits two upstream files, `ci.yml` and
`.gitignore`, and carries those edits through every sync.

A sync is `git rebase upstream/main` and a forced push. Each one rewrites the
fork's history, so every other clone, the server's included, diverges and can
no longer `git pull`. `009 § Adding a tenant's cases to the golden set is the
reflexive move` already had to bend an eval layout around that rebase. Every
stranger who adopts the agent this way inherits the same chore, plus the whole
repository: 33 specs and 21 ADRs as counted on 2026-10-04, the docs site and
the Python port, none of which they chose to maintain.

So the rule is:

> **A tenant project contains only what is the tenant's, and depends on the
> agent by version.** Nobody forks this repository to deploy it.

## A tenant project holds configuration, evals and deployment, and no source

This table is the tenant contract. It does not depend on the language: the
TypeScript package and the Python service both read exactly this layout.

| Path                 | Holds                                                   | Owned by |
| -------------------- | ------------------------------------------------------- | -------- |
| `config/`            | `prompt.md`, `catalog.json`, `rules.json`, `tools.json` | Tenant   |
| `.env`               | Credentials and model selection (`003 § .env`)          | Tenant   |
| `evals/<name>/`      | The tenant's eval suite (`009`)                         | Tenant   |
| `test/`              | Tenant tests, importing only the public entry points    | Tenant   |
| `docker-compose.yml` | Runs the published image with `config/` mounted         | Tenant   |
| `.github/workflows/` | The tenant's CI and deployment                          | Tenant   |
| `package.json`       | The agent as a dependency, at one pinned range          | Tenant   |

`036` adds `config/plugins.json` to this table when it is implemented.

Nothing on this list is a file upstream also edits. That is the property the
fork lacks, and the reason an upgrade can be a version bump.

The environment variables of `003 § .env`, the `CONFIG_DIR` and `EVAL_DIR`
selectors of `009`, the HTTP routes of `002`, and the eval case schema of `009`
belong to the contract as well. Changing any of them is a change to the
contract (below).

## The agent ships as one package whose surface is its CLI and its schemas

The package is `manychat-ai-agent` on npm, the name `package.json` already has.
It drops `private: true` and declares its surface explicitly.

**The CLI, `agent`.** It replaces every `pnpm` script a tenant runs today:

| Command                 | Replaces               | Does                                                                 |
| ----------------------- | ---------------------- | -------------------------------------------------------------------- |
| `agent serve`           | `pnpm start`           | Runs the server; applies migrations at boot, as now                  |
| `agent worker`          | `pnpm worker`          | Runs the outbox and nudge workers                                    |
| `agent eval`            | `pnpm eval`            | Runs the suite at `EVAL_DIR` against `CONFIG_DIR`                    |
| `agent simulate "msg"`  | `pnpm simulate`        | Sends a Dynamic Block request to a running server                    |
| `agent config check`    | A tenant test, today   | Parses `config/` with the schemas and the startup checks, then exits |
| `agent upgrade`         | A manual edit          | Rewrites `config/` to the installed version's shape                  |
| `agent tokens backfill` | `pnpm tokens:backfill` | As `019`                                                             |

`agent config check` runs the same validation `agent serve` runs at startup and
then exits. A tenant's CI calls it, so a typo in a flow id fails a pull request
rather than a container at boot. That is what the existing fork's tenant tests
were reaching into `src/` to do.

Every command loads `.env` from the working directory when one is there, as the
scripts it replaces did with `--env-file=.env`. A variable already set in the
environment wins over the file, so CI and a container set theirs as before. A
missing or malformed variable is reported as the environment, not as `config/`.

**Entry points, through an `exports` map.** Everything not listed here cannot
be imported, and Node refuses the attempt:

| Entry point                 | Exports                                                      |
| --------------------------- | ------------------------------------------------------------ |
| `manychat-ai-agent/config`  | The config schemas, their inferred types, `loadTenantConfig` |
| `manychat-ai-agent/testing` | The mock model helpers and `buildTools`, for tenant tests    |

The bare `manychat-ai-agent` has no entry point until `036` gives it
`definePlugin`. The runner, the race, the guardrails, the outbox, the registry
and the ManyChat client are not exported. A tenant who needs one of them has
found a missing configuration option or plugin hook, and the fix belongs
upstream.

The mock model helpers live in `test/helpers/model.ts` today, outside `dist/`
and outside the allowlist below. Exporting them means moving them under `src/`,
where the build emits them, and this repository's own tests then import them
from there. A helper published to tenants is a fake other people rely on, so it
honours the provider contract it stands in for, nested `usage` shape included,
as `CLAUDE.md` already requires of this repository's own fakes.

**The package is published from an allowlist.** `files` in `package.json` names
`dist/`, `db/migrations/`, `README.md`, `LICENSE` and `CHANGELOG.md`, and
nothing else. A maintainer's working tree holds a real `config/` and `.env`.
They are gitignored, but `.gitignore` is not what `npm publish` reads, so
without the allowlist the first publish from a laptop would ship them (C1).
Publication runs only in `release.yml`, from a clean checkout, so the allowlist
is the second guard, not the only one.

## The image is published beside the package, at the same version

Each release also publishes `ghcr.io/<owner>/manychat-ai-agent:<version>`, built
from the release tag with the existing `Dockerfile`. A tenant's Compose file
runs that image and mounts `config/` read-only, so `SIGHUP` reload (`003 §
Reload`) works unchanged.

The image is the deployment form, and the npm package is how a tenant runs
evals, tests and `config check` in CI. Both come from the same tag and carry
the same version. The image contains no `config/` and no `.env`; the same
allowlist reasoning applies to its build context.

This is not the test-service image of `015`, which stays tagged by commit SHA
and never by version.

## The contract survives the Python cutover because the image is language-neutral

ADR-0018 replaces the TypeScript service with a Python one. A tenant that
deploys the image and drives it through the contract above does not notice
which language is inside: the Python image reads the same `config/`, the same
environment, serves the same routes and answers to the same commands.

So the Python service honours this spec's contract table, the CLI's command
names and the image's mount points before it is published as a release image.
That joins `026`'s parity gate. Until the cutover, a change to the contract is
made in both codebases, which is the cost ADR-0021 accepts.

Two things do not carry over, and this spec says so rather than hiding it.
Tenant tests that import `manychat-ai-agent/testing` are TypeScript and run
against the TypeScript package; at the cutover they are rewritten or replaced
by `agent config check` and evals run through the image. Plugins are code, and
a plugin is written for one codebase (`036`).

## A release is a version bump, and a breaking config change ships its migration

Before 1.0, `010 § Before 1.0, a breaking change bumps the minor` applies: a
breaking change moves the minor. A caret range on a `0.x` version already
excludes the next minor, so a tenant's `^0.14.0` takes patches
automatically and leaves every breaking release to a Renovate pull request that
a human merges.

What counts as breaking is now defined by the contract, not by the code:

- a config file that parsed in the previous release and does not parse now;
- an environment variable, CLI command, route or eval case field that is
  removed or renamed;
- a plugin API change, once `036` defines one.

A pull request that breaks `config/` in this sense ships an `agent upgrade`
migration in the same pull request. A migration is a function from the previous
shape to the new one. It is idempotent, so running it on an already-migrated
config changes nothing, and `agent upgrade` runs every migration in order
without needing to know which version the config was written for. It never
invents tenant values. When the new shape needs something only the tenant can
supply, the migration leaves it out, so `agent config check` fails and names
the field.

## An urgent fix is a `pnpm patch` and an upstream pull request, together

A fork could hotfix `src/` in production within minutes, and the existing one
did, three times, before upstream had the same fixes. That speed is the
strongest argument for forking, and a package cannot match it with a release
alone.

So the sanctioned route is `pnpm patch manychat-ai-agent@<version>`, committed
in the tenant project, with the same fix opened upstream at the same time.
pnpm keys the patch to that exact version, and fails the install when the
version it targets is no longer the one installed: `ERR_PNPM_UNUSED_PATCH`,
exit code 1, checked with pnpm 12.6.0 on 2026-10-04. The next upgrade
therefore cannot silently drop a patch or silently keep one; it forces the
tenant to confirm that the upstream fix landed and to delete the patch.

That holds only while `allowUnusedPatches` is off, which is pnpm's default. A
tenant project never sets it, because setting it turns the forced removal back
into a silent one, and `035`'s scaffolder does not write it.

A patch is an escape hatch, not a way to extend the agent. ADR-0021 names
more than one live patch in any tenant at once as the condition for revisiting
this whole design: it would mean configuration and plugins are not enough.

**Open: the patch does not reach production.** `pnpm patch` changes the
installed npm package, which is what a tenant's CI, evals and `agent` commands
run. Production runs the published image, and the patch does not touch it, so
the route above fixes CI and not the deployment. Until this spec says how a
patched fix reaches the running service, an urgent fix production needs ships
as an upstream release.

## The existing fork becomes the first tenant project, and then it is not a fork

The existing deployment is the proof that the contract is enough, so moving it
is part of this spec, not a follow-up. The move is finished when the
deployment's repository:

- has no `upstream` remote, and no file copied from this repository. Files it
  writes for itself, such as its `.gitignore`, `README.md`, lockfile, specs and
  runbook, may share a name with one here; what they may not share is content;
- depends on a published `manychat-ai-agent` version and runs the published
  image at that version in production;
- has tenant tests that import only the public entry points, with the
  checks that reached into `src/` replaced by `agent config check` where it
  covers them;
- has no edits to an upstream `ci.yml` or `.gitignore` to carry, because it has
  its own;
- no longer documents a rebase-and-force-push sync.

The steps, for this fork or any other, are in
[Moving a deployment fork to a tenant project](../docs/guides/moving-a-fork-to-a-tenant-project.md).
Its specs, runbook and workflows stay in its own repository; none of them moves
here (C1). If the move needs a change this spec did not foresee, the change is
made here first and the contract table above records it.

## What changes in other specs

- `010 § Deliberately not in scope` excluded npm publish, container images and
  monorepo manifests. This spec specifies the first two. The third stays
  excluded: `035`'s scaffolder is a second package, released as part of the
  agent under its version (`010 § Monorepo manifests`). Publishing uses npm
  trusted publishing and the workflow's own `GITHUB_TOKEN` for GHCR, so
  `release.yml` gains `id-token: write` and `packages: write` but no stored
  credential. `ci.yml` keeps `contents: read`.
- `009`'s rebase-clean overlay stops being the reason for the eval layout; the
  layout stays, because a tenant suite is still not the golden set.

## Verification

- A test runs `npm pack --dry-run --json` in a working tree that contains a
  `config/prompt.md` and a `.env`, and asserts the packed file list is exactly
  the allowlist, with neither of them in it.
- A test asserts `package.json`'s `exports` map names exactly the entry points
  in the table above, and that importing a path outside them, such as
  `manychat-ai-agent/dist/agent/runner.js`, fails with
  `ERR_PACKAGE_PATH_NOT_EXPORTED`.
- For each `agent upgrade` migration, a test runs it on the previous release's
  example config and asserts the result passes `agent config check`, and that a
  second run changes nothing.
- A test asserts each CLI command in the table exists and exits non-zero on an
  invalid `config/`.
- A test asserts `release.yml` is the only workflow this repository ships with
  `packages: write`, extending `010`'s `contents: write` check. The test names
  the shipped workflows. In this repository's own CI it also checks every
  other file in `.github/workflows/`, so a new workflow cannot hold the grant
  unlisted. Elsewhere it checks the named ones only: a deployment fork's own
  workflow that pushes its image is the tenant's, until the fork becomes a
  tenant project. `id-token: write` is already held
  by `docs.yml`, `claude.yml` and `claude-code-review.yml`, so the test asserts
  only that `release.yml` requests it.
- The release image was checked once, at 0.15.2, and the check accepted
  three things in place of a fixture boot and a listing of the image. It
  served a tenant's real `config/`, mounted read-only, in a test environment
  and then production. Every image tag up to 0.15.2 was built by
  `release.yml` from a clean checkout, which holds no `config/` or `.env` to
  copy, and the `Dockerfile`'s runtime stage copies only `node_modules`,
  `dist`, `package.json` and `db/migrations`. Every published npm version's
  file list contains neither, including the two published by hand before
  trusted publishing worked.
- The fork's migration is checked against the list above by reading the
  deployment repository. That repository is private, and no test here can see
  it. So the pull request that implements the package leaves this spec
  `specified`, and a later one flips it once the move is confirmed.

**What this does not catch.** Nothing checks that a release which changes the
contract is marked breaking. The migration test only runs for migrations that
exist, so a breaking config change with no migration and no `!` in the commit
ships as a minor with no upgrade path. Review is the enforcement, as `010`
says of commit subjects in general. Nothing counts live `pnpm patch` files across tenants;
the revisit trigger of ADR-0021 is watched by the maintainers, not by CI.
