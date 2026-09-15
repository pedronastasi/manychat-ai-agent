## Why

<!--
The problem, the constraint, or the decision - not a summary of the diff.

A reader who thinks this change is wrong should be able to point at the sentence
they disagree with. If no such sentence exists, this is a summary wearing the
heading. Say what was rejected and why, if anything was.

specs/006-pull-requests.md
-->

## What changed

<!-- Short. The diff has the detail; this orients the reader inside it. -->

## Verification

<!--
What you actually ran and what it returned. Numbers, not adjectives.
Cite the spec clause a behavioural change satisfies (Constitution C8).
-->

| Check                                              | Result |
| -------------------------------------------------- | ------ |
| `pnpm test`                                        |        |
| `pnpm eval:mock`                                   |        |
| `pnpm typecheck && pnpm lint && pnpm format:check` |        |

## Risk

<!--
What could break, and what happens if it does. "Nothing" is an answer if it is
true. Delete this section when no behaviour changed.
-->

## Follow-ups

<!--
Deliberately deferred work, so it reads as a decision rather than an oversight.
Delete this section if there is none.
-->

---

<!--
Two checks a job cannot do for you. Everything CI can verify - types, lint,
format, tests, coverage, evals, secrets, CodeQL - is verified by CI and is
deliberately not a checkbox here.
-->

- [ ] **No tenant data.** No real transcripts, prices, names, phone numbers,
      screenshots or `.env` values in this description or the diff (C1, C5). A
      secret scanner catches credentials; it does not catch a customer's message
      pasted as an example.
- [ ] **Specs updated**, if behaviour changed - or this PR says why they were not
      (C8).
