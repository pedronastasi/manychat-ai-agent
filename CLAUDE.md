# CLAUDE.md

## Project overview

Provider-agnostic conversational AI agent that answers customer questions on WhatsApp, Instagram and Messenger through ManyChat (one deployment, the channel named per request; specs/048). Acts as a "front desk" for a training academy — answers grounded questions about courses and escalates everything else to a human. ManyChat terminates external requests after 10 seconds, so the system uses a hybrid race (`Promise.race`) between the model and an 8-second deadline; if the model loses the race, its reply completes into a Postgres outbox for deferred delivery.

## Quick start

```sh
pnpm install && pnpm bootstrap && pnpm dev
```

Runs with no API key and no database (mock model + embedded PGlite).

## Commands

| Command                            | Purpose                                                    |
| ---------------------------------- | ---------------------------------------------------------- |
| `pnpm dev`                         | Local dev server (watch mode, `.env` loaded)               |
| `pnpm build`                       | TypeScript compilation                                     |
| `pnpm typecheck`                   | `tsc --noEmit`                                             |
| `pnpm lint`                        | ESLint                                                     |
| `pnpm format`                      | Prettier write                                             |
| `pnpm format:check`                | Prettier check                                             |
| `pnpm test`                        | `vitest run`                                               |
| `pnpm test:coverage`               | Vitest with coverage thresholds enforced                   |
| `pnpm test:watch`                  | Vitest watch mode                                          |
| `pnpm eval:mock`                   | Golden-set eval with mock model (free, deterministic)      |
| `pnpm eval:conversations`          | Scripted conversations, twice each, real model (specs/043) |
| `pnpm eval:conversations:validate` | Check the conversation suite without a model call          |
| `pnpm eval`                        | Golden-set eval with real model (costs money)              |
| `pnpm simulate "msg"`              | Send a Dynamic Block request to a running local server     |
| `pnpm db:generate`                 | Drizzle migration generation                               |
| `pnpm db:migrate`                  | Run Drizzle migrations                                     |
| `pnpm tokens:backfill`             | Issue contact tokens to existing contacts (`--check`)      |
| `pnpm insights:run`                | Run this week's learning job now (`--force` again)         |
| `pnpm insights:review`             | Approve, edit or reject proposed playbook tactics          |
| `pnpm insights:activate`           | Put a reviewed playbook version live, behind the eval gate |
| `pnpm insights:report`             | Conversion rate per playbook version                       |
| `pnpm spec:index`                  | Regenerate `specs/README.md` from spec frontmatter         |
| `pnpm demo:record`                 | Re-record the README demo against the fixture tenant       |
| `pnpm docs:build`                  | Build the docs site (specs/014); fails on dead links       |
| `pnpm docs:dev`                    | Docs site dev server                                       |

`EVAL_DIR` selects the eval suite (default `evals/golden`) and `CONFIG_DIR` the
tenant it runs against — see `specs/009-tenant-eval-suites.md`. `PLAYBOOK_VERSION`
runs it with a playbook version that is not live yet, which `insights:activate`
needs a real-model record of — see `specs/031-learning-from-outcomes.md`.
`EVAL_JUDGE_MODEL` names a judge that grades `review` criteria and the rubric,
only in the groups that pass calibration on that run — see
`specs/016-model-graded-evals.md`.

## Tech stack

- **Runtime:** Node.js >= 22, TypeScript ~6.0 (strict, ESM, `verbatimModuleSyntax`)
- **Server:** Fastify 5 with Zod type provider
- **AI:** LangChain.js + LangGraph.js for the turn (specs/050); Vercel AI SDK for transcription, the learning analyst, the eval judge and the mock, with Anthropic/OpenAI/Google providers
- **Database:** PostgreSQL via `postgres` + Drizzle ORM; PGlite for dev/test
- **Validation:** Zod 4 (single source of truth for types, validation, and OpenAPI)
- **Testing:** Vitest 5, V8 coverage
- **Linting:** ESLint 10 (type-aware), Prettier (100 chars, single quotes)
- **Package manager:** pnpm

