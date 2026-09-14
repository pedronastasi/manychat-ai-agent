# 004 — Testing

Defines what must be tested, what deliberately must not be, and what a test in
this repository is expected to look like.

## Position on "test every file"

Blanket per-file coverage is not the goal, and chasing it produces tests that
assert a function was called rather than that behaviour is correct. Three files
in this repository would gain nothing from unit tests and are excluded below,
with reasons.

What replaces "every file" is a **risk tier**: the closer code sits to money,
customer-visible output, or message delivery, the higher the bar.

## Current state (measured 2026-09-15, after closing P0-P3)

Overall: **95.75% statements, 86.34% branches**, 141 tests. The gate below is
live in CI.

Before this work the figure was 61.18% / 51.24% across 61 tests, with the outbox
worker at 0%.

| Area                                                     | Stmts             | Assessment                                 |
| -------------------------------------------------------- | ----------------- | ------------------------------------------ |
| `contracts/*`, `channels/port.ts`, `routes/auth.ts`      | 100%              | Done                                       |
| `conversation/budget.ts`                                 | 100%              | Done                                       |
| `channels/manychat/adapter.ts`                           | 92.3%             | Good                                       |
| `agent/registry.ts`                                      | 93.3%             | Good                                       |
| `routes/turn.ts`                                         | 91.1%             | Good; branch coverage 70% is the gap       |
| `conversation/store.ts`                                  | 90.9%             | Good                                       |
| `channels/manychat/client.ts`                            | 90.3%             | Good                                       |
| `agent/guardrails.ts`                                    | 88.1%             | Acceptable                                 |
| `agent/runner.ts`                                        | 86.7%             | Acceptable; branch 68.8% is the gap        |
| `agent/prompt.ts`                                        | 100% / 60% branch | Branches untested                          |
| `config/loader.ts`                                       | 65.6%             | **Gap — error paths untested**             |
| `outbox/queue.ts`                                        | 47.1%             | **Gap — backoff and dead-letter untested** |
| `server.ts`                                              | 46.9%             | Partial; covered indirectly                |
| `outbox/worker.ts`                                       | **0%**            | **Highest risk in the codebase**           |
| `db/migrate.ts`                                          | **0%**            | Gap                                        |
| `db/client.ts`, `simulator.ts`, `agent/mock-provider.ts` | 0%                | Excluded, see below                        |

## Priorities, by consequence rather than by percentage

### P0 — `outbox/worker.ts` and the rest of `outbox/queue.ts`

This is the code that decides whether a customer who was told "dame un segundo"
ever receives an answer. It is currently at 0% and 47%, and it contains the
retry, backoff and dead-letter logic — the parts most likely to be wrong and
least likely to be noticed when they are.

Required cases:

- A successful delivery marks the row `delivered` and sets `delivered_at`.
- A retryable failure (429, 5xx, network) reschedules with backoff and leaves the
  row claimable; `next_attempt_at` actually moves forward.
- A **non**-retryable failure (4xx other than 429) dead-letters on the first
  attempt rather than burning five.
- Attempts are exhausted at `MAX_ATTEMPTS` and the row lands in `failed`.
- Two concurrent workers never deliver the same row twice (`SKIP LOCKED`).
- A database error inside the loop does not kill the worker.
- `startWorker`'s stop function finishes the in-flight batch rather than
  abandoning it.

### P1 — `config/loader.ts` error paths

Invalid configuration must fail at boot, and a failed **reload** must keep the
previous config so a typo cannot take down a running bot (specs/003). Neither
behaviour is currently tested. Required: missing file, malformed JSON, schema
violation, and a failed reload leaving the prior config serving.

### P2 — branch coverage on `runner.ts`, `turn.ts`, `prompt.ts`

Statement coverage is already high; the untested branches are the interesting
ones — abort versus error in the runner's catch, the deferred-path enqueue
failure in `turn.ts`, and the optional-field branches in catalogue rendering.

### P3 — `db/migrate.ts`

Applies migrations idempotently and records them. Worth one test that running it
twice is a no-op, and one that a failure does not record the migration as
applied.

## Deliberately not unit tested

| File                             | Why                                                                                                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent/mock-provider.ts`         | It **is** test infrastructure. Its correctness is asserted every time the eval suite runs green; a unit test of a fixture tests nothing real.                                                                |
| `channels/manychat/simulator.ts` | A developer CLI with no production path. It is exercised manually and would need its own process harness to test, for no safety gained.                                                                      |
| `db/client.ts`                   | A four-line driver constructor. A test would assert that `postgres()` was called with the string we passed it — a change-detector, not a safety net. The embedded path is covered wherever tests run at all. |
| `db/schema.ts`                   | Declarative table definitions. It is verified far more strongly by the generated migration applying cleanly in every integration test than by any assertion about column objects.                            |
| `channels/port.ts`               | Types only; nothing exists at runtime.                                                                                                                                                                       |

If one of these gains real logic, it leaves this list.

## What a test here looks like

**Cite the spec clause.** A test enforcing a rule from `specs/` names it. If a
spec changes and a test breaks, that is a finding to think about, not a test to
mechanically update (Constitution C8).

**Do not mock what can be run for real.** Database behaviour is tested against
PGlite — real Postgres, in process. Mocking a database means asserting our
assumptions about it, and `FOR UPDATE SKIP LOCKED` is exactly the kind of
assumption that is wrong.

**Mock only at the two seams**: the model (`test/helpers/model.ts`) and the
ManyChat HTTP boundary (inject `fetchImpl`). Nothing else.

**Mock the model at the provider boundary, carefully.** `doGenerate` returns the
nested provider-facing usage shape (`{ total, noCache, cacheRead, cacheWrite }`),
which the SDK flattens for callers. Using the flattened shape silently yields
undefined token counts and makes the budget cap a no-op. Always use the helpers.

**A fake must honour the contract it stands in for.** The deferred-path test once
passed while the feature was broken, because its fake slow runner ignored the
abort signal. A fake that is more permissive than the real thing tests nothing.
This is the single most important rule in this document.

**Assert behaviour, not implementation.** Prefer asserting the rendered ManyChat
body over asserting which internal function ran.

## Definition of done

A change is adequately tested when:

1. Every branch of new conditional logic is reached by a test.
2. Each failure mode has a test asserting it degrades the way the spec says —
   for this codebase, almost always "escalates to a human" rather than "throws".
3. Anything touching money, delivery, or customer-visible text has a test that
   would fail if the behaviour silently regressed.
4. New guardrail or escalation behaviour adds a case to `evals/golden/cases.jsonl`.

## CI gate

`vitest.config.ts` enforces global thresholds, run in CI as `pnpm test:coverage`:

```ts
coverage: {
  provider: 'v8',
  include: ['src/**/*.ts'],
  exclude: [
    'src/agent/mock-provider.ts',
    'src/channels/manychat/simulator.ts',
    'src/db/client.ts',
    'src/db/schema.ts',
    'src/channels/port.ts',
    'src/main.ts',
  ],
  thresholds: { statements: 85, branches: 75, functions: 85, lines: 85 },
}
```

Thresholds ratchet upward and never down. They are a floor that catches
regressions, **not a target to be reached by writing assertions that do not
check anything** — a file can reach 100% while testing nothing, and reviewers
should say so when they see it.

Note that the text reporter hides fully-covered files, so a file absent from the
table is at 100%, not missing.
