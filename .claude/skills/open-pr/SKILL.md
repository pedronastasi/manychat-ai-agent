---
name: open-pr
description: Open a pull request whose body follows .github/pull_request_template.md and specs/006: `## Why` first, a Verification table with real numbers and spec citations, the two human checkboxes answered honestly, and a leak check before anything is sent to GitHub. Use when the user says "open a PR", "create the PR", "raise a pull request", "write the PR description", "ship this branch", or when /implement-spec reaches its last step.
---

# Opening a pull request

## When it applies

The branch has commits that are not on `origin/main` and should go up for
review. To update the body of a PR that already exists, use the same steps,
then `gh pr edit N --body-file` in place of `gh pr create`.

Not for: a branch with nothing committed (commit first), or the shared checkout
on `main` (branch first, ideally in a worktree under `.claude/worktrees/`).

## Steps

1. **See what is actually on the branch:**

   ```sh
   git fetch origin
   git log --oneline --no-merges origin/main..HEAD
   git diff --stat origin/main...HEAD
   gh pr list --head "$(git branch --show-current)"
   ```

   If a PR already exists for the branch, edit it instead of opening a second one.

2. **Run the leak check on the diff** before writing a word of the body. C1
   is enforced by `.gitignore` for files and by nothing for text (`specs/006`).
   - Tenant words: take distinctive words (business name, trade, product names,
     prices, people) from the real tenant's config. In a worktree, `config/` holds only the fictional
     examples `pnpm bootstrap` copied in, so read the main checkout's `config/` or
     wherever this machine keeps the live tenant's. If none is reachable, ask the
     user for the words. Then run
     `git diff origin/main...HEAD | grep -niE 'word1|word2'`. The repository
     merges with merge commits, so a hit in any commit, not only the final
     diff, reaches `main`. Check `git log -p origin/main..HEAD` too.
   - Non-English (C9): `git diff origin/main...HEAD | grep -nP '^\+.*[\x{A1}\x{BF}\x{C0}-\x{FF}]'`.

   On a hit, stop and tell the user. Fixing it may need a history rewrite,
   and that is the user's call.

3. **Get the Verification numbers.** Reuse numbers from this session if no
   commit landed after they were taken. Otherwise run:

   ```sh
   pnpm test:coverage && pnpm eval:mock && pnpm typecheck && pnpm lint && pnpm format:check
   ```

   Add `pnpm build && pnpm docs:build` when `src/`, `specs/`, `docs/` or
   `.vitepress/` changed. Record counts ("761 passed, 17 skipped; 92.96%
   statements"), not "green". A check you did not run goes in the table as
   **not run**, with the reason. Never leave a cell blank, and never fill one
   in from memory.

4. **Draft the body** from `.github/pull_request_template.md`, reading it fresh
   each time rather than from memory. Write it to the scratchpad, not the repo.
   - Delete every `<!-- -->` prompt. They are instructions to the author.
   - `## Why` comes first: the problem, the constraint or the decision, and
     what was rejected. Test it: someone who thinks the change is wrong can
     point at the sentence they disagree with. Restating the diff fails that
     test.
   - `## What changed`: short bullets that orient a reader in the diff.
   - `## Verification`: the template's table with real results. For a
     behavioural change, list the spec's `§ Verification` items and the test
     that proves each one (C8).
   - `## Risk`: what breaks, and what happens if it does. Delete the section
     when no behaviour changed. `n/a` is noise.
   - `## Follow-ups`: deferred work. Delete it if there is none.
   - Checkboxes: tick one only when it is true, and say why on the same line
     ("every price in the diff belongs to the fictional demo tenant"). An
     unticked box with an explanation beats a false tick.
   - End with the attribution line from the session's instructions.

5. **Title** = the commit subject: a conventional prefix (`feat:`, `fix:`,
   `test:`, `refactor:`, `docs:`, `chore:`, `ci:`) and an imperative sentence. On
   a branch with several commits, use the subject of the commit that carries
   the change.

6. **Show the title and body to the user and wait.** A PR is public the
   moment it is created. Then:

   ```sh
   git push -u origin HEAD
   gh pr create --base main --title "<title>" --body-file <scratchpad>/pr-body.md
   ```

7. **If the branch implements a spec**, record the number in that spec
   (`specs/008`). Add `pr: N` to its frontmatter, run `pnpm spec:index`, and
   commit `docs: record PR N in spec NNN`, then push.

## House rules

- No real transcripts, screenshots, prices, names, phone numbers or `.env`
  values in the body (C1, C5). The body is the one surface `.gitignore` cannot
  protect. If a bug needs an example, invent one.
- English only (C9).
- No checklist of things CI already runs (`specs/006` § What the template
  deliberately does not contain). Do not add a "Test plan" list of boxes.

## Worked example

`gh pr view 132` is the standard. Its Why argues a position and names two
rejected alternatives. Its table holds counts and marks the real-model eval
**not run**, with the reason. Each checkbox is ticked with a justification.

`gh pr view 135` shows what not to do: `## What` and `## Test plan` in place
of the template's sections, and a Why that restates the diff.
