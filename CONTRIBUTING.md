# Contributing

```bash
pnpm install && pnpm bootstrap && pnpm dev
```

Runs offline by default — a mock model and an embedded Postgres, so no API key or
database is needed to work on it.

## Before opening a PR

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm eval:mock
```

CI runs exactly these, plus a build, secret scanning and CodeQL.

## How this project is organized

Behavior is specified in [`specs/`](specs/) before it is implemented, and
decisions are recorded in [`docs/adr/`](docs/adr/).

- [`specs/000-constitution.md`](specs/000-constitution.md) holds non-negotiables.
  A change there needs an ADR that supersedes the clause.
- Tests cite the spec clause they enforce. If a spec change breaks a test, that
  is a real finding — not a test to update mechanically.
- New non-obvious decisions get an ADR. "Why not Redis" is more useful to the
  next reader than the code that avoided it.

## Things worth knowing

**Zod schemas are the source of truth.** Types are inferred and the OpenAPI
document is generated from them. Do not hand-write a parallel interface.

**Only `src/agent/registry.ts` may import a provider package.** Everything else
depends on the `AgentRunner` port. This is what keeps the model swappable.

**Channel differences are data.** Add a row to `CHANNEL_CAPABILITIES`, do not add
a branch to the renderer.

**Timeouts have an ordering invariant.** `MODEL_ABORT_MS` must exceed
`RACE_DEADLINE_MS`; losing the race must not cancel the model call, or the
deferred path can never run. `EnvSchema` enforces this and a regression test
covers it.

**Mock at the provider boundary carefully.** `doGenerate` returns the nested
provider-facing usage shape (`{ total, noCache, cacheRead, cacheWrite }`), which
the SDK flattens for callers. Using the flattened shape in a mock silently yields
undefined token counts and makes the budget cap a no-op. Use the helpers in
`test/helpers/model.ts`.

## Adding a channel

Implement `ChannelAdapter` in `src/channels/<name>/`, add a capability row, and
write the renderer tests first — the capability profile is the specification.
