---
status: specified
constitution: [C1, C2, C3, C4, C5, C6, C7, C8, C9]
adr: [0018, 0001, 0004, 0008, 0010, 0012, 0013, 0014, 0016, 0017, 0019]
---

# 026 — Python Port Parity

Defines what the Python service of ADR-0018 must preserve before it takes
traffic from the TypeScript one: the framework defaults it overrides, how
modules map, the bounded loop as a LangGraph graph, the state both services
share during cutover, and the gate each traffic step waits on. It leaves out
new features (retrieval, multi-agent), the docs site port, and Python CI wiring
beyond the parity gate.

## The port preserves behaviour, not framework defaults

The reflexive port is "we are moving to LangChain, so use LangChain the way
LangChain wants to be used": `create_agent` with tools that do their work, a
`ToolNode`, a checkpointer for memory, LangSmith for observability, and each
provider client as it comes out of the box. Every one of those is idiomatic,
and every one changes behaviour that a spec here fixes and a test asserts. The
result would pass a review of the Python and fail a reading of `012`.

`022` met the same move with the ManyChat SDK and answered it with a rule. This
spec applies that rule to the whole port:

> **The Python service changes no behaviour a spec in this repository fixes.**
> Every framework option that behaviour depends on is set explicitly, and a
> default is kept only where no spec is touched by it.

The parity target is the TypeScript service at the commit the gate runs
against, which means the specs marked `implemented`. Specs still `specified`
(`007`, `015`, `016`, `023`, `024`, `025`) are not in the target.
Where this spec mentions one, it says what must already hold when it lands.
Whichever codebase implements such a spec first, the other matches it before
traffic moves again (ADR-0018).

## Defaults that change behaviour are pinned, and each pin has a test

Read on 2026-10-02 from the wheels on PyPI: `langchain` 1.4.3,
`langchain-core` 1.6.6, `langgraph` 1.2.12, `langgraph-prebuilt` 1.1.0,
`langchain-anthropic` 1.7.5, `langchain-openai` 1.6.7,
`langchain-google-genai` 4.4.0, `langsmith` 0.14.4, `anthropic` 1.11.0,
`openai` 3.24.0, `pydantic` 2.13.5, `fastapi` 0.142.2, `uvicorn` 0.54.0,
`httpx` 0.28.1, `coverage` 7.16.2. The TypeScript side is `ai` 7.0.127.

