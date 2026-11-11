---
status: specified
constitution: [C1, C2, C3, C4, C5, C6, C7, C8, C9]
adr: [0025, 0001, 0004, 0008, 0010, 0012, 0013, 0014, 0016, 0017, 0019, 0027, 0028, 0030]
---

# 026 — Python Port Parity

Defines what the Python implementation of ADR-0025 must preserve to be the same
agent as the TypeScript one: the framework defaults it overrides, how modules
map, the bounded loop as a LangGraph graph, what the two keep identical so a
tenant can switch, which specs the first Python release covers, and the gate
each Python release passes. It leaves out new features (retrieval,
multi-agent), the docs site port, and the Python repository's own CI beyond
that gate. There is no cutover: the two run separately, each on its own
database, for as long as both have users.

The Python implementation lives in `pedronastasi/manychat-ai-agent-python`. It
publishes the PyPI package `manychat-ai-agent` (imported as
`manychat_ai_agent`) and the image `ghcr.io/pedronastasi/manychat-ai-agent-python`.

## The port preserves behaviour, not framework defaults

The reflexive port is "we are moving to LangChain, so use LangChain the way
LangChain wants to be used": `create_agent` with tools that do their work, a
`ToolNode`, a checkpointer for memory, LangSmith for observability, and each
provider client as it comes out of the box. Every one of those is idiomatic,
and every one changes behaviour that a spec here fixes and a test asserts. The
result would pass a review of the Python and fail a reading of `012`.

`022` met the same move with the ManyChat SDK and answered it with a rule. This
spec applies that rule to the whole port:

> **The Python implementation changes no behaviour a spec in this repository
> fixes.** Every framework option that behaviour depends on is set explicitly,
> and a default is kept only where no spec is touched by it.

The TypeScript service met the same defaults first. It runs on LangChain.js
and LangGraph.js (`050`, ADR-0027) and depends on no other model library
(`053`, ADR-0030), so every pin below already has a tested TypeScript setting.
The Python pin takes its value from that setting and cites the `050` row it
comes from; it does not re-derive the value from the Python package's own
default.

The parity target is a TypeScript release: the specs marked `implemented` at
the tag a Python release names. Each Python release states the TypeScript
version it matches and the specs it claims at that tag (§ The first release is
the core front desk). A spec lands here first, in `specs/`, and stays the one
description of the behaviour for both (ADR-0025).

## Defaults that change behaviour are pinned, and each pin has a test

Versions read from PyPI on 2026-11-11: `langchain` 1.5.0, `langchain-core`
1.8.0, `langgraph` 1.2.20, `langgraph-prebuilt` 1.1.1, `langchain-anthropic`
1.7.10, `langchain-openai` 1.7.4, `langchain-google-genai` 4.4.3, `langsmith`
0.14.17, `anthropic` 2.8.0, `openai` 3.49.0, `pydantic` 2.14.3, `fastapi`
0.162.4, `uvicorn` 0.54.0, `httpx` 0.28.1, `coverage` 7.17.2. The rows marked
"read 2026-11-11" were read from those wheels; the rest were read on
2026-10-02 from the versions then current and not re-read. The TypeScript side
is agent 0.36.0.

