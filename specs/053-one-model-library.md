---
status: specified
constitution: [C2, C3, C7, C8]
adr: [0026, 0030]
---

# 053 — One Model Library

Defines how the TypeScript service stops depending on the Vercel AI SDK
(ADR-0030): what replaces each remaining use of `ai` and `@ai-sdk/*`, what the
public `manychat-ai-agent/testing` export becomes, and the order the change
ships in. It leaves out the turn runner's graph and model calls, which `050`
already moved (the AI SDK types and helpers the runner still imports are in
scope); the Python implementation (`026`); and any new behaviour. Nothing a
customer sees changes; the one change an operator sees is § Google
transcription is dropped.

## Rejected: keep the AI SDK wherever LangChain.js has no counterpart

The default is the one ADR-0026 took: move what LangChain.js covers and leave
the rest. Each piece left behind works and is tested, so each looks free to
keep. For the Python implementation of ADR-0025 it is not: structured output,
a fake that honours the abort, and a transcription call LangChain has no
counterpart for are concepts that implementation needs, and ADR-0026 moved the
turn so such concepts would be pinned against a tested service first. Each
piece left behind is one not rehearsed. The service also keeps a second
library's defaults to reread on every Renovate (`011`) update, though on the
inbound turn only transcription still runs on it.

> **The service depends on one model library.** Where LangChain.js offers no
> counterpart, the gap is filled by a port of our own, implemented in
> `registry.ts` with the provider's own SDK, never by keeping the AI SDK for
> one call.

`050`'s rule still holds for everything this spec moves: it changes no
behaviour a spec here fixes, and every default that behaviour depends on is set
explicitly and tested.

## What moves, and to what

