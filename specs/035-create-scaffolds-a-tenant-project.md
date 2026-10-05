---
status: specified
constitution: [C1, C9]
adr: [0021]
---

# 035 — `create` Scaffolds a Tenant Project from the Fixture Tenant

Defines the `create-manychat-ai-agent` package: what it generates, where its
content comes from, and how it is released beside the agent. It leaves out what
a tenant project is and the package it depends on, which are `033`, and the
plugins a tenant may add later, which are `036`.

## Starting from someone else's deployment is how tenant data leaks

Without a scaffolder, the quickest way to start a tenant project is to copy one
that works. The only one that works is a live deployment, so the copy starts
with a real business's prompt, prices and schedule, and the new tenant deletes
what they notice. What they miss ships under their name, and whatever reaches
this repository as an example breaks C1.

So the rule is:

> **A new tenant project starts from the fictional demo tenant, generated, and
> never from a copy of a live one.**

## `create` scaffolds from the fixture tenant, never from a live one

`npm create manychat-ai-agent@latest my-agent` generates a tenant project and
nothing else. It is a second package, `create-manychat-ai-agent`, in a
`packages/create/` workspace, released together with the agent at the same
version.

It writes:

- `config/` from the committed `config/*.example` files, byte for byte. There
  is no second copy of the example tenant: the scaffolder reads the same files
  `pnpm bootstrap` copies, so the fictional demo tenant has one source (C1, C9).
- `.env` with the offline defaults `scripts/setup.mjs` writes today: the mock
  model, PGlite, a random shared secret and contact tokens unenforced, so the
  project runs before any account exists.
- `evals/<name>/cases.jsonl` with a few cases against the demo tenant, so
  `agent eval` has a suite to run on the first day.
- `package.json` depending on `manychat-ai-agent` at `^<version>`, the version
  of the scaffolder that ran.
- `docker-compose.yml` running the image at the same version.
- `.github/workflows/ci.yml` running `agent config check`, the mock eval suite
  and the tenant tests.
- `renovate.json`, so a release arrives as a pull request.
- `.gitignore` excluding `.env` and tracking `config/`.

It never writes `allowUnusedPatches`, for the reason
`033 § An urgent fix is a pnpm patch and an upstream pull request, together`
gives.

Everything the scaffolder writes is English and invented (C9, C1). The tenant
then replaces it with their own copy, in their own repository.

## A tracked `config/` is only safe in a private repository

The generated CI's first step fails when `github.event.repository.private` is
false. A tenant who makes their repository public finds out on the next push,
not after their prices have been indexed. The scaffolder does not ask about
visibility, because an answer given once at creation says nothing about the
repository a year later.

## The two packages are released as one version

`create-manychat-ai-agent@<version>` scaffolds a project that depends on
`manychat-ai-agent@^<version>` and runs the image tagged `<version>`, so the
three must exist together. The `release-please` manifest gains
`packages/create/` beside `.`, with the two versions linked, and `release.yml`
publishes both from the same tag. This is the monorepo manifest that
`010 § Deliberately not in scope` excluded while there was one package.

## Verification

- A test runs the scaffolder into a temporary directory and asserts the
  generated `config/` equals `config/*.example` byte for byte, the generated CI
  fails on a public repository, `agent config check` passes, and `agent eval`
  against the mock model passes on the generated suite. It also asserts the
  generated project does not set `allowUnusedPatches`.
- A test asserts the `release-please` configuration releases `.` and
  `packages/create/` at one linked version.

**What this does not catch.** The public-repository check runs only in a
tenant's GitHub Actions, and a tenant who deletes that step, or does not use
GitHub, is not covered. Nothing stops a tenant from copying a live project
instead of running `create`; the scaffolder makes the safe start the easy one,
and that is all.