| Default or idiom, as read                                                                                                                                                                                                                 | Breaks                                                                                                   | Required                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_agent` and `ToolNode` run a tool's function when the model calls it                                                                                                                                                               | ADR-0010, C6, `012 § A tool stages an action; the server performs it`                                    | No prebuilt agent and no `ToolNode`, as `050` (ADR-0027). The graph's own tools node stages writes and performs reads (§ The bounded loop)                                                   |
| `ToolNode` runs one step's tool calls concurrently: `executor.map` sync, `asyncio.gather` async (read 2026-11-11)                                                                                                                         | `012`: actions are staged in order, and the ninth is the one dropped                                     | Tool calls are handled one at a time, in the order of `tool_calls` on the model's message                                                                                                    |
| `recursion_limit` is 10007 in `langgraph` (`LANGGRAPH_DEFAULT_RECURSION_LIMIT`), 25 in `langchain-core`'s own config; it counts supersteps, not model steps (read 2026-11-11)                                                             | `012 § The loop is bounded at four steps`, ADR-0016                                                      | The step counter in graph state is the cap. `recursion_limit` is set on every invocation to `RECURSION_LIMIT` as `langgraph-runner.ts` computes it from `MAX_STEPS`; hitting it fails closed |
| `ChatAnthropic.max_retries` is 2; `ChatOpenAI.max_retries` is `None`, leaving the `openai` client's 2; `ChatGoogleGenerativeAI.max_retries` is 6, passed as total attempts (read 2026-11-11)                                              | `050`: `maxRetries: 2` on every chat model the registry builds (`CHAT_MODEL_MAX_RETRIES`)                | Three attempts in all on every provider: 2, 2 and 3 as each wrapper counts them. Every retry runs inside the abort below                                                                     |
| A rate-limited request waits out `Retry-After` inside the provider client                                                                                                                                                                 | C7: `050` found the JavaScript Anthropic wrapper's wait did not listen to the abort                      | The turn is cancelled at the abort whatever it is waiting on. A test answers 429 with `Retry-After: 30` and asserts the turn settles at `MODEL_ABORT_MS`                                     |
| The `anthropic` and `openai` clients time out a read after 600 s; `ChatAnthropic` and `ChatGoogleGenerativeAI` pass a timeout of `None` (read 2026-11-11)                                                                                 | C7, `002 § Latency budget`: the abort fires at 30 000 ms                                                 | The whole turn, graph and media included, runs under one `asyncio.timeout` of `MODEL_ABORT_MS`. Async calls only: a sync `invoke` in a thread cannot be cancelled                            |
| Cancelling the awaiting task is assumed to cancel the HTTP request                                                                                                                                                                        | ADR-0001: an aborted call stops. `050` found the JavaScript Gemini wrapper abandoned its request instead | Asserted per provider, not assumed: a test aborts mid-request and checks the HTTP request was closed                                                                                         |
| `asyncio.wait_for` cancels the awaited task when it times out; the event loop keeps only a weak reference to a task from `create_task`                                                                                                    | ADR-0001: the losing call is not abandoned                                                               | The race uses `asyncio.wait` with a timeout, never `wait_for`, and the turn handler holds a strong reference to the task until it settles                                                    |
| LangSmith tracing is off until `LANGSMITH_TRACING`, `LANGCHAIN_TRACING_V2` or a sibling is `"true"`, and then sends every run's inputs and outputs                                                                                        | C5; C1's tenant prompt and catalog would reach a vendor                                                  | Boot refuses to start while any of those variables is `"true"`, as `050`. A turn is traced only as `052`'s projection, behind `TRACE_TURNS`, with `052`'s settings set in code               |
| `set_verbose` and `set_debug` in `langchain-core` are off by default, and when on they attach handlers that print each run to stdout, past the logger                                                                                     | C5                                                                                                       | Never called. A test asserts both read false after boot                                                                                                                                      |
| `init_chat_model` infers a provider from a bare model name (`gemini…` becomes `google_vertexai`); the Gemini API's provider name is `google_genai`, not `google`; with no model, `configurable_fields` lets runtime config pick the model | C2's `provider:model` string; C4: no inbound field alters model selection                                | Never used, as `050 § The registry builds each chat model by its class`. The registry splits `provider:model` itself and builds each model by its class                                      |
| Anthropic's maximum output tokens default per model                                                                                                                                                                                       | `050`: `maxTokens` from `maxOutputTokens`                                                                | `max_tokens` set from the runner's `maxOutputTokens` on every provider                                                                                                                       |
| Prompt caching is opt-in per content block (`cache_control`)                                                                                                                                                                              | Cost parity; the budget counts cache reads (`050 § Usage, cost and caching come out the same`)           | The system message's last block carries `cache_control: {"type": "ephemeral"}` on Anthropic. A test reads the request body                                                                   |
| A LangGraph checkpointer is the idiomatic memory, and `PostgresSaver` creates its own tables                                                                                                                                              | `018`, `019`: history is the last ten bound turns in `turns`; the schema rule below                      | No checkpointer. History is read from `turns` exactly as `store.ts` reads it                                                                                                                 |
| Pydantic models ignore unknown keys (`extra='ignore'`, read 2026-11-11)                                                                                                                                                                   | The `.strict()` inbound schemas of `002 § Inbound payload`                                               | `extra='forbid'` on every inbound model and on the model-output model                                                                                                                        |
| FastAPI answers a validation failure with 422 and `exc.errors()`, which carries each rejected `input`                                                                                                                                     | `017`: "a 400 for an invalid body"; C5                                                                   | A handler answers 400 and echoes no input value                                                                                                                                              |
| Starlette answers an unhandled exception with a 500                                                                                                                                                                                       | `017 § An error on the message route is a handoff, not a 500`                                            | The same handoff as `server.ts`, with the same body for every other route                                                                                                                    |
| `uvicorn` believes `X-Forwarded-For` from `127.0.0.1,::1` (or `FORWARDED_ALLOW_IPS`) with `proxy_headers` on                                                                                                                              | `017`: an empty `TRUST_PROXY` trusts no proxy                                                            | `forwarded_allow_ips` comes from `TRUST_PROXY`, and proxy headers are off when it is empty                                                                                                   |
| `httpx` times out every request after 5 s (read 2026-11-11)                                                                                                                                                                               | `022 § Every call is abandoned after 10 seconds, and a timed-out send is retried`                        | Every ManyChat call has a 10 s timeout; a `get_contact` read has `READ_TIMEOUT_MS` (1500 ms, `024`)                                                                                          |
| `httpx` logs every request at `INFO`, full URL included, on the `httpx` logger                                                                                                                                                            | `020 § The URL never reaches storage or logs`, C5                                                        | Redaction is attached at the root of logging, so `httpx`, `uvicorn` and LangChain records pass through it like the service's own                                                             |

Anything this table could not read is pinned without a default to compare it
with: every option of an Ollama chat model (`007` is not implemented). A
default observed here is a fact about one version. Renovate (`011`) can change
it, which is why each pin is a test that reads the configured value, not a
comment saying what it was.

## The module mapping is mechanical, not a redesign

Each TypeScript module has one Python counterpart, with the same name in
`snake_case` and the same constants under the same names, so a reviewer can
read the two side by side. Paths on the right are relative to the Python
package root. Only the modules the first release needs are listed; a later
release adds its rows here when it claims the spec they implement.

| TypeScript                                                 | Python                                             | What must stay identical                                                                                 |
| ---------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `src/main.ts`                                              | `main.py`                                          | Boot order, `SIGHUP` reload, `SIGTERM` drain                                                             |
| `src/server.ts`                                            | `app.py`                                           | Hooks in the same order: rate limit, auth, then the body (`017`)                                         |
| `src/agent/registry.ts`                                    | `agent/registry.py`                                | The only provider import (C2); `PRICING`, `supportsTemperature`, `acceptsImages`                         |
| `src/agent/runner.ts`, `src/agent/langgraph-runner.ts`     | `agent/runner.py`, `agent/graph_runner.py`         | `AgentRunner` port, `AgentResult` fields, the fail-closed `modelError`, `RECURSION_LIMIT`                |
| `src/agent/model-schema.ts`, `src/agent/structured.ts`     | `agent/model_schema.py`, `agent/structured.py`     | The JSON schema bytes the model is shown, and the tool-error texts (`053`)                               |
| `src/agent/tools.ts`, `src/agent/tools/*`                  | `agent/tools.py`, `agent/tools/*`                  | `MAX_STEPS`, `MAX_ACTIONS_PER_TURN`, `ActionStage`, tool names and descriptions                          |
| `src/agent/contact.ts`                                     | `agent/contact.py`                                 | `MAX_READS_PER_TURN`, `READ_TIMEOUT_MS`, the `{ available: false }` answer (`024`)                       |
| `src/agent/flows.ts`                                       | `agent/flows.py`                                   | One send per flow per turn, and the wait for the last flow to finish playing (`029`, `030`)              |
| `src/agent/prompt.ts`, `src/agent/fence.ts`                | `agent/prompt.py`, `agent/fence.py`                | Every string, byte for byte, including the fence and the staged notice                                   |
| `src/agent/guardrails.ts`                                  | `agent/guardrails.py`                              | Pure functions, the same interventions under the same names                                              |
| `src/agent/transcriber.ts`                                 | `agent/transcriber.py`                             | The `Transcriber` port, on the `openai` client for `openai:` and `ollama:`; `google:` fails boot (`053`) |
| `src/agent/mock-provider.ts`, `src/agent/model-request.ts` | `agent/mock_provider.py`, `agent/model_request.py` | The same canned replies for `mock:`, so `eval:mock` outcomes can be compared                             |
| `src/channels/port.ts`, `src/channels/manychat/*`          | `channels/port.py`, `channels/manychat/*`          | Wire shapes per channel (`048`, `049`), the token bucket, the media URL match                            |
| `src/config/*`                                             | `config/*`                                         | A failed reload keeps the previous config (`003`)                                                        |
| `src/contracts/*`                                          | `contracts/*`                                      | Field names, limits and enum values, as Pydantic models                                                  |
| `src/conversation/*`                                       | `conversation/*`                                   | The SQL each query issues, and the token format and hash (`019`)                                         |
| `src/db/*`                                                 | `db/*`, Alembic `migrations/`                      | See § Each implementation owns its database                                                              |
| `src/media/*`                                              | `media/*`                                          | The ffmpeg arguments, and the order in `020 § Download and transcription run inside the race`            |
| `src/observability/*`                                      | `observability/*`                                  | The same redaction patterns at the root logger; `052`'s trace projection                                 |
| `src/outbox/*`                                             | `outbox/*`                                         | The claim statement, `MAX_ATTEMPTS`, the backoff                                                         |
| `src/routes/auth.ts`                                       | `routes/auth.py`                                   | Constant-time compare (`hmac.compare_digest`)                                                            |
| `src/turn/*`                                               | `turn/*`                                           | The race, turn order and folding (`037`, `046`, `047`), how each ending records and delivers             |
| `src/backfill.ts`, `src/evals/runner.ts`                   | `backfill.py`, `evals/runner.py`                   | Same flags; the eval reads the same `evals/golden/cases.jsonl` (`009`)                                   |

The choices the developer left open:

| Concern     | Choice                                    | Why                                                                                |
| ----------- | ----------------------------------------- | ---------------------------------------------------------------------------------- |
| Database    | SQLAlchemy 2 Core over psycopg 3, async   | Core issues the SQL written; the ORM's unit of work would hide the claim statement |
| Migrations  | Alembic, from a baseline equal to the SQL | Each implementation owns its schema; the comparison test keeps them equal          |
| Tests       | pytest, with coverage.py in branch mode   | The default runner; branch mode is what makes a branch threshold measurable        |
| Lint/format | Ruff, line length 100                     | One tool for both jobs, and it bans imports per file, which C2 needs               |
| Types       | pyright in strict mode                    | The closest match to `tsc` under `strict`, which the TypeScript side runs          |

Ports are abstract base classes, not `typing.Protocol`. ADR-0008 wanted a test
double to name the port it stands in for, and a protocol matches structurally
and silently, which is the property ADR-0008 moved away from.

LangChain offers no transcription interface. The transcriber calls the `openai`
client directly, as `053` does in TypeScript, and that import is the
registry's like any other (C2).

## The bounded loop is the TypeScript graph, translated

`langgraph-runner.ts` already draws the loop as a LangGraph graph (`050 § The
graph has three nodes and a step counter`). The Python runner translates that
graph; it does not design its own. Three nodes and a step counter in state:

1. **`model`** calls the model with the turn's tools bound and adds one to the
   counter. A response with no tool calls must be the `AgentReply`, and ends
   the graph. A response with tool calls goes to `tools`.
2. **`tools`** handles the calls one at a time, in the order the model made
   them. An unknown tool, input that fails the tool's schema, and a tool that
   raises each answer the model with `053`'s error text, and the loop goes on.
   A write (`send_flow`, `add_tag`, `remove_tag`, `set_field`, `write_note`) is
   staged on the `ActionStage` and returns `{ staged: … }`; nothing reaches
   ManyChat. The exception is `send_flow` on an inbound turn, which `029`
   sends when called, with its follow-ons, through the `ManyChatClient` port,
   and which returns `{ sent: … }`, one send per flow per turn. A read
   (`get_contact`) is performed through the `ContactReader` port, at most
   `MAX_READS_PER_TURN` times with `READ_TIMEOUT_MS` each, and returns its
   result or `{ available: false }` (`024`). Then back to `model`, unless the
   counter has reached the cap less one.
3. **`reply`** is the last step. It offers no tools, and sees a note of what was
   staged in place of its own tool calls. It must produce the `AgentReply`. A
   tenant with no tools gets this node alone, one model call.

The numbers are `tools.ts`'s and `contact.ts`'s at the TypeScript tag the
release names. At 0.36.0 they are a cap of 4 steps (`MAX_STEPS`), 8 staged
actions (`MAX_ACTIONS_PER_TURN`) and 2 reads (`MAX_READS_PER_TURN`) of
1500 ms (`READ_TIMEOUT_MS`). ADR-0010 as amended by ADR-0016 and ADR-0019 is
the rule: reads perform inside the loop, and so does a flow on an inbound
turn; every other write stages and is performed only after the guardrails
pass, and is discarded on any escalation.

The reply is asked for as `050` asks for it: the model's JSON schema is
`AgentReplyForModel` as `053`'s `modelJsonSchema` derives it, byte for byte,
and the reply is validated against that contract by the runner, not trusted
to a provider's structured-output mode.

The `ActionStage` belongs to the turn handler, not to the graph state. A turn
that hits the abort never returns its state, and `012` still has to record what
it staged as `discarded`. That is why `runner.ts` takes the stage from its
caller, and the Python runner does the same.

An exception from the graph fails closed, as `runner.ts` does: the reply is the
tenant's escalation with `low_confidence`, and `modelError` names the error. A
`GraphRecursionError` is one of those, never a reason to raise the limit. The
abort's own cancellation is re-raised, so the turn handler can tell "too slow"
from "misbehaved".

## The first release is the core front desk

The first Python release answers one tenant's contacts on every Meta channel
with the same turn as TypeScript, and nothing more. Waiting for all of
0.36.0's implemented specs would put that release months out, and ADR-0025's
revisit trigger counts from the first release. The specs it claims:

| Area                 | Specs                                                       |
| -------------------- | ----------------------------------------------------------- |
| The reply            | `001`, `013`, `051`                                         |
| Channels and wire    | `002`, `017`, `022`, `048`, `049`                           |
| Tenant config        | `003`                                                       |
| The loop and tools   | `012`, `024`, `029`, `030`, `050`, `053`                    |
| Turns and history    | `018`, `019`, `037`, `046`, `047`                           |
| Media                | `020`                                                       |
| Tracing              | `052`                                                       |
| Evals                | `009` (the runner and `eval:mock`)                          |
| How the code is held | `004` (the coverage floor), `005`, `008` (frontmatter only) |

It does not claim the sales layer (`023`, `027`, `028`, `032`, `034`, `042`,
`045`), nudges (`025`), learning (`031`), model-graded and conversation evals
(`016`, `043`), prompt section overrides (`044`), plugins (`036`, `038`, `039`,
`041`), or the tenant package, CLI and scaffolder (`033`, `035`). Each later
release names the specs it adds, and adds their rows to the tables above.

A tenant config is the same files either way, so the Python service will be
handed config written for features it lacks. **Boot refuses a config that
uses a feature of an unclaimed spec**, naming the field and the spec, rather
than loading it and behaving as if the field were absent. A funnel stage,
offering or nudge that silently does nothing is the fail-open C6 forbids.

## The Constitution transfers whole

| Clause | In the Python implementation                                                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1     | The same gitignored `config/`; Gitleaks scans the repository whatever the language; fixtures are invented                                        |
| C2     | Ruff's `banned-api` rejects the provider packages, `openai` and `init_chat_model` everywhere but `agent/registry.py`, and a test asserts it      |
| C3     | `AgentReply` and the guardrails, byte for byte; `extra='forbid'`                                                                                 |
| C4     | The same fence; nothing inbound reaches model selection, tool availability or the system prompt                                                  |
| C5     | Redaction at the root logger, LangChain tracing refused at boot, `052`'s projection only, logs name the conversation's UUID (ADR-0014)           |
| C6     | Every exception path escalates, including `ValidationError` and `GraphRecursionError`; a config using an unclaimed spec fails boot               |
| C7     | The race at `RACE_DEADLINE_MS` (8000 ms) inside ManyChat's 10 s, the abort at `MODEL_ABORT_MS` (30 000 ms), the ordering checked at boot (`002`) |
| C8     | Each ported test cites the clause its TypeScript original cites                                                                                  |
| C9     | No customer-facing copy in Python source; `005`'s accent check covers the Python tree                                                            |

Python tests cite the clause by this repository's spec number and heading, as
the TypeScript ones do; `008`'s index does not read them (§ Verification).

## Each implementation owns its database, and the schemas stay equivalent

The Python implementation never connects to a database the TypeScript one
uses, and runs its own migrations with Alembic. Its schema is kept equivalent
to the one `db/migrations/*.sql` builds: the same tables, columns, types,
nullability and defaults. That is what lets a tenant move from one
implementation to the other by pointing it at a copy of its database, without
a data migration. The schema covers every table at the matched tag, including
those only an unclaimed spec writes, so a copy taken from TypeScript loads.

- A schema change lands here first, as a TypeScript migration, and the Python
  release that matches it carries the Alembic revision producing the same
  result.
- A test in the Python repository applies this repository's SQL migrations, at
  the matched tag, to one empty Postgres and the Alembic history to another,
  and compares the reflected schemas. Drift fails the build.

Rejected: one schema shared by both, as ADR-0018 had it. It made sense while
traffic moved between them and a contact's history had to follow. With no
handover, it would bind each release of one to a deploy of the other and leave
the schema with two owners for good.

## Wire formats are the same, so a tenant can switch

A tenant that moves between implementations keeps its config, its ManyChat
setup and its contacts' tokens. So the two agree on:

- **Tenant config:** the same files in `CONFIG_DIR`, validated by the same
  contracts (`003`), so a tenant project (`033`) runs on either, within the
  specs the Python release claims.
- **The inbound and outbound ManyChat shapes** (`002`, `017`, `048`),
  including the callback payload.
- **Contact tokens** (`019`): 32 random bytes as base64url, the SHA-256 hex
  hash, the constant-time compare. A token one issued binds in the other.
- **The outbox payload** (`{ messages, actions?, turnId? }` and
  `{ generation }`), so rows left pending by one are delivered by the other
  after a switch.

## A Python release ships only on a green parity gate

Each Python release runs all of these against the TypeScript tag it names,
for the specs it claims:

1. **The golden set under the mock model.** `eval:mock` and its Python
   counterpart run `evals/golden/cases.jsonl` against a fixture config in this
   repository that uses only the claimed specs, and agree case by case on
   outcome and staged actions, not merely both pass. A case that needs an
   unclaimed spec is skipped by name, and the run prints the skipped list, so
   it shrinks visibly from release to release.
2. **The golden set under the real model.** Both runners, one `AGENT_MODEL`.
   The deterministic assertions of `009` pass in both. `review` criteria are
   read by a person.
3. **The test suite, ported clause by clause.** Every TypeScript test that
   cites a clause of a claimed spec has a Python counterpart citing the same
   clause, and the Python coverage meets the floor of `004`: 85 % statements,
   75 % branches, 85 % functions, 85 % lines. coverage.py's own `fail_under`
   is a single combined figure, so the gate reads its JSON report and checks
   each threshold separately. coverage.py reports functions only as regions
   in that report; computing the function figure from them, or dropping it,
   must be decided explicitly, not by default.
4. **The cross-implementation checks:** the schema comparison, the outbox
   payload and token round trips in both directions, the system prompt built
   from each fixture config compared byte for byte, and the tool and reply
   JSON schemas compared byte for byte with `053`'s recorded fixtures.
5. **CI.** The Python repository runs `ruff check`, `ruff format --check`,
   pyright, the tests with the coverage gate and the mock eval on every pull
   request.

A tenant's own suite (`009`) is the tenant's to run, against its own config and
outside CI (C1), before it switches implementation.

## Verification

- Each row of § Defaults that change behaviour are pinned has a test that reads
  the configured value or drives the behaviour: a write tool makes no request
  inside the graph; tool calls stage in `tool_calls` order; `recursion_limit`
  equals `RECURSION_LIMIT`, and a graph whose counter never stops hits it and
  escalates; each provider's retries; a 429 with `Retry-After` settles at the
  abort; each provider's request is closed on the abort; a turn past the abort
  is cancelled; a turn past the deadline still completes into the outbox; boot
  fails with a LangChain tracing variable set; `max_tokens` and Anthropic's
  `cache_control` read from the request body; an unknown inbound key gets a
  400 with no input echoed; an invented media URL fetched through `httpx`
  appears in no log line; a ManyChat call times out at 10 s and a contact
  read at 1500 ms.
- With `TRACE_TURNS=langsmith`, a test captures the upload and asserts it
  carries `052`'s projection and no message text.
- A test boots with a fixture config that sets a field of an unclaimed spec and
  asserts boot fails naming that spec.
- Ruff's `banned-api` and an import test enforce C2.
- The schema comparison, the payload and token round trips, and the prompt and
  schema comparisons run on every pull request in the Python repository (gate
  item 4).

What this misses:

- **Specs claimed here.** `008` derives a spec's evidence from citations under
  this repository's `test/`. A Python test citing a clause counts nowhere in
  `specs/README.md`, so the index says nothing about whether the Python side
  meets a spec. The Python release notes, naming the TypeScript tag matched
  and the specs claimed, are the only record.
- **Specs not yet claimed.** Every spec outside § The first release is unmet in
  Python until a release claims it. The boot refusal keeps a tenant from
  running into that unknowingly; nothing measures how far behind the Python
  side is except the list in its release notes.
- **Latency.** The eval checks each case's runner latency against
  `EVAL_MAX_LATENCY_MS` from one machine, with no webhook, database or ManyChat
  in the path, and under the mock model it measures nothing. How often turns
  lose the race in production is measured by each deployment on its own.
- **New defaults.** A pin's test catches a pinned value that changed. It does
  not catch an option a new version adds. Reading the changelog of each
  LangChain, LangGraph, FastAPI and provider update is the check, and review
  is the enforcement.
- **The real model.** Identical prompts through two SDKs are not identical
  requests: message conversion and cache-control placement can differ even on
  LangChain in both languages. Real-model evals can disagree for those reasons
  alone, with neither implementation wrong. The mock comparison is exact; the
  real-model one is read by a person.
- **Drift between releases.** The gate runs when Python releases. A spec
  implemented here today is unmet in Python until its next release, and
  nothing here fails meanwhile. ADR-0025's revisit trigger is the bound.
- **What ManyChat does.** As in `002` and `012`, every test here fakes it.
