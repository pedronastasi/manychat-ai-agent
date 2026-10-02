---
name: implement-spec
description: Implement a `specified` spec from specs/ in its own git worktree under .claude/worktrees/, with tests citing each Verification item, the full CI chain run, and the spec's frontmatter flipped to `implemented`. Use when the user says "implement spec 024", "build 025", "pick up the next spec", "start a worktree for spec NNN", or hands over a spec number to turn into code.
---

# Implementing a spec in its own worktree

## When it applies

The spec exists and its frontmatter says `status: specified`. It describes
behaviour that `src/` does not have yet.

- No spec yet, or the brief is vague: write one first with `/spec`.
- Already `implemented`: stop and say so. A change to it is an ordinary branch.
- A decision the spec does not make comes up mid-implementation: ask the user,
  and record it with `/adr` if it is non-obvious. Do not settle it in code.

Several agents work on this repository at once, each in its own worktree. Never
implement in the shared checkout at the repository root.

## Steps

1. **Find the spec, and where it lives.**

   ```sh
   git fetch origin
   git ls-tree --name-only origin/main specs/ | grep '/NNN-'
   git branch -a --list '*spec-NNN*'; git worktree list | grep 'spec-NNN'
   ```

   - Not on `origin/main`: the spec is still on a docs branch (find it with
     `git log --all --oneline -- 'specs/NNN-*'`). Ask the user whether to wait for
     that merge or branch from the docs branch. Do not guess.
   - A branch or worktree for it already exists: another agent may own it. Ask
     whether to resume it. Never start a second one.

2. **Create the worktree**, named after the spec file's slug:

   ```sh
   git worktree add --no-track .claude/worktrees/feat-spec-NNN-slug \
     -b feat/spec-NNN-slug origin/main
   ```

   `--no-track` matters. Tracking `origin/main` turns a bare `git push` into a
   push to `main`. Run every later command from inside the worktree.

3. **Bootstrap, then prove the base is green** before touching anything:

   ```sh
   pnpm install --frozen-lockfile && pnpm bootstrap && pnpm test
   ```

   A failure here belongs to `main`, not to you. Report it, and do not fold a
   fix into this branch unless the user agrees.

4. **Read before planning:** the spec in full; every clause in its
   `constitution:` list (`specs/000-constitution.md`); every ADR in its `adr:`
   list; and any spec it says it amends. Then give the user a short plan: one
   line per `§ Verification` item naming the test file that will prove it, plus
   the `src/` files you expect to touch. Wait for a go-ahead if the plan
   contradicts anything already in `src/`.

5. **Implement, with tests first where you can.** Each `§ Verification` item
   gets a test whose `describe` cites it, the way
   `test/unit/sales-funnel.test.ts` does: `(specs/023 V1)` in the name, and
   a header comment naming `specs/NNN-slug.md § Verification`. Mock only the
   model and the ManyChat HTTP boundary (`specs/004`).

6. **Amend specs in the same branch** wherever the implementation and the spec
   disagree, and wherever this spec says another spec changes. A spec edited
   after merge is a stale spec for the time in between (C8).

7. **Flip the frontmatter** (`specs/008`):

   ```yaml
   status: implemented
   implemented: YYYY-MM-DD # `date +%F`; correct it to the merge date if they differ
   ```

   Leave `pr:` alone until the PR exists, then run `pnpm spec:index`.
   `implemented` needs at least one test citing the spec, and the suite fails
   without one.

8. **Run the CI chain in CI's order, and keep the numbers.** The PR quotes them.

   ```sh
   pnpm typecheck && pnpm lint && pnpm format:check && pnpm test:coverage \
     && pnpm eval:mock && pnpm build && pnpm docs:build
   ```

   Coverage thresholds are 85/75/85/85. If `eval:mock` fails, extend the mock
   model (`src/agent/mock-provider.ts`) so it models the correct behaviour. Do not weaken
   the case.

9. **Run the leak check, then commit.** See House rules. The subject is
   imperative and names the spec:

   ```
   feat: take a lead from first reply to the payment link (spec 023)
   ```

10. **Open the PR with `/open-pr`.** It also records the PR number in this
    spec's frontmatter.

## House rules

- **C1 and the trade-word rule.** Fixtures, eval cases, mock replies, comments
  and commit messages are invented, English and generic: "your courses", not
  the tenant's real line of business. The repo merges with merge commits, so a
  word in any branch commit reaches `main`'s history for good. Before every
  commit, pull distinctive words (business name, trade, product names, prices)
  from the real tenant's config. In a worktree, `config/` holds only the fictional
  examples `pnpm bootstrap` copied in, so read the main checkout's `config/` or
  wherever this machine keeps the live tenant's. If none is reachable, ask the
  user for the words. Then grep the diff for each one:

  ```sh
  git diff origin/main... | grep -niE 'word1|word2|word3'
  ```

  Never write those words into this skill, a test, or a commit to explain the
  check. That would be the leak.

- **C2:** only `src/agent/registry.ts` imports provider packages.
- **C3:** a new external boundary gets a Zod schema in `src/contracts/`, with the
  type inferred from it.
- **C6:** a new failure path escalates to a human and never invents a reply.
- **C9:** English everywhere, including test names and log lines.
- **ADR-0008:** port implementations are classes, and pure logic stays as
  functions.

## Worked example

`feat/spec-023-sales-funnel` (PR #132):
`git log --oneline --no-merges 69c8d27^1..69c8d27^2` shows the shape. One `feat:` commit implements the spec, amends 001 and 003, and
flips 023 to `implemented`. A second commit, `docs: record PR 132 in spec 023`,
adds `pr:` once the number exists.
