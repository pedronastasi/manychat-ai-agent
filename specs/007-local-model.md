---
status: specified
constitution: [C2, C3, C6, C7]
adr: [0001, 0002]
---

# 007 — Local Model (Ollama)

Defines how to run a **real** model against this agent at no cost, in Docker, and
states precisely what such a run proves and what it does not. It covers the
registry wiring, the compose service, and the three settings that must change
with it. It does not change the hosted path, and it adds nothing to CI.

## The repository already costs nothing to run

The reflexive reading of "testers should not have to pay for an LLM" is "add a
local model". That reading is wrong, because the problem it describes is already
solved.

`AGENT_MODEL=mock:demo` and `DATABASE_URL=pglite` run the whole agent — server,
guards, outbox, worker, evals — with no API key, no database and no container.
CI does exactly this on every push, and the eval suite reports 19/19 for
$0.0570 of _simulated_ spend.

So if a local model were only about cost, it would be redundant. It is worth
adding for a different reason.

## What the mock cannot prove

`mock-provider.ts` is a deterministic router: it matches the inbound text and
returns a hand-written `AgentReply`. It is **valid by construction**. It can
never emit malformed JSON, never omit a required field, never leak the prompt
scaffolding, never invent a price, and never take longer than a millisecond.

Every guardrail in `guardrails.ts` therefore runs against inputs built to
exercise it, rather than against a model genuinely trying and sometimes failing.
That is a fine test of the pipeline and no test at all of the model boundary.

| Rung                | Cost | Deterministic | What a passing run proves                                |
| ------------------- | ---- | ------------- | -------------------------------------------------------- |
| `mock:demo`         | free | yes           | The pipeline: routing, guards, contracts, outbox, worker |
| `ollama:<model>`    | free | no            | The model boundary: schema adherence, latency, judgement |
| `anthropic:<model>` | paid | no            | Production behaviour — the only numbers worth publishing |

Ollama is the middle rung and substitutes for neither neighbour.

> **Eval results from a local model are not comparable to hosted results and must
> never be quoted as this project's eval numbers.** A lower pass rate on a 8B
> model is a fact about the model.

## Ollama goes through the registry, never around it

Constitution C2 allows exactly one module to import a provider. Ollama does not
get an exception, and does not need one: it serves an OpenAI-compatible API, so
it is an `openai` provider instance with a different `baseURL`, registered as a
fourth key in `registry.ts`. No new dependency.

```ts
const ollama = createOpenAI({ baseURL: env.OLLAMA_BASE_URL, apiKey: 'ollama' });
const registry = createProviderRegistry({ anthropic, openai, google, ollama });
```

`AGENT_MODEL=ollama:llama3.1:8b` therefore works unchanged. The registry splits
on the **first** separator only — `splitId` uses `indexOf(separator)` — so a model
tag containing its own colon survives. This is the one thing about the spec most
likely to be assumed broken; it is not.

## It will lose the race, and that is information

`RACE_DEADLINE_MS=8000` is tuned for a hosted model answering in one to three
seconds (ADR-0001, Constitution C7). A 7-8B model on CPU can spend longer than
that before its first token.

So on a local model the **deferred path becomes the default path**. That is not a
malfunction; it is the cheapest available test of the design's hard part.

| Setting                   | Effect locally                                         | Commit it?                                |
| ------------------------- | ------------------------------------------------------ | ----------------------------------------- |
| `RACE_DEADLINE_MS=8000`   | Nearly every turn acknowledges and delivers via outbox | Yes — this is the default and should stay |
| `RACE_DEADLINE_MS` raised | Inline replies become observable again                 | **No** — see below                        |

Raising the deadline locally is legitimate for observing an inline reply. It must
never be committed: ManyChat's 10-second termination is external (C7) and does
not move because the model happens to be on the same machine.

## A free model must be priced at zero, or the budget cap fires

`pricingFor()` falls back to `FALLBACK_PRICING` — deliberately pessimistic at
$5/$25 per million tokens — for any model id not in the table. A local model would
therefore accrue spend it never incurred, against a `dailyCostCapUsd` that
defaults to $5.

A turn of roughly 2 000 input and 200 output tokens is charged
`2000 * 5/1e6 + 200 * 25/1e6 = $0.015`, so the cap is reached after about 330
turns (arithmetic as of 2026-09-15, from the defaults in `contracts/config.ts`).
`checkBudget` then escalates **every** subsequent turn with
`daily cost cap reached`.

The symptom — an agent that answered fine this morning and now hands every
conversation to a human — looks exactly like a bug in the agent, and is the
budget guard working correctly on fabricated numbers.

So any `ollama:` model prices at zero. The **token** cap still applies and should:
it guards against a runaway loop, which a free model can do just as well as a
paid one.

## Structured output is what will actually break

`runner.ts` calls `generateObject` against `AgentReplyForModel`. Hosted models
honour a JSON schema reliably; small local models frequently wrap the JSON in
prose or drop a required field.

The failure is already handled — `applyGuardrails` records `schema_invalid` and
escalates rather than repairing the reply (C3, C6) — so the agent degrades safely
while appearing useless.

That makes `interventions` the diagnostic that matters, not the pass rate. A run
dominated by `schema_invalid` is a statement about the model's schema adherence,
and choosing a different local model is the fix. Changing the contract to suit a
small model is not: the contract is what the hosted path depends on.

## The compose service

Ollama sits behind a compose **profile**, so `docker compose up` behaves exactly
as it does today. A contributor who wants Postgres must not be made to pull
several gigabytes of model weights.

| Property    | Value                                                         |
| ----------- | ------------------------------------------------------------- |
| Service     | `ollama`                                                      |
| Profile     | `local-model` — started only with `--profile local-model`     |
| Image       | `ollama/ollama`                                               |
| Port        | `11434`                                                       |
| Volume      | named volume on `/root/.ollama`, so weights survive `down`    |
| Healthcheck | `GET /api/tags` — ready means _serving_, not merely _started_ |

The model is pulled on first use and cached in the volume. The pull is a
documented first-run cost, not a silent one: the spec must state the size a
contributor is about to download before they run the command.

`OLLAMA_BASE_URL` defaults to `http://localhost:11434/v1` for a host-run agent and
`http://ollama:11434/v1` inside compose. Both appear in `.env.example`, commented,
alongside the existing providers (spec 003).

## Verification

- `docker compose --profile local-model up` reaches `/health` 200, and the
  `ollama` service reports the model in `GET /api/tags`. A container that is up
  but has not finished pulling is not ready, which is why the healthcheck is on
  `/api/tags` rather than the port.
- `AGENT_MODEL=ollama:<model> pnpm simulate "<a question from the demo catalog>"`
  returns a valid Dynamic Block v2 body. Expect the acknowledgement rather than an
  answer — that is the race behaving as specified above, not a failure.
- The deferred reply arrives in `outbox` and the worker drains it.
- `AGENT_MODEL=ollama:<model> pnpm eval` runs. Report the pass rate **and** the
  `schema_invalid` count, and label both as local-model figures.
- A unit test asserts `estimateCostUsd` returns exactly `0` for an `ollama:` spec.
  This is the only part of this spec that CI can enforce.
- `AGENT_MODEL=ollama:llama3.1:8b` resolves, proving the first-colon split.

**What this verification misses:** all of it except the pricing test is manual.
CI cannot pull multi-gigabyte weights or run a model at usable speed on a hosted
runner, so CI stays on `mock:demo` and nothing here is protected from regression
by a job. A contributor running through this list is the enforcement, which is
why the list is written to be followed rather than summarised.