## Architecture

Ports-and-adapters (hexagonal). Key boundaries:

- **AgentRunner** (`src/agent/runner.ts`) — port for LLM calls. Impl: `LangGraphRunner` (`src/agent/langgraph-runner.ts`, LangChain.js + LangGraph.js; specs/050). It extends `PromptedRunner`, which owns the prompt, tools and guardrails. The AI SDK runner was removed; `AGENT_RUNNER=ai-sdk` stops boot.
- **ChannelAdapter** (`src/channels/port.ts`) — port for chat platforms. Impl: `ManyChatAdapter`.
- **ManyChatClient** (`src/channels/manychat/client.ts`) — port for outbound delivery. Impl: `ManyChatHttpClient`, the ONLY file that imports `manychat-sdk`; one instance per process (specs/022).
- **ContactReader** (`src/channels/manychat/client.ts`) — port for `get_contact` (specs/024). `ManyChatHttpClient` implements it; `ContactReads` (`src/agent/contact.ts`) bounds it to two reads a turn, 1.5 s each.
- **FlowSends** (`src/agent/flows.ts`) — sends a flow when the model calls `send_flow` on an inbound turn, so the reply follows it (specs/029, ADR-0019), and keeps when the last one finishes playing, which the reply waits for (specs/030). Every other write is staged on `ActionStage` and performed after the reply (ADR-0010).
- **Registry** (`src/agent/registry.ts`) — the ONLY file that imports provider packages.
- **Contracts** (`src/contracts/`) — Zod schemas are the source of truth; types are inferred.
- **TurnHandler** (`src/turn/handler.ts`) — runs one turn (the race, ADR-0001) and delegates each job: `TurnOrder` (one turn at a time per contact, folding; specs/037, 046, 047), `TurnAdmission` (binding, the turn, the user message; specs/019), `Prechecks` (opening sentinel, guards; C6), `MediaReader` (specs/020), `TurnRecorder` (how the turn ended), `ReplyDelivery` (inline or outbox; specs/030, 037), `DeferredSettlement` (a lost race). `TurnScope` builds the collaborators that need the admitted turn, so `run()` only sequences (ADR-0023); every ending records and delivers through the same two (ADR-0024).
- **Outbox** (`src/outbox/`) — Postgres outbox with `FOR UPDATE SKIP LOCKED` for deferred delivery.
- **Nudges** (`src/nudge/`) — follow-ups the agent schedules, run by a worker at due time (specs/025). `NudgeChecks` decides whether a due nudge may still run; its turn records through `TurnRecorder` and queues through `ContactOutbox`, as an inbound turn does (ADR-0024).

Ports are implemented as classes; pure functions stay as functions (ADR-0008).

## Code layout

```
src/
  main.ts              # Process entrypoint
  server.ts            # Fastify composition root
  agent/               # LLM interaction: runner, prompt, guardrails, registry, mock
  channels/            # Channel adapters (ManyChat + local simulator)
  config/              # Env + tenant config loading (SIGHUP reload)
  contracts/           # Zod schemas (agent, config, manychat)
  conversation/        # Budget enforcement, conversation/turn persistence
  db/                  # DB client factory, migrations, Drizzle schema
  evals/               # Eval runner, judge (specs/016) and conversation harness (specs/043)
  learning/            # Learning from outcomes: weekly job, playbook, insights CLI (specs/031)
  media/               # Inbound voice notes, images, videos: resolver, ffmpeg splitter
  nudge/               # In-window follow-ups: store, performer, due-time worker (specs/025)
  observability/       # PII redaction
  outbox/              # Deferred reply queue + polling worker
  routes/              # Auth middleware
  turn/                # TurnHandler (the race) and the classes it delegates to
test/
  unit/                # Pure logic tests
  integration/         # Tests hitting PGlite
  helpers/             # db.ts (PGlite factory), model.ts (mock models), manychat.ts, ffmpeg.ts
  fixtures/            # Tenant config fixtures, invented media clips
config/                # Tenant config (gitignored; *.example committed)
.vitepress/            # Docs site config: allowlist, derived sidebar, link rewriting (specs/014)
docs/adr/              # Architecture Decision Records (0001–0027)
specs/                 # Specification documents (000–051)
evals/golden/          # Golden eval cases (cases.jsonl) and conversations (conversations.jsonl)
packages/create/       # create-manychat-ai-agent: scaffolds a tenant project (specs/035)
```

