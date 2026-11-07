# ADR-0030 — The AI SDK leaves the TypeScript service

**Status:** accepted · **Date:** 2026-11-07

## Context

ADR-0026 moved the TypeScript model layer to LangChain.js and named what would
stay on the Vercel AI SDK: transcription (`020`), which has no LangChain.js
counterpart, and, by `050 § The AI SDK runner is removed`, the learning analyst
(`031`), the eval judges (`016`, `043`), the mock provider, every test fake and
the AI SDK types on the `manychat-ai-agent/testing` export. ADR-0026 recorded
the cost: `registry.ts` imports from both libraries, and "this is not a phase
that ends on its own".

That state has been read for two weeks, and its cost is larger than the one
line ADR-0026 gave it:

- Every fact C7 depends on is held twice. Retries, the abort and usage
  accounting are pinned for LangChain.js in `050`'s table, and the same facts
  for the AI SDK live in the paths `050` did not move. Renovate (`011`) moves
  both libraries, so both sets of defaults have to be reread on every update.
- The turn runs on LangChain.js, but every test of it drives an AI SDK fake
  through `AiSdkChatModel`, an adapter that exists only so the fakes need not
  change. The seam `004` says to mock is the model; the tests mock a model of
  the other library and translate.
- Tenant projects inherit the AI SDK through the `testing` export, so a tenant
  repository carries `ai` as a dependency of its own to use a schema helper.

The reflexive choice is to leave it as it is: each remaining use works, is
tested, and moving it buys no feature. That was right while ADR-0026's
rehearsal was unfinished. With `LangGraphRunner` the only runner, the AI SDK no
longer runs any part of a customer's turn except transcription, and keeping it
means keeping a second library's defaults for that one call.

## Decision

The TypeScript service drops `ai` and every `@ai-sdk/*` package, from
dependencies and devDependencies alike. Tools, the judges, the analyst, the
mock and the fakes move to LangChain.js. Transcription, which LangChain.js does
not offer, becomes a port of our own that `registry.ts` implements with the
provider's own SDK (`openai` today). The `testing` export changes shape once,
as a breaking release. `053` is the detailed form.

## Consequences

- One model library's defaults to pin and reread. `050`'s table becomes the
  whole list, plus the transcription client's rows in `053`.
- Tests mock the library the service runs on. `AiSdkChatModel` is deleted, and
  a fake honours the LangChain.js chat model contract directly.
- C2 now covers a package that is not a chat model: `openai` joins the
  restricted imports, because the transcription client is a provider package.
- Cost: the 856-line mock provider is rewritten, and `pnpm eval:mock` is the
  check that the rewrite answers as the old one did.
- Cost: a breaking release. Every tenant project that uses `mockModel`,
  `mockTranscriptionModel` or `buildTools` changes its tests, and the tenant
  repository's own `ai` dependency goes with them.
- Cost: transcription loses the AI SDK's provider abstraction. Adding a second
  transcription provider means a second SDK in `registry.ts`, not a registry
  entry. Only OpenAI models are priced for transcription today, so nothing is
  lost now.
- Amends ADR-0026 where it keeps the AI SDK for transcription, the analyst, the
  judges, the mock and the public types. Its reason for moving to LangChain.js
  stands.
- Revisit if ADR-0026's own trigger fires (the Python implementation is frozen
  or abandoned): then the AI SDK's tested path wins again, and this migration,
  if unfinished, is reverted with it.
