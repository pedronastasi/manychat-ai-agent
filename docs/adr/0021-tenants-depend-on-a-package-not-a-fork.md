# ADR-0021 — Tenants depend on a published package, not a fork

**Status:** accepted · **Date:** 2026-10-04

## Context

The only way to deploy this agent today is to fork the repository, add a
tenant's configuration and deployment files beside the source, and rebase onto
upstream to take a release. The one deployment that exists does exactly that.
Measured on 2026-10-04, its fork carries 162 commits that upstream does not,
adding 23 files and 3,496 lines, and none of those commits touches `src/`.
Everything it adds is configuration, evals, tenant tests, Compose files,
deployment workflows and its own specs. It also edits `ci.yml` and
`.gitignore`, which every rebase has to carry. Syncing is a rebase and a forced
push, and that diverges every other clone, the server's included.

Three things make that unsustainable together: a second tenant is coming, the
README offers the code to strangers who would each inherit the same rebase, and
the one fork already pays for it. ADR-0018 adds a fourth: a tenant shape fixed
before the Python service exists does not have to move again at the cutover.

The reflexive option is to keep forking, and its case is real. A fork can patch
`src/` in production within minutes. The existing fork did so three times
before the same fixes reached upstream, and a package makes such a fix wait for
a release. The other reflexive option is a Backstage-style split into many
packages (core, channel, outbox, evals, CLI) composed by a generated `main.ts`.
It is rejected because the fork shows tenants change configuration, not code,
and every package boundary would become a semver promise over internals that
the specs here still change weekly. An image with nothing on npm was rejected
too, because a tenant's evals and tests need the eval runner and the fixture
helpers as code they can import.

## Decision

A tenant project depends on the agent as one published package, whose public
surface is its CLI, its config schema and a declared plugin interface, and
starts from a `create` scaffolder instead of a fork. Both the package and the
Python service of ADR-0018 honour the same tenant contract.

## Consequences

- A tenant repository holds only what is the tenant's. A release arrives as a
  version bump that Renovate can open, not as a rebase, and no clone diverges.
- A stranger starts from `npm create`, not from deleting someone else's
  deployment out of a clone.
- The config schema becomes semver. A change to the shape of `config/` is
  either backwards compatible or a breaking release with its own migration,
  which slows down schema work that today is one pull request.
- Publishing credentials join the release path that `010` deliberately kept
  free of them: npm and the container registry, through OIDC trusted publishing
  where the registry offers it, and never a long-lived token in CI otherwise.
- Until the cutover, two distributions honour one contract, the npm package and
  the Python service, and a contract change is made in both.
- The CLI, the scaffolder, the image and the plugin interface become surfaces
  strangers file issues against, and supporting them is maintainer time.
- An urgent fix is a `pnpm patch` against the installed package plus an
  upstream pull request at the same time, and the patch is removed by the next
  release. That is slower to clean up than a fork, and it is the cost of the
  hotfix route the fork gave for free.
- If tenants keep patching the package, meaning more than one live
  `pnpm patch` in any tenant at once, configuration and plugins are not enough
  to extend the agent, and this decision should be revisited.