| Use today                                                                                                                                                                                          | Files                                                                                                                                          | Becomes                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider resolution: `createProviderRegistry`; `resolveModel`'s `LanguageModel` return type; `JSONSchema7` from `@ai-sdk/provider` on `replyFormat` and `openAiReplyFormat`                        | `src/agent/registry.ts`                                                                                                                        | The chat model classes `050 § The registry builds each chat model by its class` already constructs. `resolveModel` returns the LangChain.js chat model in step 1, with the judges and analyst that receive it (the mock is wrapped until step 2). The reply format takes the JSON Schema type `z.toJSONSchema` returns, carrying the bytes § Tools are LangChain tools pins |
| Tool definitions: `tool()`, `ToolSet`, `asSchema` (tool inputs and the reply schema `AgentReplyForModel`)                                                                                          | `src/agent/tools/*.ts`, `src/plugins/plugins.ts`, the runner                                                                                   | `tool()` from `@langchain/core/tools` (§ Tools are LangChain tools)                                                                                                                                                                                                                                                                                                         |
| Runner types: `ModelMessage`, `LanguageModel`                                                                                                                                                      | `src/agent/runner.ts` (history, nudge and reply-notice messages; `PreparedTurn.messages`; the `model` option), `src/agent/langgraph-runner.ts` | LangChain.js messages, so `toLangChainMessages` goes; the `model` option becomes the LangChain.js chat model in step 3, with the fakes                                                                                                                                                                                                                                      |
| Transcription: `transcribe()`, `TranscriptionModel`                                                                                                                                                | `src/agent/transcriber.ts`, `src/server.ts`                                                                                                    | A port the registry implements (§ Transcription is a port)                                                                                                                                                                                                                                                                                                                  |
| Judges and analyst: `generateText` + `Output`                                                                                                                                                      | `src/evals/judge.ts`, `src/evals/conversations/judge.ts`, `src/learning/analyst.ts`                                                            | `withStructuredOutput`, re-parsed by us (§ The judges and the analyst validate their own output)                                                                                                                                                                                                                                                                            |
| The mock provider and `AiSdkChatModel`                                                                                                                                                             | `src/agent/mock-provider.ts`, `src/agent/ai-sdk-chat-model.ts`                                                                                 | One LangChain.js chat model; the adapter is deleted (§ The mock and every fake)                                                                                                                                                                                                                                                                                             |
| Public test helpers                                                                                                                                                                                | `src/testing/model.ts`, `src/testing/index.ts`                                                                                                 | § The testing export changes shape once                                                                                                                                                                                                                                                                                                                                     |
| Error classes: `NoSuchToolError`, `InvalidToolInputError`, `NoObjectGeneratedError`, `NoTranscriptGeneratedError`, `TypeValidationError` (its `wrap` text is part of today's invalid-input answer) | runner, analyst, transcriber                                                                                                                   | Our own checks; the text the model sees is § Tools are LangChain tools' concern                                                                                                                                                                                                                                                                                             |

## Tools are LangChain tools, and the model sees the same bytes

Built-in tools, plugin read tools and plugin write tools are built with
`tool()` from `@langchain/core/tools`, their input schemas still Zod. The name,
description and JSON schema each tool presents to the model are the ones
`buildTools` produces today, byte for byte: the schema is derived from the same
Zod object, and a difference in how the two libraries convert Zod to JSON
Schema is a finding, not an accepted drift. The same holds for the reply: the
JSON schema the runner derives from `AgentReplyForModel` for the structured
reply, which every customer reply is shaped by, stays byte for byte as today.

`050 § The graph has three nodes` keeps its error behaviour: a call to a tool
the turn did not offer, input that fails the tool's schema, and a tool that
throws each answer the model and the loop goes on. The text of those answers is
today's, now written by the runner rather than taken from the AI SDK's error
classes, so a model that read them before reads them unchanged.

Plugins declare tools as data (`036`) and never saw an AI SDK type, so the
plugin API does not change.

## Transcription is a port the registry implements with the provider's SDK

LangChain.js has no transcription model. The `Transcriber` port in
`src/media/port.ts` stays as it is; what changes is behind it.
`resolveTranscriptionModel` in `registry.ts` returns a `Transcriber` built on
the `openai` package's `audio.transcriptions.create`, for two providers:

| Provider     | Today (AI SDK)                                                                  | After                                                                                                                |
| ------------ | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `openai:`    | `@ai-sdk/openai` `transcription()`                                              | The `openai` client                                                                                                  |
| `ollama:`    | `createOpenAI` at `OLLAMA_BASE_URL`                                             | The same `openai` client, constructed with `baseURL: OLLAMA_BASE_URL`, as `050`'s registry points `ChatOpenAI` there |
| `google:`    | `@ai-sdk/google` `transcriptionModel()`, which calls Gemini's transcription API | **Dropped.** Fails boot with `UnknownProviderError` naming `TRANSCRIPTION_MODEL` (§ Google transcription is dropped) |
| `anthropic:` | Fails boot: Anthropic does not transcribe                                       | Fails boot, unchanged                                                                                                |

`openai` reaches the service today only through `@langchain/openai`, and
pnpm's strict layout does not let `src/` import a transitive dependency. It
becomes a direct dependency in `package.json`, at the version
`@langchain/openai` resolves, so one copy of the client is installed and
Renovate (`011`) moves both together.

The client's defaults are set, each with a test, as `050` sets the chat models':

| Setting         | Required                                                                                            | Why                                             |
| --------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `maxRetries`    | `2`, the AI SDK's count today                                                                       | Parity, inside the abort                        |
| `signal`        | The turn's abort signal, passed on every request                                                    | C7; `020`: transcription is killed by the abort |
| `timeout`       | Not relied on. No new timeout is introduced (`020`); the abort bounds the call                      | C7                                              |
| Response format | Asks for the duration where the model returns one, so `transcriptionCostUsd` bills measured seconds | The daily budget cap (`020`)                    |

An empty transcript is still not a failure: the contact's note had nothing in
it, and the turn goes on with empty text, as it does when the AI SDK throws
`NoTranscriptGeneratedError` today. Any other error is a `MediaFailure` with
stage `transcription`. Where the duration is missing, the bytes are billed at
the same pessimistic 1000 bytes per second. `transcriptionCostUsd` and its
price table do not change.

The response is parsed with a Zod schema before its text is read (C3): it is an
external boundary like any other.

## Google transcription is dropped, and that is the one behaviour this changes

A deployment with `TRANSCRIPTION_MODEL=google:…` boots today: `@ai-sdk/google`
implements a transcription model over Gemini's transcription API. After this
spec it fails boot. That is a breaking change for the operator, not a silent
one for a customer: the deploy stops, it does not start sending voice notes to
`rules.messages.mediaFallback`.

Rejected: keeping it. No Google SDK the service already depends on offers
transcription, so keeping it means either a hand-written client for an API no
spec here has read, or a further provider package under C2, for one model.
Nothing in this repository prices it (`transcriptionCostUsd` bills it at the
fallback rate), and OpenAI is the documented transcription path (`020`). A
tenant on `google:` moves to an `openai:` model before upgrading.

So `google:` transcription stays on the AI SDK through steps 1 and 2 of § The
order it ships in, and goes in step 3, the breaking release. Its release notes
name it beside the `testing` export changes.

## The judges and the analyst validate their own output

The eval judge (`016`), the conversation judge (`043`) and the learning analyst
(`031`) call the chat model the registry builds, with `withStructuredOutput`
and `includeRaw: true`. The method is set per provider, as `050` sets it for
the reply; it is never left to the wrapper's choice.

The result is not trusted to the method. Each caller parses it with its own Zod
schema (`AnalystOutput`, the judge's verdict), and each keeps what it does
today when the model's output cannot be parsed:

| Caller                | Today                                                                                                                                                                                                                                     | After                                                                                                                                                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Analyst (`031`)       | The AI SDK throws `NoObjectGeneratedError`; the run records `error: 'AI_NoObjectGeneratedError'` (the error's `name`) and bills the tokens on the error's `usage`. A result that parses but fails `AnalystOutput` records `InvalidOutput` | Unparseable output records `error: 'NoObjectGeneratedError'`, the name `LangGraphRunner` already gives the same case, and bills the raw message's `usage_metadata`. Output that fails `AnalystOutput` still records `InvalidOutput` |
| Judges (`016`, `043`) | A failed call is one invalid sample (`undefined`); `majority` still grades from the other samples (`016 § three samples`). Nothing is billed for it: the `catch` skips the cost                                                           | Unchanged: an invalid sample, decided by the majority, and nothing billed for it                                                                                                                                                    |

The analyst's error string loses its `AI_` prefix. That is the one change here,
made on purpose: the prefix names a library the service no longer has. The
string is logged, not matched by any code.

Retries and the abort follow `050`'s table, because these calls go through the
same registry.

## The mock and every fake are LangChain chat models

`mock:` resolves to one `BaseChatModel` that answers as today's mock provider
does: same canned replies, same tool calls, same reported counts, for the same
inputs. `AiSdkChatModel` is deleted with the provider it adapted.

The check is the one `050` used, now against the rewrite: `pnpm eval:mock`
gives the same outcome, case for case, on each of CI's four `eval:mock` runs,
before and after. One of them sets `EVAL_JUDGE_MODEL=mock:judge`, the only run
that drives the mock's judge path through the structured output this spec
moves; calibration must still refuse that judge (`016`). The pull request that
deletes the old mock records all four.

Tests still fake only the model and the ManyChat boundary (`004`). A fake is a
LangChain.js chat model that honours its contract: it reports
`usage_metadata`, returns tool calls as `tool_calls`, and rejects with an abort
error when the call's signal aborts. A fake that ignores the signal would let a
C7 test pass that production fails.

## The testing export changes shape once, as a breaking release

`manychat-ai-agent/testing` keeps its names and changes its types:

| Export                   | Today                                  | After                                                            |
| ------------------------ | -------------------------------------- | ---------------------------------------------------------------- |
| `mockModel`              | Records `LanguageModelV4CallOptions`   | Records the LangChain.js messages and tools sent                 |
| `mockTranscriptionModel` | Returns an AI SDK `TranscriptionModel` | Returns a `Transcriber`                                          |
| `hangingModel`           | AI SDK model that never answers        | LangChain.js chat model that never answers, and rejects on abort |
| `buildTools`             | Returns a `ToolSet`                    | Returns LangChain.js tools                                       |
| `ActionStage`            | Unchanged                              | Unchanged                                                        |

All of it ships in one release, marked breaking, which bumps the minor below
`1.0.0` (`010 § Before 1.0, a breaking change bumps the minor`). No release
carries half of it: a tenant project upgrades once. The release notes say what
a tenant project changes, including that a test converting a tool schema with
the AI SDK's `asSchema` uses Zod's `z.toJSONSchema` instead.

## C2's import list names the transcription client

`PROVIDER_PACKAGES` in `eslint.config.js` drops the three `@ai-sdk/*` providers
and adds `openai`, so only `registry.ts` imports the transcription client. `ai`
and `@ai-sdk/*` are restricted everywhere, with a message naming this spec, so
a stray import fails lint before it fails install.

## The order it ships in

1. Tools, the reply schema, the runner's messages and error text, judges,
   analyst and `openai:`/`ollama:` transcription move, still behind the old
   public types where a test helper needs them; `google:`
   transcription stays on the AI SDK. Each step passes CI's chain on its own.
2. The mock is rewritten, and `pnpm eval:mock` is compared case for case.
3. The fakes, `AiSdkChatModel` and the public types change, `ai` and
   `@ai-sdk/*` leave `package.json`, and the release is cut as breaking.

Steps 1 and 2 are internal and may ship in minor releases. Step 3 is the
breaking release, and the only one a tenant project has to act on.

## Verification

- **No dependency**: a test reads `package.json` and asserts neither
  `dependencies` nor `devDependencies` names `ai` or a package under
  `@ai-sdk/`.
- **C2**: the existing import-rule test lists `openai` and not `@ai-sdk/*`;
  lint fails on `openai` imported outside `registry.ts`.
- **Tool and reply schema bytes**: a snapshot of the tools bound to the model,
  taken from `buildTools` with every built-in and a fixture plugin, and of the
  JSON schema of `AgentReplyForModel` the runner sends for the reply, is
  recorded before step 1 and asserted equal after.
- **Tool errors**: an unknown tool, invalid input and a throwing tool each
  answer the model with today's text, and the turn goes on (`050`'s existing
  tests, unchanged in what they assert).
- **Transcription**: per setting in its table, a test reads the request the
  client sends: two retries, the turn's signal `aborted` on the fetch when the
  turn aborts, an empty transcript giving empty text and no failure, a
  malformed response giving `MediaFailure`, and a missing duration billed at
  1000 bytes per second.
- **Direct dependency**: the `package.json` test that asserts no `ai` or
  `@ai-sdk/*` also asserts `openai` is listed in `dependencies`.
- **Ollama transcription**: `ollama:…` resolves to the `openai` client, and a
  test reads that its request goes to `OLLAMA_BASE_URL`.
- **Google transcription dropped**: `TRANSCRIPTION_MODEL=google:…` and
  `anthropic:…` fail boot with `UnknownProviderError` naming
  `TRANSCRIPTION_MODEL`.
- **Structured output**: a fake returning unparseable output gives the analyst
  `error: 'NoObjectGeneratedError'` and a cost from the raw message's counts;
  output that parses but fails `AnalystOutput` gives `InvalidOutput`. For a
  judge, the same fake gives one invalid sample, the majority of the other two
  still grades, and the judge's `costUsd` does not grow for the invalid one.
- **The mock**: CI's four `pnpm eval:mock` runs, including `mock:judge`,
  before and after the rewrite, with the same outcome per case, recorded in
  the pull request.
- **Fakes honour the abort**: `hangingModel` rejects within 100 ms of its
  signal aborting.

What this misses:

- **Real-model parity of the judges and transcription.** Two libraries do not
  send byte-identical structured-output requests, and a judge that grades
  differently is noise or a finding only a person can tell apart. A
  real-model judge run on `evals/golden`, before and after, is read by a
  person; nothing here asserts it.
- **New defaults in `openai`.** A setting's test catches a set value that
  changed, not an option a new version adds. Reading its changelog on each
  Renovate update is the check.
- **Tenant projects.** The breaking release's notes tell a tenant what to
  change. Whether each one did is caught by its own CI on upgrade, not here.
