# ADR-0026 — The TypeScript model layer moves to LangChain.js, behind the same registry and port

**Status:** accepted · **Date:** 2026-10-22

## Context

ADR-0025 makes Python a second implementation of this agent, on LangChain and
LangGraph, in its own repository, and none of it is written yet. `026` lists the
LangChain defaults that would change behaviour on the way: retries, timeouts,
provider inference from a bare model name, tracing that ships prompts to a
vendor. As it stands, every one of them is discovered and pinned for the first
time inside a new codebase, where nothing else is known to work either. Moving
the TypeScript service onto LangChain.js first rehearses that: the same
concepts (structured output, a model's retry and timeout options, a graph's
recursion limit) get pinned and tested against a service whose behaviour is
already fixed by specs and asserted by tests, so a parity failure in the Python
implementation has one cause instead of many.

The reflexive choice is to stay on the Vercel AI SDK, and its case is strong: it
is verified. The abort path that keeps a turn inside C7, the two retries inside
that abort, the nested `usage` shape budget enforcement reads, and the mock
model behind `pnpm dev`, `pnpm eval:mock` and the test suite are all built and
tested against the AI SDK. A swap re-opens the 10-second budget to failures
that do not show up as errors: a provider wrapper that ignores the abort signal
still returns a reply, just after ManyChat has given up. The swap buys no
feature the agent lacks.

The rehearsal value was chosen, not measured. Nobody has counted how much of
`026` a TypeScript migration would actually settle for the Python one.

## Decision

`src/agent/registry.ts` resolves `AGENT_MODEL` to a LangChain.js chat model and
remains the only module that imports a provider package (C2); the `AgentRunner`
implementation produces the `AgentReply` through LangChain.js instead of
`generateText`.

## Consequences

- The concepts `026` pins in Python are pinned in TypeScript first, against a
  tested service, and the pins reach the Python implementation as known
  answers.
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
  AI SDK, so `registry.ts` imports from both libraries for as long as that
  holds. ADR-0025 keeps the TypeScript service indefinitely, so this is not a
  phase that ends on its own.
- Cost: no capability is added. The migration is paid for by what it settles
  for the Python implementation, and by nothing else.
- Amends ADR-0002 for the TypeScript service. Its rule that only the registry
  imports providers stands.
- Revisit if the Python implementation of ADR-0025 is frozen or archived by
  that ADR's own trigger, or abandoned before it is written. Without a Python
  implementation to rehearse for, the AI SDK's tested path wins again, and an
  unfinished migration should be reverted rather than finished.
