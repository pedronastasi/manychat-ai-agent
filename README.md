# ManyChat AI Agent

A production-shaped, provider-agnostic AI agent that answers customer questions
on WhatsApp through [ManyChat](https://manychat.com), escalating to a human
rather than guessing.

Switching the model is one environment variable. Switching the chat platform is
one adapter.

```bash
git clone https://github.com/pedronastasi/manychat-ai-agent.git
cd manychat-ai-agent
pnpm install && pnpm bootstrap && pnpm dev
```

That runs with **no API key and no database to install** — an offline mock model
and an embedded Postgres. In another terminal:

```bash
$ pnpm simulate "how much is the foundation course?"

  contact   how much is the foundation course?
  ------------------------------------------------------------
  agent     The Foundation Course is $450.00.
  agent     It runs 24 hours, Tuesdays and Thursdays 6-9pm. Want the link?
  ------------------------------------------------------------
  45ms  |  callback: registered  |  quick_replies: omitted
```

---

## The problem this solves

ManyChat can call an external endpoint, but **it terminates the request after 10
seconds**. An LLM call plus database work sometimes fits in that budget and
sometimes does not, so the obvious synchronous design drops replies under exactly
the conditions where a customer is already waiting.

This project takes the position that neither "always answer inline" nor "always
queue" is right, and races them.

```
inbound message
     │
     ├─ guards: keywords, turn cap, rate limit, daily budget ── denied ──▶ escalate to human
     │                                                                     (model never runs)
     ▼
  Promise.race
     ├── model answered  (< 8s) ──▶ reply inline + re-register callback
     │
     └── deadline hit    (= 8s) ──▶ short ack
                                     │
                                     └─ model keeps running ──▶ outbox ──▶ worker ──▶ Send API
```

The losing model call is **not cancelled**. Those tokens are already paid for and
the answer is still wanted, so it completes into a Postgres outbox and a worker
delivers it seconds later. The reply is never dropped, only deferred.

The conversation loop lives in this service rather than in ManyChat's visual flow
builder, via Dynamic Block's `external_message_callback`. That is what keeps the
agent portable instead of welded to one vendor's UI.

## Design decisions

Every non-obvious choice is written down in [`docs/adr/`](docs/adr/):

| ADR                                                       | Decision                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------------ |
| [0001](docs/adr/0001-hybrid-race-reply-path.md)           | Race the model against a deadline instead of choosing sync or async      |
| [0002](docs/adr/0002-provider-agnostic-model-layer.md)    | One registry module may import providers; everything else uses a port    |
| [0003](docs/adr/0003-contract-first-with-zod.md)          | Zod schemas generate both the types and the OpenAPI document             |
| [0004](docs/adr/0004-postgres-outbox-over-redis.md)       | A Postgres outbox, not Redis — one datastore, transactional enqueue      |
| [0005](docs/adr/0005-channel-port-single-adapter.md)      | Define the channel port, ship exactly one adapter                        |
| [0006](docs/adr/0006-manychat-auth-risk-accepted.md)      | ManyChat does not sign webhooks; the compensating controls, written down |
| [0007](docs/adr/0007-generateobject-not-toolloop.md)      | `generateObject`, not a tool loop, while there are no tools              |
| [0008](docs/adr/0008-classes-for-port-implementations.md) | Ports are implemented by classes; functions stay for pure transformation |

Behavior is specified before it is implemented, in [`specs/`](specs/) —
a [constitution](specs/000-constitution.md) of non-negotiables, the
[agent's behavior](specs/001-agent-behavior.md), and the
[channel contract](specs/002-channel-contract.md). Tests cite the clause they
enforce.

## Model agnosticism

No module imports a provider package except
[`src/agent/registry.ts`](src/agent/registry.ts). The active model is a string:

```bash
AGENT_MODEL=anthropic:claude-haiku-4-5   # default
AGENT_MODEL=openai:gpt-5-mini            # same behavior, zero code changed
AGENT_MODEL=google:gemini-2.5-flash
AGENT_MODEL=ollama:llama3.1:8b           # local, free — see "Local model" below
AGENT_MODEL=mock:demo                    # offline, deterministic, free
```

Callers depend on an `AgentRunner` port, not on the AI SDK, so replacing even the
SDK is contained to one file.

## What makes it production-shaped

**Fails closed, toward a human.** Low model confidence, a schema violation, an
exhausted budget, a rate limit, or a provider outage all escalate. The agent
never invents a price — an unanswerable question is a handoff, by design.

**Untrusted input, treated as such.** Contact text is fenced and labelled as
data, with the fence markers stripped first so they cannot be forged. Model
output is validated before any of it reaches a customer, and replies that leak
the prompt are dropped. The golden set includes injection attempts.

**Spend is bounded.** Every turn records tokens, cache hits, and estimated cost.
Daily token and dollar caps degrade to escalation rather than to an error — a
bill cap that fails into a human is the correct failure mode for a business.

**Channel constraints are data, not memory.** Quick replies silently do nothing
on WhatsApp; ManyChat accepts them and the contact never sees them. That lives in
a `ChannelCapabilities` value with a test, not in a comment someone forgets.

**No PII in logs.** Redaction is configured at the logger, so a new log statement
cannot opt out. Telemetry spans omit prompts by default. Subscribers are
pseudonymized for correlation.

**An eval harness.** `pnpm eval` replays a labelled golden set through the current
prompt and asserts escalation behavior, price grounding, prompt leakage, and
latency — then prints every reply, because a green suite whose tone has drifted
is still a failure and only a person can see that.

## Layout

```
specs/            behavior specified before implementation
docs/adr/         why each decision was made
src/
  contracts/      Zod schemas — the single source of truth
  agent/          registry (the only provider import), runner, prompt, guardrails
  channels/       the port, plus the ManyChat adapter and a local simulator
  conversation/   store, rate limits, budget caps
  outbox/         deferred delivery
  routes/         auth, the turn handler with the race
evals/            golden set + runner
test/             unit and integration (PGlite: real Postgres, no container)
```

## Development

```bash
pnpm bootstrap         # local config + .env from the committed examples
pnpm dev           # offline by default: mock model, embedded Postgres
pnpm simulate "…"  # send a Dynamic Block request as ManyChat would
pnpm test          # unit + integration
pnpm eval:mock     # golden set, offline and free
pnpm lint && pnpm typecheck
```

Integration tests run against **PGlite** — real Postgres compiled to WASM, in
process — so `FOR UPDATE SKIP LOCKED`, upserts and constraints behave as in
production with no container to start in CI.

### Local model

Run a real model locally via [Ollama](https://ollama.com) — free, no API key,
useful for testing the model boundary (schema adherence, latency, judgment)
without incurring API costs.

```bash
docker compose --profile local-model up        # starts Ollama alongside Postgres
AGENT_MODEL=ollama:llama3.1:8b pnpm simulate "hola"
```

The first run pulls ~4.7 GB of weights; they persist in a named Docker volume so
subsequent starts are instant. Any Ollama-supported model works — just use the
tag from `ollama list`:

```bash
AGENT_MODEL=ollama:gemma3:4b pnpm simulate "cuanto sale el curso?"
```

Inside Compose the agent reaches Ollama at `http://ollama:11434/v1`. Running
locally (outside Docker), it defaults to `http://localhost:11434/v1`; override
with `OLLAMA_BASE_URL` if needed.

Ollama models price at zero, so the daily dollar cap never fires. The token cap
still applies and guards against runaway loops. The 8 s race deadline means the
deferred path (acknowledge now, push the real answer later) becomes the default
for slower local models — that is by design.

## Deployment

```bash
docker compose up --build
```

Point a ManyChat **Dynamic Block** (Dev Tools, requires a Pro plan) at
`POST /v1/channels/manychat/message` and add an `Authorization: Bearer <secret>`
header matching `MANYCHAT_SHARED_SECRET`. The OpenAPI document is generated from
the same schemas that validate at runtime.

Configuration is files, not code: `config/catalog.json` holds every fact the
agent may state, so a price change is a JSON edit and `kill -HUP`. Nothing in
`config/` is ever committed.

## Status

MVP. Answers and escalates; it does not book, take payment, or call tools. The
`AgentRunner` port exists so adding those does not change any caller.

## License

MIT — see [LICENSE](LICENSE).
