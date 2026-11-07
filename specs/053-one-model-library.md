---
status: specified
constitution: [C2, C3, C7, C8]
adr: [0026, 0030]
---

# 053 — One Model Library

Defines how the TypeScript service stops depending on the Vercel AI SDK
(ADR-0030): what replaces each remaining use of `ai` and `@ai-sdk/*`, what the
public `manychat-ai-agent/testing` export becomes, and the order the change
ships in. It leaves out the turn runner, which `050` already moved; the Python
implementation (`026`); and any new behaviour. Nothing a customer sees changes.

## Rejected: keep the AI SDK wherever LangChain.js has no counterpart

The default is the one ADR-0026 took: move what LangChain.js covers and leave
the rest. Each piece left behind works and is tested, so each looks free to
keep. It is not. Every piece keeps a second library's retries, abort handling
and usage shape in the service, and C7 depends on all three. `050` pinned them
for LangChain.js; the same facts for the AI SDK are pinned nowhere a spec
names, and Renovate (`011`) updates both.

> **The service depends on one model library.** Where LangChain.js offers no
> counterpart, the gap is filled by a port of our own, implemented in
> `registry.ts` with the provider's own SDK, never by keeping the AI SDK for
> one call.

`050`'s rule still holds for everything this spec moves: it changes no
behaviour a spec here fixes, and every default that behaviour depends on is set
explicitly and tested.

## What moves, and to what

| Use today                                                                                                         | Files                                                                               | Becomes                                                                                            |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Provider resolution: `createProviderRegistry`                                                                     | `src/agent/registry.ts`                                                             | The chat model classes `050 § The registry builds each chat model by its class` already constructs |
| Tool definitions: `tool()`, `ToolSet`, `asSchema`                                                                 | `src/agent/tools/*.ts`, `src/plugins/plugins.ts`, the runner                        | `tool()` from `@langchain/core/tools` (§ Tools are LangChain tools)                                |
| Transcription: `transcribe()`, `TranscriptionModel`                                                               | `src/agent/transcriber.ts`, `src/server.ts`                                         | A port the registry implements (§ Transcription is a port)                                         |
| Judges and analyst: `generateText` + `Output`                                                                     | `src/evals/judge.ts`, `src/evals/conversations/judge.ts`, `src/learning/analyst.ts` | `withStructuredOutput`, re-parsed by us (§ The judges and the analyst validate their own output)   |
| The mock provider and `AiSdkChatModel`                                                                            | `src/agent/mock-provider.ts`, `src/agent/ai-sdk-chat-model.ts`                      | One LangChain.js chat model; the adapter is deleted (§ The mock and every fake)                    |
| Public test helpers                                                                                               | `src/testing/model.ts`, `src/testing/index.ts`                                      | § The testing export changes shape once                                                            |
| Error classes: `NoSuchToolError`, `InvalidToolInputError`, `NoObjectGeneratedError`, `NoTranscriptGeneratedError` | runner, analyst, transcriber                                                        | Our own checks; the text the model sees is § Tools are LangChain tools' concern                    |

## Tools are LangChain tools, and the model sees the same bytes

Built-in tools, plugin read tools and plugin write tools are built with
`tool()` from `@langchain/core/tools`, their input schemas still Zod. The name,
description and JSON schema each tool presents to the model are the ones
`buildTools` produces today, byte for byte: the schema is derived from the same
Zod object, and a difference in how the two libraries convert Zod to JSON
Schema is a finding, not an accepted drift.

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
the `openai` package's `audio.transcriptions.create`. A `TRANSCRIPTION_MODEL`
whose provider has no transcriber here (Anthropic, Google, Ollama) fails boot
with `UnknownProviderError` naming `TRANSCRIPTION_MODEL`, as it does now.

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

## The judges and the analyst validate their own output

The eval judge (`016`), the conversation judge (`043`) and the learning analyst
(`031`) call the chat model the registry builds, with `withStructuredOutput`
and `includeRaw: true`. The method is set per provider, as `050` sets it for
the reply; it is never left to the wrapper's choice.

The result is not trusted to the method. Each caller parses it with its own Zod
schema (`AnalystOutput`, the judge's verdict) and treats a parse failure exactly
as it treats `NoObjectGeneratedError` today: the analyst records
`InvalidOutput`, a judge's group is not graded. Output that fails the schema
was still paid for, so its cost comes from the raw message's `usage_metadata`,
which the analyst reads today from the error's `usage`.

Retries and the abort follow `050`'s table, because these calls go through the
same registry.

## The mock and every fake are LangChain chat models

`mock:` resolves to one `BaseChatModel` that answers as today's mock provider
does: same canned replies, same tool calls, same reported counts, for the same
inputs. `AiSdkChatModel` is deleted with the provider it adapted.

The check is the one `050` used, now against the rewrite: `pnpm eval:mock`
gives the same outcome, case for case, on each of CI's three suites, before and
after. The pull request that deletes the old mock records both runs.

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

1. Tools, judges, analyst and transcription move, still behind the old public
   types where a test helper needs them. Each step passes CI's chain on its own.
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
- **Tool bytes**: a snapshot of the tools bound to the model, taken from
  `buildTools` with every built-in and a fixture plugin, is recorded before
  step 1 and asserted equal after.
- **Tool errors**: an unknown tool, invalid input and a throwing tool each
  answer the model with today's text, and the turn goes on (`050`'s existing
  tests, unchanged in what they assert).
- **Transcription**: per setting in its table, a test reads the request the
  client sends: two retries, the turn's signal `aborted` on the fetch when the
  turn aborts, an empty transcript giving empty text and no failure, a
  malformed response giving `MediaFailure`, and a missing duration billed at
  1000 bytes per second.
- **Structured output**: a fake returning output that fails the schema gives
  `InvalidOutput` from the analyst, an ungraded group from the judge, and a
  cost computed from the raw message's counts.
- **The mock**: `pnpm eval:mock` on CI's three suites, before and after the
  rewrite, with the same outcome per case, recorded in the pull request.
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