| Default or idiom, as read                                                                                                                                                                                                                 | Breaks                                                                                                               | Required                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_agent` and `ToolNode` run a tool's function when the model calls it                                                                                                                                                               | ADR-0010, C6, `012 § A tool stages an action; the server performs it`                                                | No prebuilt agent and no `ToolNode`. The graph's own tools node stages writes and performs reads (§ The bounded loop)                                             |
| `ToolNode` runs one step's tool calls concurrently (`executor.map`, `asyncio.gather`)                                                                                                                                                     | `012`: actions are performed in the order staged; the fourth is the dropped one                                      | Tool calls are staged one at a time, in the order of `tool_calls` on the model's message                                                                          |
| `recursion_limit` is 10007 in `langgraph` (`LANGGRAPH_DEFAULT_RECURSION_LIMIT`), 25 in `langchain-core`'s own config; it counts supersteps, not model steps                                                                               | `012 § The loop is bounded at four steps`, ADR-0016                                                                  | The step counter in graph state is the cap. `recursion_limit` is set on every invocation to the supersteps that cap allows, and hitting it fails closed           |
| `ChatAnthropic.max_retries` is 2; `ChatOpenAI.max_retries` is `None`, leaving the `openai` client's 2; `ChatGoogleGenerativeAI.max_retries` is 6, passed as total attempts, where 0 means the Google SDK's own default                    | Parity: the AI SDK retries twice (`maxRetries` default 2, unset in `runner.ts`), inside the abort                    | Pinned per provider to three attempts in all: 2, 2 and 3. Every retry runs inside the abort below                                                                 |
| The `anthropic` and `openai` clients time out a read after 600 s; the LangChain wrappers pass `None`; the Google timeout was not read                                                                                                     | C7, `002 § Latency budget`: the abort fires at 30 000 ms                                                             | The whole turn, graph and media included, runs under one `asyncio.timeout` of `MODEL_ABORT_MS`. Async calls only: a sync `invoke` in a thread cannot be cancelled |
| `asyncio.wait_for` cancels the awaited task when it times out; the event loop keeps only a weak reference to a task from `create_task`                                                                                                    | ADR-0001: the losing call is not abandoned                                                                           | The race uses `asyncio.wait` with a timeout, never `wait_for`, and the turn handler holds a strong reference to the task until it settles                         |
| LangSmith tracing is off until `LANGSMITH_TRACING`, `LANGCHAIN_TRACING_V2` or a sibling is `"true"`, and then sends every run's inputs and outputs unless `LANGSMITH_HIDE_INPUTS` and `_OUTPUTS` are set                                  | C5 ("no PII in logs or traces"); the tenant's prompt and catalog, the data C1 keeps out of git, would go to a vendor | Boot refuses to start while any of those variables is `"true"`. The TypeScript runner's telemetry records no inputs by default (`recordPromptsInTraces`)          |
| `set_verbose` and `set_debug` in `langchain-core` are off by default, and when on they attach handlers that print each run to stdout, past the logger                                                                                     | C5                                                                                                                   | Never called. A test asserts both read false after boot                                                                                                           |
| `init_chat_model` infers a provider from a bare model name (`gemini…` becomes `google_vertexai`); the Gemini API's provider name is `google_genai`, not `google`; with no model, `configurable_fields` lets runtime config pick the model | C2's `provider:model` string (ADR-0018); C4: no inbound field alters model selection                                 | The registry splits `provider:model` itself, maps `google` to `google_genai`, passes `model_provider` explicitly, and never sets `configurable_fields`            |
| A LangGraph checkpointer is the idiomatic memory, and `PostgresSaver` creates its own tables                                                                                                                                              | `018`, `019`: history is the last ten bound turns in `turns`; the schema rule below                                  | No checkpointer. History is read from `turns` exactly as `store.ts` reads it                                                                                      |
| Pydantic models ignore unknown keys (`extra='ignore'`)                                                                                                                                                                                    | The `.strict()` inbound schemas of `002 § Inbound payload`                                                           | `extra='forbid'` on every inbound model and on the model-output model                                                                                             |
| FastAPI answers a validation failure with 422 and `exc.errors()`, which carries each rejected `input`                                                                                                                                     | `017`: "a 400 for an invalid body"; C5                                                                               | A handler answers 400 and echoes no input value                                                                                                                   |
| Starlette answers an unhandled exception with a 500                                                                                                                                                                                       | `017 § An error on the message route is a handoff, not a 500`                                                        | The same handoff as `server.ts`, with the same body for every other route                                                                                         |
| `uvicorn` believes `X-Forwarded-For` from `127.0.0.1,::1` (or `FORWARDED_ALLOW_IPS`) with `proxy_headers` on                                                                                                                              | `017`: an empty `TRUST_PROXY` trusts no proxy                                                                        | `forwarded_allow_ips` comes from `TRUST_PROXY`, and proxy headers are off when it is empty                                                                        |
| `httpx` times out every request after 5 s                                                                                                                                                                                                 | `002`, `019`: no timeout on a reply send today, 10 s on a token write or an action                                   | Each ManyChat call sets the timeout `client.ts` uses. When `022` lands, its 10 s for every call                                                                   |
| `httpx` logs every request at `INFO`, full URL included, on the `httpx` logger                                                                                                                                                            | `020 § The URL never reaches storage or logs`, C5                                                                    | Redaction is attached at the root of logging, so `httpx`, `uvicorn` and LangChain records pass through it like the service's own                                  |

Anything this table could not read is pinned without a default to compare it
with: the Google client's timeout, and every option of an Ollama chat model
(`007` is not implemented). A default observed here is a fact about one
version. Renovate (`011`) can change it, which is why each pin is a test that
reads the configured value, not a comment saying what it was.

## The module mapping is mechanical, not a redesign

Each TypeScript module has one Python counterpart, with the same name in
`snake_case` and the same constants under the same names, so a reviewer can
read the two side by side. Paths on the right are relative to the Python
package root; where that root lives is the implementing pull request's call.

| TypeScript                                        | Python                                    | What must stay identical                                                                      |
| ------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| `src/main.ts`                                     | `main.py`                                 | Boot order, `SIGHUP` reload, `SIGTERM` drain                                                  |
| `src/server.ts`                                   | `app.py`                                  | Hooks in the same order: rate limit, auth, then the body (`017`)                              |
| `src/agent/registry.ts`                           | `agent/registry.py`                       | The only provider import (C2); `PRICING`, `supportsTemperature`, `acceptsImages`              |
| `src/agent/runner.ts`                             | `agent/runner.py`                         | `AgentRunner` port, `AgentResult` fields, the fail-closed `modelError`                        |
| `src/agent/tools.ts`                              | `agent/tools.py`                          | `MAX_STEPS`, `MAX_ACTIONS_PER_TURN`, `ActionStage`, tool names and descriptions               |
| `src/agent/prompt.ts`                             | `agent/prompt.py`                         | Every string, byte for byte, including the fence and the staged notice                        |
| `src/agent/guardrails.ts`                         | `agent/guardrails.py`                     | Pure functions, the same interventions under the same names                                   |
| `src/agent/transcriber.ts`                        | `agent/transcriber.py`                    | The `Transcriber` port; its provider import lives in `registry.py`                            |
| `src/agent/mock-provider.ts`                      | `agent/mock_provider.py`                  | The same canned replies for `mock:`, so `eval:mock` outcomes can be compared                  |
| `src/channels/port.ts`, `src/channels/manychat/*` | `channels/port.py`, `channels/manychat/*` | Wire shapes, the token bucket (5, refilling at 10 a second), the media URL match              |
| `src/config/loader.ts`                            | `config/loader.py`                        | A failed reload keeps the previous config (`003`)                                             |
| `src/contracts/*`                                 | `contracts/*`                             | Field names, limits and enum values, as Pydantic models                                       |
| `src/conversation/*`                              | `conversation/*`                          | The SQL each query issues, and the token format and hash (`019`)                              |
| `src/db/client.ts`, `src/db/schema.ts`            | `db/client.py`, `db/schema.py`            | Table definitions that mirror the Drizzle schema and never create it                          |
| `src/db/migrate.ts`                               | none while TypeScript serves              | See § Side by side means one schema                                                           |
| `src/media/*`                                     | `media/*`                                 | The ffmpeg arguments, and the order in `020 § Download and transcription run inside the race` |
| `src/observability/redact.ts`                     | `observability/redact.py`                 | The same patterns, applied at the root logger                                                 |
| `src/outbox/*`                                    | `outbox/*`                                | The claim statement, `MAX_ATTEMPTS`, the backoff                                              |
| `src/routes/auth.ts`, `src/routes/turn.ts`        | `routes/auth.py`, `routes/turn.py`        | Constant-time compare (`hmac.compare_digest`); the race                                       |
| `src/backfill.ts`, `evals/*.ts`                   | `backfill.py`, `evals/*.py`               | Same flags; the eval reads the same `evals/golden/cases.jsonl`                                |

The choices the developer left open:

| Concern     | Choice                                    | Why                                                                                |
| ----------- | ----------------------------------------- | ---------------------------------------------------------------------------------- |
| Database    | SQLAlchemy 2 Core over psycopg 3, async   | Core issues the SQL written; the ORM's unit of work would hide the claim statement |
| Migrations  | Alembic, only after TypeScript is retired | One owner of the schema at a time                                                  |
| Tests       | pytest, with coverage.py in branch mode   | The default runner; branch mode is what makes a branch threshold measurable        |
| Lint/format | Ruff, line length 100                     | One tool for both jobs, and it bans imports per file, which C2 needs               |
| Types       | pyright in strict mode                    | The closest match to `tsc` under `strict`, which the TypeScript side runs          |

Ports are abstract base classes, not `typing.Protocol`. ADR-0008 wanted a test
double to name the port it stands in for, and a protocol matches structurally
and silently, which is the property ADR-0008 moved away from.

LangChain offers no transcription interface this spec could find. The
transcriber calls the provider's own SDK, and that import is the registry's
like any other (C2).

## The bounded loop is a graph the service draws, not a prebuilt agent

The graph has three nodes and a step counter in its state:

1. **`model`** calls the model with the turn's tools bound and adds one to the
   counter. A response with no tool calls must be the `AgentReply`, and ends
   the graph. A response with tool calls goes to `tools`.
2. **`tools`** handles the calls in the order the model made them. A write
   (`send_flow`, `add_tag`, `remove_tag`, `set_field`, and `write_note` when
   `024` lands) is staged on the `ActionStage` and returns `{ staged: … }`;
   nothing reaches ManyChat. The exception is `send_flow` on an inbound turn,
   which `029` sends when called, with its follow-ons, through the
   `ManyChatClient` port, and which returns `{ sent: … }`; the Python node
   does the same, keeping one send per flow per turn and the stage floor that
   counts a payment link in flight. Before the contact is a prospect, the
   node refuses every write but the intent field and `write_note` with
   `not_prospect`, as `034` specifies, and sends the opening on the turn that
   first stages `prospect`, not the first model turn. A read (`get_contact`, when `024` lands) is
   performed through the `ManyChatClient` port, with its own timeout, and
   returns its result or `{ available: false }`. Then back to `model`, unless
   the counter has reached the cap less one.
3. **`reply`** is the last step. It offers no tools, and sees a note of what was
   staged in place of its own tool calls, as `runner.ts` does in
   `prepareStep`. It must produce the `AgentReply`. A tenant with no tools gets
   this node alone, one model call.

The numbers are `tools.ts`'s, at the commit the gate runs against. Read on
2026-10-02, they are a cap of 2 steps and 3 staged actions, with no read tool.
`024` raises them to 4 steps, 8 actions and 2 reads, and adds the read with its
1500 ms timeout. The graph does not change shape when it does. ADR-0010 as
amended by ADR-0016 and ADR-0019 is the rule in both cases: reads perform
inside the loop, and so does a flow on an inbound turn; every other write
stages and is performed only after the guardrails pass, and is discarded on
any escalation.

How the model is asked for the `AgentReply` on a step that may also call tools
is the implementation's choice, with three limits. The reply is validated
against the same `AgentReplyForModel` contract. A reply-shaped tool, if one is
used, is never staged and never counts against the action cap. And the tools
the model sees are otherwise the ones `buildTools` offers.

The `ActionStage` belongs to the turn handler, not to the graph state. A turn
that hits the abort never returns its state, and `012` still has to record what
it staged as `discarded`. That is why `runner.ts` takes the stage from its
caller, and the Python runner does the same.

An exception from the graph fails closed, as `runner.ts` does: the reply is the
tenant's escalation with `low_confidence`, and `modelError` names the error. A
`GraphRecursionError` is one of those, never a reason to raise the limit. The
abort's own cancellation is re-raised, so the turn handler can tell "too slow"
from "misbehaved".

## The Constitution transfers whole

| Clause | In the Python service                                                                                                                            |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1     | The same gitignored `config/`; Gitleaks scans the repository whatever the language; fixtures are invented                                        |
| C2     | Ruff's `banned-api` rejects the provider packages and `init_chat_model` everywhere but `agent/registry.py`, and a test asserts it                |
| C3     | `AgentReply` and the guardrails, byte for byte; `extra='forbid'`                                                                                 |
| C4     | The same fence; nothing inbound reaches model selection, tool availability or the system prompt                                                  |
| C5     | Redaction at the root logger, tracing refused at boot, logs name the conversation's UUID (ADR-0014)                                              |
| C6     | Every exception path escalates, including `ValidationError` and `GraphRecursionError`                                                            |
| C7     | The race at `RACE_DEADLINE_MS` (8000 ms) inside ManyChat's 10 s, the abort at `MODEL_ABORT_MS` (30 000 ms), the ordering checked at boot (`002`) |
| C8     | Each ported test cites the clause its TypeScript original cites                                                                                  |
| C9     | No customer-facing copy in Python source; `005`'s accent check covers the Python tree                                                            |

`008` derives a spec's evidence from citations under `test/`. Python tests
count only where the index looks, which the implementing pull request settles
before it claims any spec.

## Side by side means one schema, owned by TypeScript until it is retired

The TypeScript service applies `db/migrations/*.sql` at boot and records them
in `_migrations`. While it serves traffic, it owns the schema. The Python
service runs no migration against the shared database: no `alembic upgrade`,
no `metadata.create_all`, no checkpointer `setup()`. Two migration histories on
one database is two tools each sure it knows the schema, and the second one to
run is wrong.

- A schema change during cutover lands as a TypeScript migration, deployed,
  before any Python code uses it. Changes are additive (new tables, nullable
  columns); nothing is dropped or renamed while both serve.
- The Python table definitions mirror `schema.ts`. A test applies the SQL
  migrations to an empty Postgres and compares the reflected schema with them:
  tables, columns, types, nullability and defaults. Drift fails the build.
- When TypeScript is retired, Alembic starts from a baseline stamped against the
  schema as it then stands. `_migrations` stays, as history.

## The outbox lets two workers coexist, and nothing else in the process does

`claimBatch` is one statement, an `UPDATE` whose `WHERE id IN (…)` selects the
due rows `FOR UPDATE SKIP LOCKED`. A row one worker has locked is skipped by the
other, and once claimed it is `delivering`, so neither sees it as pending
again. The Python worker issues the same statement. A select in one
transaction followed by an update in another would let both workers read the
same pending row, which is the race ADR-0004 exists to avoid.

- **The payload is a contract.** A row either service writes is one the other
  can deliver: `{ messages, actions?, turnId? }` for a reply, with the
  `StagedAction` shapes of `contracts/agent.ts`, and `{ generation }` for a
  contact token. Retries, `MAX_ATTEMPTS` (5), the backoff of
  `min(300, 2^attempts)` seconds and the first-attempt dead letter for a 4xx
  other than 429 are the same.
- **The first traffic step runs the Python worker off.** The TypeScript worker
  delivers Python's rows, which is the strongest evidence the payload matches.
- **No reaper exists.** A row claimed by a worker that dies before marking it
  stays `delivering` (read in `queue.ts` on 2026-10-02). Both workers finish
  their in-flight batch on `SIGTERM`, and a deploy never kills one mid-batch.
  The TypeScript worker's batch ends sooner on a stop: it finishes each
  contact's current reply and hands their later rows back (`002 § Messages to
one contact are paced`).

What does not coexist is anything held in memory:

- **The ManyChat rate limit.** Each process has its own token bucket.
  TypeScript runs one, shared by the server and the worker
  (`022 § One instance per process`). A Python process adds its own. While both
  serve, the sum of every bucket's rate stays at what TypeScript sends alone
  today, for example by halving each.
- **The per-address limit** of 300 requests a minute (`017`) is per process, so
  the ceiling doubles while both run. Accepted: the limits that bound a contact
  and a tenant are in Postgres (`rate_counters`, `budget_counters`) and hold
  across both.
- **In-flight turns.** A losing model call completes into the outbox only from
  the process that ran it (ADR-0001), and so do token writes in flight (`019`)
  and inline actions after the response (`012`). A service leaves the cutover
  in this order: no new requests reach it, which takes up to a day because of
  callbacks (§ Callbacks pin a contact), then at least `MODEL_ABORT_MS` for its
  last turns to land, then `SIGTERM`.

## Each piece of state has one home, and both services read it there

| State                           | Spec         | Home                                                                                                          | Both services must                                                                                           |
| ------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| History                         | `018`, `019` | `turns`: `text`, `bound`, `media_kind`, `actions`, `outcome`                                                  | Read the last ten bound turns within `historyDays`; write the same `outcome` values                          |
| Turn cap                        | `018`        | `conversations.turn_count`, `last_message_at`                                                                 | Reset after `idleResetHours` of silence, counting bound turns only                                           |
| Contact token                   | `019`        | Its SHA-256 (current and previous) on `conversations`; the token in the ManyChat field `MANYCHAT_TOKEN_FIELD` | Issue 32 random bytes as base64url, hash to hex, compare in constant time, reissue at most hourly            |
| Token write retry               | `019`        | `outbox`, `kind = 'contact_token'`, due 60 s after issue                                                      | Replace by `token_generation`, so a token one service issued is repaired by the other                        |
| Reply text in transit           | `002`        | The ManyChat field `MANYCHAT_REPLY_FIELD`                                                                     | Re-set it before every trigger; never read it back                                                           |
| Action record                   | `012`        | `turns.actions`                                                                                               | Write the same entries and statuses                                                                          |
| Daily spend                     | `003`        | `budget_counters`, per tenant per UTC day                                                                     | Record the same estimate from the same `PRICING`                                                             |
| Per-contact rate                | `017`        | `rate_counters`                                                                                               | Count in the same windows                                                                                    |
| Tenant config                   | `003`        | Files in `CONFIG_DIR`, loaded per process                                                                     | Load the same files; a `SIGHUP` goes to both processes, because each reloads only itself                     |
| Notes (`024`, specified)        | `024`        | ManyChat note fields; `turns.actions` holds id and length                                                     | Nothing new in Postgres                                                                                      |
| Funnel stage (`023`, specified) | `023`        | A ManyChat field; "earlier stage" and "sent once" read `turns.actions`                                        | Read the record the other service wrote                                                                      |
| Nudges (`025`)                  | `025`        | A new `nudges` table, and a worker                                                                            | See the next section                                                                                         |
| Offering (`028`, `042`)         | `028`        | `conversations.offering`; the ManyChat offering field                                                         | Store a bound request's offering or a performed offering write; treat an id the catalog lacks as no offering |

The token is the case that most needs both sides to agree. A contact whose
token one service issued writes next through the other, and is bound only if
both generate, hash and compare it the same way. A test issues in one and binds
in the other, in both directions.

## A scheduled job runs where its claim is atomic

Read on 2026-10-02, the only recurring work in `src/` is the outbox poll; the
other timers are the race, the abort and the rate limiter's wait. The outbox
is safe in both services, as above. The backfill (`019`) is a one-off and
already safe to run twice.

`025` adds the nudge worker. Its claim at due time uses
`FOR UPDATE SKIP LOCKED`, so running it in both services is safe. Its
scheduling is not, unless "at most one nudge waits per contact" is a database
constraint (a unique index on pending rows per conversation) rather than a
check in code. Two services scheduling at once would each find none pending
and each insert one. If `025` lands before the cutover completes, its
migration carries the constraint.

## Callbacks pin a contact to the service that answered last

Routing the Dynamic Block moves only a contact's entry into the conversation.
Every reply registers `external_message_callback` at the answering service's
`PUBLIC_BASE_URL`, for up to 86 400 s (`002 § Owning the conversation loop`),
so the contact's next message goes back to that service whatever the Dynamic
Block now says.

- **A rollback is not instant.** Pointing the Dynamic Block back at TypeScript
  leaves up to 24 hours of callbacks aimed at Python. The Python service keeps
  serving them for that long; switching it off sooner drops those contacts'
  messages.
- **Each service accepts the other's callback.** The payload carries `text`,
  `subscriber_id` and `ai_token`, and the secret the caller presented
  (`017 § The callback carries back the secret the caller presented`), in the
  same shape from both.

## Traffic moves only on a green parity gate

Each step that moves contacts to Python waits for all of these, run against
the TypeScript commit deployed at the time:

1. **The golden set under the mock model.** `eval:mock` and its Python
   counterpart run `evals/golden/cases.jsonl` (22 cases, counted 2026-10-02)
   and agree case by case on outcome and staged actions, not merely both pass.
2. **The golden set under the real model.** Both runners, one `AGENT_MODEL`.
   The deterministic assertions of `009` pass in both. `review` criteria are
   read by a person. `016`'s judged verdicts join the gate when `016` is
   implemented; until then there is no judge.
3. **Each tenant's suite** (`009`), run the same way by the operator against
   the tenant's own config, outside CI (C1).
4. **The test suite, ported clause by clause.** Every TypeScript test that
   cites a spec clause has a Python counterpart citing the same clause, and the
   Python coverage meets the floor of `004`: 85 % statements, 75 % branches,
   85 % functions, 85 % lines. coverage.py's own `fail_under` is a single
   combined figure, so the gate reads its JSON report and checks each
   threshold separately. coverage.py 7.16.2 reports functions only as regions
   in that report; computing the function figure from them, or dropping it,
   must be decided explicitly, not by default.
5. **The cross-service checks:** the schema comparison, the outbox payload
   round trip in both directions, the token round trip, and the system prompt
   built from each fixture config compared byte for byte between the two.
6. **CI.** A Python job runs `ruff check`, `ruff format --check`, pyright, the
   tests with the coverage gate and the mock eval on every pull request, beside
   the TypeScript job. Both must pass.

## Verification

- Each row of § Defaults that change behaviour are pinned has a test that reads
  the configured value or drives the behaviour: a write tool makes no request
  inside the graph; tool calls stage in `tool_calls` order; `recursion_limit`
  equals the supersteps the cap allows, and a graph whose counter never stops
  hits it and escalates; each provider's retries; a turn past the abort is
  cancelled; a turn past the deadline still completes into the outbox; boot
  fails with a tracing variable set; an unknown inbound key gets a 400 with no
  input echoed; an invented media URL fetched through `httpx` appears in no log
  line.
- Ruff's `banned-api` and an import test enforce C2.
- The schema comparison, the payload and token round trips and the prompt
  comparison run on every pull request (gate item 5).

What this misses:

- **Latency.** `evals/run.ts` checks each case's runner latency against
  `EVAL_MAX_LATENCY_MS`, which defaults to the race deadline. That is 22 cases
  from one machine, with no webhook, database or ManyChat in the path, and
  under the mock model it measures nothing. The rate at which turns lose the
  race in production is not measured anywhere in the gate. It is compared
  during each traffic step: the share of model turns recorded as `deferred`,
  per service. `turns` records no service today, so the column that does is a
  TypeScript migration that lands before the first step.
- **A shadow is not available.** Sending each request to both services and
  discarding Python's reply cannot run against the shared database: the
  Python turn would record turns, spend the budget, issue a second token and
  queue a second reply. A true shadow needs its own database and a faked
  ManyChat, and measures latency without real conversations. The traffic steps
  are the shadow this spec can offer.
- **New defaults.** A pin's test catches a pinned value that changed. It does
  not catch an option a new version adds. Reading the changelog of each
  LangChain, LangGraph, FastAPI and provider update is the check, and review
  is the enforcement.
- **The real model.** Identical prompts through two SDKs are not identical
  requests: message conversion, cache-control placement and structured-output
  mode differ. Real-model evals can disagree for those reasons alone, with
  neither service wrong. The mock comparison is exact; the real-model one is
  read by a person.
- **What ManyChat does.** As in `002` and `012`, every test here fakes it.
  Whether both services' deliveries reach a phone is checked by a person
  reading one, during each step.
