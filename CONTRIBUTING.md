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

The PR template opens with `## Why`. Write that part first: the problem or the
decision, not a summary of the diff. See
[`specs/006-pull-requests.md`](specs/006-pull-requests.md).

## How this project is organized

Behavior is specified in [`specs/`](specs/) before it is implemented, and
decisions are recorded in [`docs/adr/`](docs/adr/).

[`specs/README.md`](specs/README.md) is the index: which specs describe code that
exists, and which describe code that does not. It is generated - run
`pnpm spec:index` after changing any spec's frontmatter, or CI will fail.

- [`specs/000-constitution.md`](specs/000-constitution.md) holds non-negotiables.
  A change there needs an ADR that supersedes the clause.
- [`specs/008-spec-metadata.md`](specs/008-spec-metadata.md) defines that
  frontmatter. `status: implemented` is only permitted where a test cites the
  spec, so the index cannot quietly claim more than the suite proves.
- [`specs/004-testing.md`](specs/004-testing.md) defines what must be tested,
  what deliberately is not, and the rules a test here follows.
- [`specs/005-language.md`](specs/005-language.md) requires English throughout,
  and that no customer-facing copy lives in source at all - it belongs to the
  tenant, in configuration.
- [`specs/006-pull-requests.md`](specs/006-pull-requests.md) defines what a pull
  request must say. The first heading is always `## Why` - the diff already says
  what changed.
- Tests cite the spec clause they enforce. If a spec change breaks a test, that
  is a real finding — not a test to update mechanically.
- New non-obvious decisions get an ADR. "Why not Redis" is more useful to the
  next reader than the code that avoided it.

## Repository skills

[`.claude/skills/`](.claude/skills/) holds instructions for the workflows this
repo has conventions about, so they do not depend on remembering them.

| Skill       | Use it to                                                |
| ----------- | -------------------------------------------------------- |
| `adr`       | Pressure-test a decision, then record it in `docs/adr/`. |
| `spec`      | Settle what a spec must say, then write it in `specs/`.  |
| `new-skill` | Add another one of these.                                |

They are committed on purpose - a skill encoding this repo's format is repo
tooling. Anything that would work unchanged in an unrelated project is a
personal skill and does not belong here.

`adr` and `spec` both open by asking questions, and will stop rather than write
if the answers are not there - an ADR whose rejected alternative nobody can
argue, or a spec claiming behaviour no test covers, is worse than the missing
document, because both read as authoritative.

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

**Local models run via Ollama.** `docker compose --profile local-model up` starts
the container; set `AGENT_MODEL=ollama:llama3.1:8b`. Ollama models price at zero
so the budget cap does not fire on free turns. The token cap still applies.

**Mock at the provider boundary carefully.** `doGenerate` returns the nested
provider-facing usage shape (`{ total, noCache, cacheRead, cacheWrite }`), which
the SDK flattens for callers. Using the flattened shape in a mock silently yields
undefined token counts and makes the budget cap a no-op. Use the helpers in
`test/helpers/model.ts`.

## Adding a channel

Implement `ChannelAdapter` in `src/channels/<name>/`, add a capability row, and
write the renderer tests first — the capability profile is the specification.
