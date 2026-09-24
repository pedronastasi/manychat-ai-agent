---
status: specified
constitution: [C1, C9]
---

# 014 — Documentation Site

Defines how the repository's Markdown is published as a browsable site on
GitHub Pages: which files are served, how the site is built, and what fails the
build. It deliberately leaves out versioned docs, a custom domain, analytics,
translations, and any prose written for the site rather than for the repository.

## The docs exist; they are hard to read, not missing

There are 30 documents a reader might want (counted 2026-09-24): the README,
CONTRIBUTING, SECURITY, the CHANGELOG, fifteen specs and their index, and ten
ADRs. They link to each other densely, and
the only way to read them today is one rendered file at a time on GitHub, with
no navigation between them and no search across them.

The audience `006-pull-requests.md` was written for, the stranger following
`git blame` to a pull request, is the one this costs. Answering "which spec
enforces C6, and which decision produced it?" means three browser tabs and the
repository's own file search. Nothing here needs writing. It needs to be
readable as a set.

## A docs/ tree of rewritten pages is the default, and it drifts

The reflexive setup for a documentation site is a `docs/` directory shaped for
the site generator: pages copied or rewritten from the specs, grouped into
guides, with the generator's front matter on top. It looks tidier than a
repository root, and every generator's quick-start produces it.

It is rejected because it creates a second copy of every spec, and the second
copy is the one readers find first. A spec gets edited in a pull request that
also changes behaviour (C8); the site copy does not, because nothing connects
them. Within a month the site describes a system that no longer exists, in the
same confident voice as the spec that does. That is the failure
`008-spec-metadata.md` describes for a hand-kept status field, with a larger
blast radius.

So the rule is:

> **The site renders files where they already live, and adds only
> navigation.** No Markdown is copied, moved or rewritten to be published. The
> file a pull request edits is the file the site serves.

The site is built with VitePress from the repository root (`srcDir: '.'`). The
repository's `README.md` is served as the home page and `specs/README.md` as the
specs index, both through VitePress `rewrites`, so neither file moves. The only
new files are the site's configuration under `.vitepress/` and the deploy
workflow.

## The sidebar is derived, never hand-listed

A sidebar typed into the site configuration is the same drift in a smaller
place: the first spec merged without editing it is a spec the site cannot
navigate to.

The sidebar is computed at build time from the directory listing of each
published directory, in filename order, labelled with each file's `#` title.
Adding a spec or an ADR adds it to the site without touching `.vitepress/`.

## Publication is an allowlist, because the repository holds Markdown that must not be served

The repository contains Markdown that was never written for a public audience
and must not become one:

| Tracked file                   | Why it stays off the site                                  |
| ------------------------------ | ---------------------------------------------------------- |
| `config/README.md`             | Setup notes for the directory a tenant's real config fills |
| `test/fixtures/**/prompt.md`   | Fixture personas; invented (C1), but not documentation     |
| `CLAUDE.md`, `.claude/skills/` | Instructions to an agent, not to a reader                  |
| `.github/*.md`                 | Templates GitHub renders into forms                        |

A denylist of those paths would publish the next one somebody adds. C1 makes
the direction of failure matter: a file wrongly left off the site is a missing
page someone reports; a file wrongly put on it is published before anyone has
looked.

So the published set is **exactly** these, and nothing else:

| Source                                        | Served as         |
| --------------------------------------------- | ----------------- |
| `README.md`                                   | Home page         |
| `CONTRIBUTING.md`, `SECURITY.md`              | Top-level pages   |
| `CHANGELOG.md`                                | Release history   |
| `specs/*.md` (`specs/README.md` as its index) | Specs section     |
| `docs/adr/*.md`                               | Decisions section |
| The OpenAPI document (generated, see below)   | API reference     |

A Markdown file outside those paths is unpublished until a change to this spec
and to the allowlist adds it. The allowlist is published content, so widening it
is a C1 decision, not a configuration tweak.

The CHANGELOG is included because it has already been reviewed as a diff before
the tag existed (`010-release-workflow.md`). The site adds a place it can be
read, not a new way for text to reach it.

## Links outside the site point at GitHub, not at nothing

The documents link to code: specs cite `src/` files, CONTRIBUTING links to
`.claude/skills/`. On GitHub those links resolve. On the site their targets are
not published, so they would be dead links.

Editing the documents to use absolute URLs would break the rule above: the
file would be changed so that it could be published. Instead, at build time,
a relative link whose target is outside the published set is rewritten to the
same path on `main` at `github.com/pedronastasi/manychat-ai-agent`. The source
file is unchanged and its links keep working on GitHub. On the site they open
the code they name.

A relative link whose target does not exist at all is not rewritten. It fails
the build (see below).

## The API reference is generated from the Zod contracts, never committed

The Zod schemas are the source of truth for the wire contract, and they already
generate an OpenAPI document through `@fastify/swagger` (ADR-0003). The site
publishes that document, rendered as a reference page.

It is exported at build time, by building the Fastify app with the same
placeholder settings CI's eval step uses and an embedded database, then reading
`app.swagger()`. No model key, no network, no real secret. The document is
never committed: a committed copy is a second source of truth for the contract,
and it would go stale the first time a schema changed in a pull request that
forgot to regenerate it.

## A broken link fails the pull request; a merge to main deploys

`pnpm docs:build` builds the site with VitePress's dead-link check enabled.
`ignoreDeadLinks` is never set. CI runs it on every pull request, alongside the
existing steps, so a renamed spec that breaks a link fails the PR that renamed
it, not the live site afterwards.

A separate workflow, `.github/workflows/docs.yml`, builds and deploys to GitHub
Pages on every push to `main`, using `actions/upload-pages-artifact` and
`actions/deploy-pages`. The site therefore always matches `main`, including
specs that are `specified` and not yet built. The status index on the specs
page, generated per `008-spec-metadata.md`, is what tells a reader which is
which.

Search is VitePress's built-in local search. The index ships with the site. No
search service receives the site's content or its readers' queries.

The site's own configuration is English (C9), like everything else committed.

## Verification

- `pnpm docs:build` runs on every pull request with dead-link checking on. It
  catches a relative link to a file that does not exist, including one broken
  by a rename.
- A test builds the site's page list from the same configuration VitePress uses
  and asserts it equals the allowlist above. In particular, nothing under
  `config/`, `test/`, `.claude/` or `.github/`, and not `CLAUDE.md`, is
  published. It also asserts the rewritten `README.md` and `specs/README.md`
  are the pages served at the site root and the specs index.
- A test asserts that `.vitepress/` contains no hand-written sidebar entries:
  the sidebar is the output of the derivation, not a literal.
- A test asserts that no OpenAPI document is tracked in git.

**What this does not catch.** The allowlist controls which files are served,
not what is in them. Tenant data that reaches an allowlisted file, such as a
real price pasted into a spec as an example, is published by the next merge to
`main`. That is no worse than the repository itself, which is already public,
but it is more readable and more likely to be indexed. Review and
`006-pull-requests.md` remain the only enforcement for the contents.

The dead-link check covers relative links only. An external URL that has gone
stale is not detected.

**One step is manual.** GitHub Pages must be set to deploy from "GitHub
Actions" in the repository settings, once. Until it is, `docs.yml` fails
visibly rather than publishing nothing silently.