## Testing conventions

- Mock only at two seams: the model and the ManyChat HTTP boundary. The
  transcription model is a model; the media download is the ManyChat boundary.
  ffmpeg is run, never faked: its tests skip without it locally and fail under CI.
- Database tests run against PGlite (real Postgres in WASM — no container needed).
- Tests cite the spec clause they enforce.
- A fake must honour the contract it stands in for.
- Mock the model at the provider boundary using the correct nested `usage` shape (see `test/helpers/model.ts`).
- Coverage thresholds: 85% statements, 75% branches, 85% functions, 85% lines.
- **Fixtures are English and invented.** Every string a test or eval case
  contains — persona, catalog, schedule, FAQ, message text, price — is written
  in English and made up. Never paste a real deployment's copy into this
  repository, and never reach into a tenant's `config/` for a realistic value.
  This is C1 and C9 together, and test data is where both get broken, because a
  fixture copied from a live tenant is the quickest way to make one.
- **Prices in fixtures are invented too.** A price is tenant data. Pick figures
  that match no real deployment; if a test needs several tiers, invent the
  spread rather than reproducing one.

## Code style

- `.ts` extensions required in imports (`allowImportingTsExtensions`).
- `import type` enforced for type-only imports.
- `no-console` is an error — use the redacting logger.
- Conventional commit prefixes: `feat:`, `test:`, `refactor:`, `docs:`, `chore:`, `ci:`.
- PRs must open with `## Why` (not Summary/Changes).
- English throughout (Constitution C9).

## Constitution (specs/000)

Nine non-negotiable clauses:

1. **C1** — No tenant data in VCS (config/ gitignored, examples committed).
   Covers tests, fixtures, eval cases, comments and PR descriptions, not just
   `config/`: a real business name, person, price, schedule or URL must not
   reach this repository through any of them.
2. **C2** — Provider isolation: only `registry.ts` imports provider packages.
3. **C3** — Schema validation on every external boundary (Zod).
4. **C4** — Input fencing: user text injected inside fences, never raw.
5. **C5** — PII redaction in logs.
6. **C6** — Fail closed: unknown errors escalate to human, never hallucinate.
7. **C7** — 10-second budget: race deadline + model abort.
8. **C8** — Tests cite the spec clause they enforce.
9. **C9** — English only in source, docs, and logs. Test fixtures, eval cases
   and PR descriptions included. A tenant's own `config/` is the one carve-out
   (specs/005), and it lives outside this repository.

## CI

GitHub Actions (`ci.yml`): `verify` runs typecheck → lint → format:check → test:coverage → eval:mock → conversation suite validation → build; `docs` runs the Renovate config validator and docs:build beside it; plus Gitleaks (secrets scan) and CodeQL. `docs.yml` deploys the docs site to GitHub Pages on every push to `main`.

## Environment

All env vars documented in `.env.example`. Key variables:

- `AGENT_MODEL` — `provider:model` format (default: `anthropic:claude-haiku-4-5`)
- `DATABASE_URL` — Postgres connection string or `pglite` for embedded
- `MANYCHAT_SHARED_SECRET` — min 16 chars, comma-separated for rotation
- `RACE_DEADLINE_MS` — race timeout (default: 8000)
- `CONTACT_TOKENS_ENFORCED` — `false` only during the specs/019 rollout (default: `true`)
- `TRANSCRIPTION_MODEL` — `provider:model` for voice notes and video soundtracks
  (specs/020); unset sends them to `rules.messages.mediaFallback`

Tenant config (`config/prompt.md`, `catalog.json`, `rules.json`, optional `tools.json`) reloads on `SIGHUP` without restart.
