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

The main reason to end that state is ADR-0026's own: the Python implementation
of ADR-0025 is about to be written, on LangChain alone. ADR-0026 moved the turn
so its concepts would be pinned against a tested service first. The pieces
still on the AI SDK (structured output for the judges and the analyst, a
LangChain.js fake that honours the abort and reports `usage_metadata`, a
transcription call with no LangChain counterpart) are concepts the Python
implementation needs as well, and they have not been rehearsed.

The two-library state also costs something of its own, though no incident has
come from it:

- Two libraries' defaults to reread when Renovate (`011`) updates them. On the
  inbound turn, only transcription still runs on the AI SDK: the judges and the
  analyst are offline, and the mock runs only in development and CI. So the
  doubled C7 surface is one call, not the whole model layer.
- The turn runs on LangChain.js, but every test of it drives an AI SDK fake
  through `AiSdkChatModel`, an adapter that exists only so the fakes need not
  change. The seam `004` says to mock is the model; the tests mock a model of
  the other library and translate.
- Tenant projects inherit the AI SDK through the `testing` export, so a tenant
  repository carries `ai` as a dependency of its own to use a schema helper.

The reflexive choice is to leave it as it is: each remaining use works, is
tested, and moving it buys no feature. Without a Python implementation coming,
that would be the right call: the costs above are real but small, and the
breaking release below is not.

## Decision

The TypeScript service drops `ai` and every `@ai-sdk/*` package, from
dependencies and devDependencies alike. Tools, the judges, the analyst, the
mock and the fakes move to LangChain.js. Transcription, which LangChain.js does
not offer, becomes a port of our own that `registry.ts` implements with the
provider's own SDK (`openai` today). The `testing` export changes shape once,
as a breaking release. `053` is the detailed form.

## Consequences

- The Python implementation starts with structured output, fakes and
  transcription pinned against a tested service, as ADR-0026 intended for the
  turn.
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
- Cost: transcription loses the AI SDK's provider abstraction. OpenAI and
  Ollama keep transcribing through the one `openai` client; Google
  transcription (`google:` in `TRANSCRIPTION_MODEL`), which the AI SDK offers
  today, is dropped in the breaking release, and a deployment using it fails
  boot until it moves to an `openai:` model. It is unpriced here and billed at
  the fallback rate, so no tenant is known to rely on it, but that is not
  measured. Adding a transcription provider later means another SDK in
  `registry.ts`, not a registry entry.
- Amends ADR-0026 where it keeps the AI SDK for transcription, the analyst, the
  judges, the mock and the public types. Its reason for moving to LangChain.js
  stands.
- Revisit if ADR-0026's own trigger fires (the Python implementation is frozen
  or abandoned): then the AI SDK's tested path wins again, and this migration,
  if unfinished, is reverted with it.
