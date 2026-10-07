# ManyChat AI Agent

[![CI](https://github.com/pedronastasi/manychat-ai-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/pedronastasi/manychat-ai-agent/actions/workflows/ci.yml)
[![Docs](https://github.com/pedronastasi/manychat-ai-agent/actions/workflows/docs.yml/badge.svg)](https://pedronastasi.github.io/manychat-ai-agent/)
[![License](https://img.shields.io/github/license/pedronastasi/manychat-ai-agent)](LICENSE)
[![Release](https://img.shields.io/github/v/release/pedronastasi/manychat-ai-agent)](https://github.com/pedronastasi/manychat-ai-agent/releases)
[![Node](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fpedronastasi%2Fmanychat-ai-agent%2Fmain%2Fpackage.json&query=%24.engines.node&label=node)](package.json)

A production-shaped, provider-agnostic AI agent that answers customer questions
on WhatsApp through [ManyChat](https://manychat.com), escalating to a human
rather than guessing.

Switching the model is one environment variable. Switching the chat platform is
one adapter.

It is for anyone putting an LLM behind a platform that enforces a hard webhook
timeout: ManyChat is the adapter that ships, and the race and the outbox below
are what carries over to any other.

```bash
git clone https://github.com/pedronastasi/manychat-ai-agent.git
cd manychat-ai-agent
pnpm install && pnpm bootstrap && pnpm dev
```

That runs with **no API key and no database to install** — an offline mock model
and an embedded [PGlite](https://pglite.dev/) Postgres. In another terminal,
`pnpm simulate` answers one question and hands one off:

![pnpm simulate answering a price question from the catalog and escalating a request for a person](docs/assets/demo.svg)

That clone is for trying the agent and working on it. To run one for your own
business, generate a project of your own instead, which depends on the published
package rather than a copy of this repository:

```bash
npm create manychat-ai-agent@latest my-agent
```

[Starting a new agent](docs/guides/getting-started.md) walks through it,
from the offline first run to a deployment.

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

The full design — what fails closed, how spend is bounded, and every decision
record — is in [How it works](docs/guides/how-it-works.md).

## What it can do

- **Answer from the catalog, or hand off.** Every fact it may state lives in
  `config/catalog.json`; anything else escalates to a person rather than being
  guessed ([spec 001](specs/001-agent-behavior.md)).
- **Run on any model.** The model is one environment variable —
  `anthropic:claude-haiku-4-5`, `openai:gpt-5-mini`, `ollama:llama3.1:8b`, or the
  offline `mock:demo` — and only [`src/agent/registry.ts`](src/agent/registry.ts)
  imports a provider.
- **Keep each contact's history theirs.** A token held in the contact's own
  ManyChat field, not the shared secret, unlocks their conversation
  ([spec 019](specs/019-contact-tokens.md)).
- **Read voice notes, images and videos** sent on WhatsApp
  ([spec 020](specs/020-inbound-media.md)).
- **Act in ManyChat and sell.** Optionally send flows, set tags and fields, read
  the contact, schedule a follow-up, and take a lead to the payment link
  ([spec 012](specs/012-agent-tools.md), [spec 023](specs/023-sales-funnel.md)).
- **Learn from outcomes**, offline and only after a person approves
  ([spec 031](specs/031-learning-from-outcomes.md)).

## Documentation

The same pages, with search, are on the
[docs site](https://pedronastasi.github.io/manychat-ai-agent/).

| To…                                          | Read                                                                                |
| -------------------------------------------- | ----------------------------------------------------------------------------------- |
| Deploy an agent for your own business        | [Starting a new agent](docs/guides/getting-started.md)                              |
| Try it from a clone, with curl or Docker     | [Running it locally](docs/guides/running-locally.md)                                |
| Point ManyChat at it                         | [Connecting ManyChat](docs/guides/connecting-manychat.md)                           |
| Turn on tools, follow-ups or the funnel      | [Agent tools and the sales funnel](docs/guides/agent-tools-and-the-sales-funnel.md) |
| Write the tenant's prompt, catalog and rules | [Tenant configuration](config/README.md)                                            |
| Understand the design                        | [How it works](docs/guides/how-it-works.md) and the [decision records](docs/adr/)   |
| Know exactly what it must do                 | The [specs](specs/), starting from the [constitution](specs/000-constitution.md)    |
| Contribute                                   | [CONTRIBUTING](CONTRIBUTING.md)                                                     |

## Development

```bash
pnpm bootstrap     # local config + .env from the committed examples
pnpm dev           # offline by default: mock model, embedded Postgres
pnpm simulate "…"  # send a Dynamic Block request as ManyChat would
pnpm test          # unit + integration
pnpm eval:mock     # golden set, offline and free
pnpm lint && pnpm typecheck
```

## Status

MVP. Answers, escalates, and can send a tenant's ManyChat flows, tags and field
values; it does not book or take payment. The `AgentRunner` port exists so
adding those does not change any caller.

## License

MIT — see [LICENSE](LICENSE).
