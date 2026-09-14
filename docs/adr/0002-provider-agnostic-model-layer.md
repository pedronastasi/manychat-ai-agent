# ADR-0002 — Provider-agnostic model layer

**Status:** accepted · **Date:** 2026-09-14

## Context

A hard requirement is that any model can be connected later. The obvious path is
calling a vendor SDK directly, which is the shortest route to a working call and
the fastest route to lock-in — vendor SDKs differ in message shape, tool schema,
streaming, and error types, so swapping one later touches every call site.

## Decision

Use the Vercel AI SDK's `createProviderRegistry` over the Anthropic, OpenAI, and
Google provider packages. The active model is a single environment variable in
`provider:model` form. No module outside `src/agent/registry.ts` imports a
provider package (Constitution C2).

Above that sits an `AgentRunner` port, so the call site depends on our interface
rather than on the SDK.

## Consequences

- Switching provider is an env edit and a restart; the diff is zero lines.
- Three provider packages are installed but only the active one's key is needed.
- The registry is also the natural seam for middleware — retries, fallback,
  telemetry — without touching callers.
- Accepts a dependency on the AI SDK's abstraction. Judged worthwhile: it is the
  most used TypeScript AI library, and the `AgentRunner` port means replacing even
  the SDK itself is contained to one module.
