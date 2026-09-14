# ADR-0003 — Zod as the single source of truth

**Status:** accepted · **Date:** 2026-09-14

## Context

Three artifacts must agree: runtime validation of inbound requests, the
TypeScript types used in code, and the published API documentation. Maintaining
them separately guarantees they drift.

## Decision

Zod schemas in `src/contracts/` are authoritative. TypeScript types are inferred
from them (`z.infer`), and `fastify-type-provider-zod` + `@fastify/swagger`
generate the OpenAPI document from the same objects that validate at runtime.

All inbound schemas are `.strict()`.

## Consequences

- Documentation cannot drift from validation; they are the same object.
- `.strict()` turns an upstream platform change into a loud 400 rather than a
  silently ignored field — for an integration against a vendor UI we do not
  control, failing loudly is the safer default.
- Model output is validated with the same machinery as network input, which is
  what makes "model output is untrusted" (Constitution C3) mechanical.
