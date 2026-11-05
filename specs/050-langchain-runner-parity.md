---
status: implemented
implemented: 2026-10-23
pr: 263
constitution: [C1, C2, C3, C4, C5, C6, C7, C8]
adr: [0026, 0027, 0025, 0001, 0010, 0016, 0019]
---

# 050 — LangChain Runner Parity

Defines what the TypeScript service keeps while ADR-0026 moves its model layer
to LangChain.js and ADR-0027 draws its tool loop as a LangGraph.js graph: the
defaults it sets, the graph, the test seam, the public exports, and the gate
before the AI SDK runner is deleted. It leaves out transcription (`020`) and
the learning analyst (`031`), which stay on the AI SDK; the Python
implementation (`026`); and any new feature.

## The runner changes no behaviour a spec here fixes

The reflexive migration is "use LangChain.js the way its documentation does":
`initChatModel` with a `provider:model` string, `createReactAgent` with a
`ToolNode`, a checkpointer for memory, LangSmith for traces, and each provider
class with the options it comes with. Every one of those is idiomatic, and
every one changes something `002`, `012` or the Constitution fixes. A runner
built that way would read well and fail the specs it replaces.

`026` met the same move in Python with a rule. This spec applies it here:

> **The LangChain runner changes no behaviour a spec in this repository fixes.**
> Every framework option that behaviour depends on is set explicitly, and a
> default is kept only where no spec is touched by it.

The parity target is `GenerateTextRunner` at the commit the gate (§ Two
runners ship side by side) runs against.

## Defaults that change behaviour are set, and each setting has a test

Read on 2026-10-23 from the tarballs on npm: `@langchain/core` 1.3.0,
`@langchain/langgraph` 1.5.2, `langchain` 1.5.19, `@langchain/anthropic` 1.6.0,
`@langchain/openai` 1.7.0, `@langchain/google-genai` 2.3.4, `@anthropic-ai/sdk`
1.1.0.

