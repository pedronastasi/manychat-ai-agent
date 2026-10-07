# How it works

The design behind the agent: what it does to fail safely, how the model and the
configuration stay swappable, and where each decision is written down. To try it
first, see [Running it locally](running-locally.md).

Why it races the model against an 8-second deadline, and why the losing call
completes into an outbox rather than being cancelled, is
[the problem this solves](../../README.md#the-problem-this-solves) in the README.

## What makes it production-shaped

**Fails closed, toward a human.** Low model confidence, a schema violation, an
exhausted budget, a rate limit, or a provider outage all escalate. The agent
never invents a price — an unanswerable question is a handoff, by design.

**Untrusted input, treated as such.** Contact text is fenced and labelled as
data, with the fence markers stripped first so they cannot be forged. Model
output is validated before any of it reaches a customer, and replies that leak
the prompt are dropped. The golden set includes injection attempts.

**A contact's history is theirs, not whoever names them.** The shared secret
proves a request came from the flow, not which contact it speaks for. Each
contact has a random token kept in their own ManyChat custom field and stored
here only as a hash. A request without it is answered from its own message
alone, so a leaked secret does not expose anyone's conversation
([spec 019](../../specs/019-contact-tokens.md)).

**Spend is bounded.** Every turn records tokens, cache hits, and estimated cost.
Daily token and dollar caps degrade to escalation rather than to an error — a
bill cap that fails into a human is the correct failure mode for a business.

**Channel constraints are data, not memory.** Quick replies silently do nothing
on WhatsApp; ManyChat accepts them and the contact never sees them. That lives in
a `ChannelCapabilities` value with a test, not in a comment someone forgets.

**No PII in logs.** Redaction is configured at the logger, so a new log statement
cannot opt out. Telemetry spans omit prompts by default. Log lines name a
conversation by its random ID, never by anything derived from the subscriber.

**An eval harness.** `pnpm eval` replays a labelled golden set through the current
prompt and asserts escalation behavior, price grounding, prompt leakage, and
latency — then prints every reply, because a green suite whose tone has drifted
is still a failure and only a person can see that.

## Model agnosticism

No module imports a provider package except
[`src/agent/registry.ts`](../../src/agent/registry.ts). The active model is a string:

```bash
AGENT_MODEL=anthropic:claude-haiku-4-5   # default
AGENT_MODEL=openai:gpt-5-mini            # same behavior, zero code changed
AGENT_MODEL=google:gemini-2.5-flash
AGENT_MODEL=ollama:llama3.1:8b           # local, free — see running-locally.md
AGENT_MODEL=mock:demo                    # offline, deterministic, free
```

Callers depend on an `AgentRunner` port, not on the AI SDK, so replacing even the
SDK is contained to one file.

Configuration is files, not code: `config/catalog.json` holds every fact the
agent may state, so a price change is a JSON edit and `kill -HUP`. Nothing in
`config/` is ever committed. The files are described in
[config/README.md](../../config/README.md).

## Design decisions

Every non-obvious choice is written down in [`docs/adr/`](../adr/):

| ADR                                                                     | Decision                                                                                                 |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [0001](../adr/0001-hybrid-race-reply-path.md)                           | Race the model against a deadline instead of choosing sync or async                                      |
| [0002](../adr/0002-provider-agnostic-model-layer.md)                    | One registry module may import providers; everything else uses a port (superseded)                       |
| [0003](../adr/0003-contract-first-with-zod.md)                          | Zod schemas generate both the types and the OpenAPI document (superseded)                                |
| [0004](../adr/0004-postgres-outbox-over-redis.md)                       | A Postgres outbox, not Redis — one datastore, transactional enqueue                                      |
| [0005](../adr/0005-channel-port-single-adapter.md)                      | Define the channel port, ship exactly one adapter                                                        |
| [0006](../adr/0006-manychat-auth-risk-accepted.md)                      | ManyChat does not sign webhooks; the compensating controls, written down (superseded)                    |
| [0007](../adr/0007-generateobject-not-toolloop.md)                      | `generateObject`, not a tool loop, while there are no tools (superseded)                                 |
| [0008](../adr/0008-classes-for-port-implementations.md)                 | Ports are implemented by classes; functions stay for pure transformation                                 |
| [0009](../adr/0009-no-single-letter-identifiers.md)                     | Identifiers are at least two characters, enforced by lint                                                |
| [0010](../adr/0010-bounded-tool-loop-with-staged-actions.md)            | A two-step tool loop whose tools stage actions; the server performs them after guardrails                |
| [0011](../adr/0011-model-graded-evals-behind-calibration.md)            | A judge model grades evals only in a run where it first agrees with hand-labelled calibration            |
| [0012](../adr/0012-contact-tokens-held-in-manychat.md)                  | Each contact has a token held by ManyChat; only a request carrying it reads that contact's history       |
| [0013](../adr/0013-history-spans-30-days-turn-cap-resets-daily.md)      | History reaches back 30 days; the turn cap resets after 24 hours of silence                              |
| [0014](../adr/0014-log-conversation-id-not-pseudonym.md)                | Logs identify a contact by the conversation's random ID, not a hash of the subscriber ID                 |
| [0015](../adr/0015-the-agent-closes-the-sale.md)                        | The agent takes a lead to the payment link itself; every C6 limit on what it may claim stays             |
| [0016](../adr/0016-reads-are-performed-inside-the-loop.md)              | Read tools are performed when called and the loop grows to four steps; writes are still staged           |
| [0017](../adr/0017-bounded-free-text-notes.md)                          | Free text only in declared note fields no flow renders, length-capped and stripped of identifiers        |
| [0018](../adr/0018-port-to-python-beside-typescript-on-one-database.md) | Port to Python on LangChain, LangGraph, FastAPI and Pydantic, cut over beside TypeScript on one database |
| [0019](../adr/0019-flows-are-sent-inside-the-loop.md)                   | On an inbound turn a flow is sent when the model calls it, so the reply follows it; other writes stage   |
| [0020](../adr/0020-learning-is-offline-and-human-approved.md)           | Learning is offline, from paid outcomes; a tactic reaches the prompt only after approval and an eval     |
| [0021](../adr/0021-tenants-depend-on-a-package-not-a-fork.md)           | A tenant depends on one published package and starts from a scaffolder; nobody forks to deploy           |

Behavior is specified before it is implemented, in [`specs/`](../../specs/) —
a [constitution](../../specs/000-constitution.md) of non-negotiables, the
[agent's behavior](../../specs/001-agent-behavior.md), and the
[channel contract](../../specs/002-channel-contract.md). Tests cite the clause they
enforce.

## Layout

```
specs/            behavior specified before implementation
docs/adr/         why each decision was made
src/
  contracts/      Zod schemas — the single source of truth
  agent/          registry (the only provider import), runner, prompt, guardrails
  channels/       the port, plus the ManyChat adapter and a local simulator
  conversation/   store, rate limits, budget caps
  media/          voice notes, images and videos: resolver and ffmpeg splitter
  outbox/         deferred delivery
  routes/         auth, the turn handler with the race
evals/            golden set + runner
packages/create/  `npm create manychat-ai-agent`: scaffolds a tenant project
test/             unit and integration (PGlite: real Postgres, no container)
```
