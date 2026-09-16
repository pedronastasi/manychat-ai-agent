# CLAUDE.md

## Project overview

Provider-agnostic conversational AI agent that answers customer questions on WhatsApp through ManyChat. Acts as a "front desk" for a training academy — answers grounded questions about courses and escalates everything else to a human. ManyChat terminates external requests after 10 seconds, so the system uses a hybrid race (`Promise.race`) between the model and an 8-second deadline; if the model loses the race, its reply completes into a Postgres outbox for deferred delivery.

## Quick start

```sh
pnpm install && pnpm bootstrap && pnpm dev
```

Runs with no API key and no database (mock model + embedded PGlite).

## Commands

| Command               | Purpose                                                |
| --------------------- | ------------------------------------------------------ |
| `pnpm dev`            | Local dev server (watch mode, `.env` loaded)           |
| `pnpm build`          | TypeScript compilation                                 |
| `pnpm typecheck`      | `tsc --noEmit`                                         |
| `pnpm lint`           | ESLint                                                 |
| `pnpm format`         | Prettier write                                         |
| `pnpm format:check`   | Prettier check                                         |
| `pnpm test`           | `vitest run`                                           |
| `pnpm test:coverage`  | Vitest with coverage thresholds enforced               |
| `pnpm test:watch`     | Vitest watch mode                                      |
| `pnpm eval:mock`      | Golden-set eval with mock model (free, deterministic)  |
| `pnpm eval`           | Golden-set eval with real model (costs money)          |
| `pnpm simulate "msg"` | Send a Dynamic Block request to a running local server |
| `pnpm db:generate`    | Drizzle migration generation                           |
| `pnpm db:migrate`     | Run Drizzle migrations                                 |
| `pnpm spec:index`     | Regenerate `specs/README.md` from spec frontmatter     |

`EVAL_DIR` selects the eval suite (default `evals/golden`) and `CONFIG_DIR` the
tenant it runs against — see `specs/009-tenant-eval-suites.md`.

## Tech stack

- **Runtime:** Node.js >= 22, TypeScript ~6.0 (strict, ESM, `verbatimModuleSyntax`)
- **Server:** Fastify 5 with Zod type provider
- **AI:** Vercel AI SDK (`generateObject`) with Anthropic/OpenAI/Google providers
- **Database:** PostgreSQL via `postgres` + Drizzle ORM; PGlite for dev/test
- **Validation:** Zod 4 (single source of truth for types, validation, and OpenAPI)
- **Testing:** Vitest 5, V8 coverage
- **Linting:** ESLint 10 (type-aware), Prettier (100 chars, single quotes)
- **Package manager:** pnpm

## Architecture

Ports-and-adapters (hexagonal). Key boundaries:

- **AgentRunner** (`src/agent/runner.ts`) — port for LLM calls. Impl: `GenerateObjectRunner`.
- **ChannelAdapter** (`src/channels/port.ts`) — port for chat platforms. Impl: `ManyChatAdapter`.
- **ManyChatClient** (`src/channels/manychat/client.ts`) — port for outbound delivery.
- **Registry** (`src/agent/registry.ts`) — the ONLY file that imports provider packages.
- **Contracts** (`src/contracts/`) — Zod schemas are the source of truth; types are inferred.
- **Outbox** (`src/outbox/`) — Postgres outbox with `FOR UPDATE SKIP LOCKED` for deferred delivery.

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
  observability/       # PII redaction
  outbox/              # Deferred reply queue + polling worker
  routes/              # Auth middleware, turn handler (the race)
test/
  unit/                # Pure logic tests
  integration/         # Tests hitting PGlite
  helpers/             # db.ts (PGlite factory), model.ts (mock model)
  fixtures/            # Tenant config fixtures
config/                # Tenant config (gitignored; *.example committed)
docs/adr/              # Architecture Decision Records (0001–0008)
specs/                 # Specification documents (000–008)
evals/golden/          # Golden eval cases (cases.jsonl)
```

## Testing conventions

- Mock only at two seams: the model and the ManyChat HTTP boundary.
- Database tests run against PGlite (real Postgres in WASM — no container needed).
- Tests cite the spec clause they enforce.
- A fake must honour the contract it stands in for.
- Mock the model at the provider boundary using the correct nested `usage` shape (see `test/helpers/model.ts`).
- Coverage thresholds: 85% statements, 75% branches, 85% functions, 85% lines.

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
2. **C2** — Provider isolation: only `registry.ts` imports provider packages.
3. **C3** — Schema validation on every external boundary (Zod).
4. **C4** — Input fencing: user text injected inside fences, never raw.
5. **C5** — PII redaction in logs.
6. **C6** — Fail closed: unknown errors escalate to human, never hallucinate.
7. **C7** — 10-second budget: race deadline + model abort.
8. **C8** — Tests cite the spec clause they enforce.
9. **C9** — English only in source, docs, and logs.

## CI

GitHub Actions (`ci.yml`): typecheck → lint → format:check → test:coverage → eval:mock → build, plus Gitleaks (secrets scan) and CodeQL.

## Environment

All env vars documented in `.env.example`. Key variables:

- `AGENT_MODEL` — `provider:model` format (default: `anthropic:claude-haiku-4-5`)
- `DATABASE_URL` — Postgres connection string or `pglite` for embedded
- `MANYCHAT_SHARED_SECRET` — min 16 chars, comma-separated for rotation
- `RACE_DEADLINE_MS` — race timeout (default: 8000)

Tenant config (`config/prompt.md`, `catalog.json`, `rules.json`) reloads on `SIGHUP` without restart.