| Default, as read                                                                                                                                                                                                                                                                                                                                       | Breaks                                                                                     | Required                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AsyncCaller` retries 6 times (`maxRetries ?? 6`). The Anthropic and OpenAI wrappers build their SDK clients with `maxRetries: 0`, so the 6 are LangChain's                                                                                                                                                                                            | Parity: the AI SDK retries twice, inside the abort                                         | `maxRetries: 2` on every chat model the registry builds                                                                                                                                                                |
| A 429 whose `Retry-After` is at most 60 000 ms is waited out and retried (`RETRY_AFTER_AUTO_RETRY_THRESHOLD_MS`). The Anthropic wrapper calls the caller with `maxRetries` only, so that wait does not listen to the abort signal                                                                                                                      | C7, `002 § Latency budget`: the abort fires at 30 000 ms and the turn settles then         | The runner races the graph against its own abort signal, so a pending backoff never holds the turn open. A test answers 429 with `Retry-After: 30` and asserts it settles                                              |
| The Anthropic SDK times a request out after 600 000 ms (`DEFAULT_TIMEOUT`). `ChatOpenAI.timeout` is `undefined`, leaving its SDK's default, not read here. No Google timeout was found                                                                                                                                                                 | C7                                                                                         | The whole run is under one signal at `MODEL_ABORT_MS`, passed to every graph invocation and from there to every model call. No per-provider timeout is relied on                                                       |
| The Anthropic and OpenAI wrappers pass `options.signal` to their SDK request. The Google wrapper's `completionWithRetry` passes it to `generateContent`, but its `_generate` calls `completionWithRetry(request)` without the call options, so a Gemini request is abandoned on the abort, not cancelled (found by this spec's abort test, 2026-10-23) | ADR-0001: an aborted call stops                                                            | Kept for Anthropic and OpenAI. The registry's Gemini model hands the call's signal to `completionWithRetry` itself. Asserted per provider: a test aborts mid-request and checks the fetch's own signal reads `aborted` |
| Tracing turns on when any of `LANGSMITH_TRACING_V2`, `LANGCHAIN_TRACING_V2`, `LANGSMITH_TRACING` or `LANGCHAIN_TRACING` is `"true"`, and sends each run's inputs and outputs                                                                                                                                                                           | C5; C1's tenant prompt and catalog would reach a vendor                                    | Boot refuses to start while any of the four is `"true"`. The turn's only trace is `052`'s projection, opted into with `TRACE_TURNS`                                                                                    |
| `LANGCHAIN_VERBOSE="true"` attaches a handler that prints every run to stdout, past the logger                                                                                                                                                                                                                                                         | C5                                                                                         | Boot refuses to start while it is `"true"`                                                                                                                                                                             |
| `initChatModel` loads the provider package with a dynamic `import()`; knows `google-genai`, not `google`; infers `google-vertexai` from a bare `gemini…`; with no model, makes `model` and `modelProvider` configurable at call time                                                                                                                   | C2 (a dynamic import escapes an import lint); C4 (no inbound field alters model selection) | Never used. See § The registry builds each chat model by its class                                                                                                                                                     |
| `withStructuredOutput` picks its method per provider: `functionCalling` on Anthropic, a per-model choice on OpenAI, unset on Google                                                                                                                                                                                                                    | C3: one schema, validated the same way whatever the provider                               | The reply is validated by the runner against `AgentReplyForModel` (§ The graph has three nodes), not trusted to the method; the method, where used, is set per provider                                                |
| Anthropic's `maxTokens` defaults per model (`defaultMaxOutputTokensForModel`)                                                                                                                                                                                                                                                                          | Parity: `maxOutputTokens` from `RunnerOptions`                                             | `maxTokens` set from `maxOutputTokens` on every provider                                                                                                                                                               |
| Prompt caching is opt-in per content block (`cache_control`); `GenerateTextRunner` sets it through `providerOptions.anthropic`                                                                                                                                                                                                                         | Cost parity; the budget counts cache reads                                                 | The system message's last block carries `cache_control: { type: 'ephemeral' }` on Anthropic. A test reads the request body                                                                                             |
| LangGraph's `recursionLimit` is 25 (`DEFAULT_RECURSION_LIMIT`) and counts supersteps, not model steps                                                                                                                                                                                                                                                  | `012 § The loop is bounded at four steps`                                                  | The step counter in graph state is the cap; `recursionLimit` is set on every invocation to the supersteps `MAX_STEPS` allows, and hitting it fails closed                                                              |
| `ToolNode` runs one step's tool calls with `Promise.all`                                                                                                                                                                                                                                                                                               | `012`: actions are staged in order, and the ninth is the one dropped                       | No `ToolNode` and no prebuilt agent (ADR-0027)                                                                                                                                                                         |

A default observed here is a fact about one version, and Renovate (`011`)
changes versions. Each setting is therefore a test that reads the configured
value or the request it produces, not a comment saying what the default was.

## The registry builds each chat model by its class

`src/agent/registry.ts` splits `AGENT_MODEL` on its first `:` itself and
constructs `ChatAnthropic`, `ChatOpenAI` or `ChatGoogleGenerativeAI` directly.
`ollama:` is a `ChatOpenAI` pointed at `OLLAMA_BASE_URL`, as today's registry
points `createOpenAI` there. `mock:` is the mock of § The mock answers as
today's mock provider does. An unknown provider fails boot, as it does now.

C2 says a lint rule enforces it. None was found on 2026-10-23: no ESLint rule
and no test name a provider package. This migration adds one. ESLint's
`no-restricted-imports` rejects `@ai-sdk/anthropic`, `@ai-sdk/openai`,
`@ai-sdk/google`, `@langchain/anthropic`, `@langchain/openai`,
`@langchain/google-genai` and `langchain/chat_models/universal` everywhere but
`registry.ts`, and a test asserts the rule is configured.

## The graph has three nodes and a step counter

The graph is `026 § The bounded loop is a graph the service draws, not a
prebuilt agent`, drawn in TypeScript:

1. **`model`** calls the model with the turn's tools bound and adds one to the
   counter. A response with no tool calls must be the reply, and ends the
   graph. A response with tool calls goes to `tools`.
2. **`tools`** handles the calls one at a time, in the order of `tool_calls`.
   A write stages on the `ActionStage` (ADR-0010). `send_flow` on an inbound
   turn is sent through `FlowSends` (ADR-0019). A read is performed through
   `ContactReads` or the plugin reads (ADR-0016). Then back to `model`, unless
   the counter has reached `MAX_STEPS` less one.
3. **`reply`** offers no tools, sees the staged notice `runner.ts` builds today
   in `prepareStep`, and must produce the reply. A tenant with no tools gets
   this node alone: one model call.

`MAX_STEPS`, `MAX_ACTIONS_PER_TURN` and `MAX_READS_PER_TURN` are imported from
where they live now (4, 8 and 2), not restated. The tool names, descriptions
and parameter schemas `buildTools` produces are the ones the model sees, byte
for byte. The `ActionStage` belongs to the caller, never to graph state: an
aborted turn returns no state, and `012` still records what it staged as
`discarded`. No checkpointer is compiled into the graph; history is read from
`turns` as now (`018`).

A call to a tool the turn did not offer, input that fails a tool's schema, and
a tool that throws each answer the model with the AI SDK's own error text
(`NoSuchToolError`, `InvalidToolInputError`, the thrown error), and the loop
goes on, as `generateText` does. None of them fails the turn by itself.

Whatever the node, the reply's text is parsed against `AgentReplyForModel` by
the runner, and then passes `applyGuardrails` exactly as now (C3).

## Every exception from the graph fails closed, and the abort is rethrown

An exception from the graph, `GraphRecursionError` and a schema failure
included, returns the tenant's escalation with `low_confidence`, and
`modelError` names the error, as `GenerateTextRunner` does. Hitting the
recursion limit is never a reason to raise it. An abort is rethrown, so the
turn handler still tells "too slow" from "misbehaved" (ADR-0001, C6).

## Usage, cost and caching come out the same

Token counts are read from each model message's `usage_metadata` and summed
over the run: `input_tokens`, `output_tokens` and
`input_token_details.cache_read`. They fill the same `AgentUsage` fields, so
`estimateCostUsd`, the budget caps and the learning reports read the same
numbers for the same request. They are summed as `generateText` sums its
steps: a step that leaves a count out adds nothing to it, and the count is
`undefined` only when no step reports it, never zero. A provider that reports
a cache read on some steps only (Gemini sets it only when the cache was hit)
still has the reads it did report counted.

## The mock answers as today's mock provider does

`mock:` resolves to today's mock provider, unchanged, wrapped in
`AiSdkChatModel` (`src/agent/ai-sdk-chat-model.ts`): a LangChain.js chat model
that sends an AI SDK model the request `generateText` would build from the same
turn. It produces the same canned replies for the same inputs. The check is
that `pnpm eval:mock` on each of CI's three suites gives the same outcome, case
for case, under both runners.

Tests still fake only the model and the ManyChat boundary (`004`), and the
fakes stay AI SDK models: the LangChain runner wraps them in the same adapter,
which reports their counts as `usage_metadata` and passes the abort through.
So a fake honours the contract it stands in for under either runner.

## The public exports keep their signatures

Tenant projects depend on `manychat-ai-agent/testing` (`033`), and plugins on
the plugin API (`036`). Both carry AI SDK types today: `mockModel` records
`LanguageModelV4CallOptions`, `buildTools` returns a `ToolSet`, and plugin
tools are built with the AI SDK's `tool`. While both runners ship, each export
keeps its signature, and the LangChain runner adapts them internally.
Removing the AI SDK types from them is a breaking change, released as one
(`010`), after the gate.

## Two runners ship side by side, and the old one goes only after the gate

`AGENT_RUNNER` selects the runner: `ai-sdk` (the default) or `langchain`. Any
other value fails boot. The default moves to `langchain` only when all three
hold, each recorded in the pull request that moves it, with its date:

1. `pnpm eval:mock` gives the same outcome on every case of CI's three suites
   under both runners.
2. A real-model `pnpm eval` on `evals/golden` passes no fewer cases under
   `langchain` than under `ai-sdk`, on the same model, run the same day.
3. Over the first week with `langchain` as the default in production, the share
   of model turns recorded `deferred` is no higher than in the week before.

The third can only be read after the switch, which is why the AI SDK runner is
deleted in a later pull request than the one that moves the default, and only
once that week is read. If it fails, the default moves back, an environment
change and a restart.

Superseded on 2026-10-24 by § The AI SDK runner is removed.

These thresholds were chosen, not measured. "No fewer" and "no higher" carry no
margin because a real-model eval run once is noisy, and a margin would let a
regression through on noise. A disagreement is read by a person before
anything moves.

## The AI SDK runner is removed

On 2026-10-24 the owner removed `GenerateTextRunner` before the gate closed,
while running `AGENT_RUNNER=langchain` on their own deployment. The gate stood
at:

1. Mock parity: met, in #263.
2. Real-model eval on `evals/golden` under both runners: not run.
3. A week of the production deferred share with `langchain` as the default: not
   read.

So nothing here measured that the LangChain runner passes as many real-model
cases, or loses the race no more often. That deployment is the evidence, and a
regression found there has no runner to switch back to: the fix is a patch to
`LangGraphRunner`, or pinning the release before this one.

What changes:

- `LangGraphRunner` is the only runner, and `createRunner` takes no kind.
- `AGENT_RUNNER` is read only to refuse `ai-sdk`, or any value but
  `langchain`. A deploy that still names the old runner fails boot rather than
  switching runner unannounced (C6). Unset and `langchain` both boot.
- The turn's `agent-turn` telemetry span went with `generateText`, and
  `RunnerOptions.recordPromptsInTraces`, which only that span read, is
  deleted. With no span, no prompt reaches a collector (C5). The trace `052`
  adds carries no prompt either.
- Tests that ran under both runners run under `langchain`. The ones that
  compared the two now assert the LangChain runner's values directly.

What stays on the AI SDK: transcription (`020`), the learning analyst (`031`),
the eval judge (`016`), the mock provider and every test fake, which
`AiSdkChatModel` wraps, and the AI SDK types on the public exports. Removing
those types is still the separate breaking change § The public exports keep
their signatures describes.

## Verification

- **Retries, tokens, the abort and tracing**: one test per row of § Defaults
  that change behaviour, reading the configured value or the request body.
- **The 429 backoff**: a faked provider answers 429 with `Retry-After: 30`; the
  test asserts the run settles within 100 ms of the abort.
- **Provider abort**: per provider, a request in flight at the abort has its
  fetch signal `aborted`.
- **C2**: a test asserts the import rule is configured and lists the packages
  above; lint fails on a provider import outside `registry.ts`.
- **Boot refusals**: each tracing variable and `LANGCHAIN_VERBOSE` set to
  `"true"` stops boot.
- **The graph**: ordered staging, the action cap, the read cap, the last step
  offering no tools, `GraphRecursionError` failing closed, and an aborted turn
  recording its stage `discarded`. The existing `012`, `024` and `029` tests
  run against `LangGraphRunner`.
- **Usage**: a faked turn whose steps report counts gives their sum, a step
  that leaves one out does not zero it, and a missing `usage_metadata` gives
  `undefined`.
- **The gate**: superseded; § The AI SDK runner is removed records where it
  stood.
- **The removal**: `AGENT_RUNNER=ai-sdk` and any value but `langchain` stop
  boot with a message naming this spec; unset, empty and `langchain` boot.

What this misses:

- **New defaults.** A setting's test catches a set value that changed. It does
  not catch an option a new version adds. Reading the changelog of each
  LangChain.js update is the check, and review is the enforcement.
- **What the read did not find.** The OpenAI SDK's own timeout and any Google
  timeout were not read. The first read also missed that the Gemini wrapper
  drops the signal on its non-streaming path; the abort test found it. The single abort covers them, and the per-provider
  abort test is what shows it.
- **Identical requests.** Two SDKs do not send byte-identical requests: message
  conversion and structured-output mode differ. Real-model evals can disagree
  for that reason alone. The mock comparison is exact; the real-model one is
  read by a person.
- **Production latency.** The eval measures one machine with no webhook,
  database or ManyChat in the path. The deferred share in gate item 3 is the
  only latency measure here, and it is read after the switch.
