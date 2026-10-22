# ADR-0025 — The TypeScript model layer moves to LangChain.js, behind the same registry and port

**Status:** accepted · **Date:** 2026-10-22

## Context

ADR-0018 ports the agent to Python on LangChain and LangGraph, and that port is
still planned. `026` lists the LangChain defaults that would change behaviour
on the way there: retries, timeouts, provider inference from a bare model name,
tracing that ships prompts to a vendor. Today every one of them is discovered
and pinned for the first time inside a rewrite, where nothing else is known to
work either. Moving the TypeScript service onto LangChain.js first rehearses
that: the same concepts (`initChatModel`, structured output, a model's retry
and timeout options) get pinned and tested against a service whose behaviour
is already fixed by specs and asserted by tests, so a parity failure has one
cause instead of many.

The reflexive choice is to stay on the Vercel AI SDK until the Python service
replaces it, and its case is strong: it is verified. The abort path that keeps
a turn inside C7, the two retries inside that abort, the nested `usage` shape
budget enforcement reads, and the mock model behind `pnpm dev`, `pnpm eval:mock`
and the test suite are all built and tested against the AI SDK. A swap re-opens
the 10-second budget to failures that do not show up as errors: a provider
wrapper that ignores the abort signal still returns a reply, just after
ManyChat has given up. The swap buys no feature the agent lacks.

The rehearsal value was chosen, not measured. Nobody has counted how much of
`026` a TypeScript migration would actually settle for the Python one.

## Decision

`src/agent/registry.ts` resolves `AGENT_MODEL` to a LangChain.js chat model and
remains the only module that imports a provider package (C2); the `AgentRunner`
implementation produces the `AgentReply` through LangChain.js structured
output instead of `generateText`.

## Consequences

- The concepts `026` pins in Python are pinned in TypeScript first, against a
  tested service, and the pins carry over to the port as known answers.
- Callers do not change. `AgentRunner` and the registry are the seams ADR-0002
  built for exactly this, so the swap is contained to `src/agent/` and the
  model test helpers.
- Cost: the abort, retry and timeout behaviour is re-verified per provider.
  Each LangChain.js provider wrapper sets its own defaults, and every one that
  touches C7 has to be pinned and tested, as `026` does in Python.
- Cost: `test/helpers/model.ts`, the mock provider and the eval mock are
  rewritten, and token usage is read from LangChain's `usage_metadata` instead
  of the AI SDK's shape, so budget caps and cost estimates move with it.
- Cost: transcription (`020`) has no LangChain.js counterpart and stays on the
  AI SDK, so `registry.ts` imports from both libraries until the TypeScript
  service is retired.
- Cost: the model layer migrates twice, AI SDK to LangChain.js and then to
  Python, and neither migration adds a capability.
- Amends ADR-0002 for the TypeScript service; ADR-0002 is already superseded by
  ADR-0018, and its rule that only the registry imports providers stands.
- Revisit if ADR-0018 is abandoned. Without a Python port to rehearse, the AI
  SDK's tested path wins again, and the migration should be reverted rather than
  finished.
