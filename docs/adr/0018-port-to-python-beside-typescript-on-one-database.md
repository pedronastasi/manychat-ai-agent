# ADR-0018 — The agent is ported to Python and cut over beside the TypeScript service, on one database

**Status:** accepted · **Date:** 2026-10-02

## Context

Four things push this service towards Python, and all four apply at once. The
model ecosystem this agent will grow into (evaluation tooling, retrieval,
speech, agent frameworks) is Python first. The people who will maintain it work
in Python, and hiring for it is easier in Python. The port is also portfolio
and learning work for its author. And a client requires a Python stack, which
is the one reason that is not a preference.

The reflexive answer is to stay in TypeScript, and its case is strong. The
service works, is tested, and has carried real contacts' conversations since
2026-09-26. Counted on 2026-10-02, it is 13,199 lines of TypeScript: 5,581 in
`src/` and 7,618 in `test/`, with 747 tests in 29 files. Those lines encode
decisions this repository has already argued in ADRs and specs, and a rewrite
reopens each of them to being got wrong. Nothing in the agent's behaviour is
blocked by TypeScript. The Vercel AI SDK does everything ADR-0002 asked of it,
and the port buys no feature.

The library was chosen, not measured. LangChain and LangGraph were picked for
the ecosystem and the hiring reasons above, and were not compared against
calling the provider SDKs directly or against another Python agent library.
Their defaults are wrong for this service in several places (a prebuilt agent
performs tools mid-generation, provider clients retry for minutes, tracing
ships prompts to a vendor once switched on), and `026` exists to pin them.

The obvious cutover is a big bang: build the Python service, then point
ManyChat at it. It is rejected because production carries real conversations,
and a contact's history, token and queued replies live in one Postgres
database. A second database would split them at the switch; a big bang on the
same database has no way back that does not lose turns.

## Decision

The agent is rewritten in Python on LangChain and LangGraph, with FastAPI and
Pydantic v2 for the server and contracts, and takes over traffic from the
TypeScript service by running beside it on the same Postgres schema and outbox,
moved by ManyChat webhook routing one step at a time, each step gated on the
parity defined in `026`.

- **Supersedes ADR-0002.** The model layer is LangChain's `init_chat_model`
  behind a registry module that parses the same `AGENT_MODEL` `provider:model`
  string. Only that module imports a provider package, as before.
- **Supersedes ADR-0003.** Pydantic models are the single source of truth for
  runtime validation, types and the OpenAPI document, which FastAPI generates
  from them. Inbound models forbid unknown keys, as `.strict()` did.
- **Amends C2** to name a registry module per codebase, so the rule holds in
  both while both serve traffic.

## Consequences

- Carried over unchanged in intent, and restated for Python in `026`: the race
  (ADR-0001), the Postgres outbox (ADR-0004), the channel port with one adapter
  (ADR-0005), ports as classes (ADR-0008, as abstract base classes), the
  bounded loop where writes stage (ADR-0010) and reads perform (ADR-0016),
  model-graded evals behind calibration (ADR-0011), contact tokens (ADR-0012),
  the history window and turn cap (ADR-0013), the conversation ID in logs
  (ADR-0014), the agent closing the sale (ADR-0015) and bounded notes
  (ADR-0017). ADR-0009 carries over too; whether a Python linter can enforce
  it as ESLint's `id-length` does is not settled here.
- The Constitution transfers whole. Only C2 changes its wording, and C5's
  enforcement note stops naming pino.
- TypeScript owns the schema until it is retired. The Python service runs no
  migrations against the shared database, so the two cannot write competing
  histories of one schema.
- Cost: every line counted above is rewritten, and every test that cites a
  spec clause (C8) is rewritten to cite it again. That is work with no
  behavioural gain, against code that works today.
- Cost: while both serve, any behaviour change is written twice or frozen, and
  each traffic step waits until both match. The specs already `specified` and
  not built (`023`, `024`, `025` among them) land in one codebase and must be
  matched in the other before traffic moves again.
- Cost: two services share state. Postgres holds most of it safely, and `026`
  names what does not: in-memory rate limiters, in-flight deferred turns,
  callbacks that pin a contact to whichever service answered last.
- Cost: tooling this repository leans on has no verified Python counterpart.
  PGlite runs Postgres in-process for tests and local development with no
  server; the Python tests need a real Postgres server instead. The
  `manychat-sdk` package of `022` is TypeScript. The API reference on the docs
  site (`014`) keeps coming from the Zod contracts until the docs are ported,
  which is outside `026`.
- Cost: LangChain's surface is larger than the AI SDK's, and every default in
  it that touches a spec has to be pinned and tested, then re-checked when
  Renovate updates it (`011`).
- Revisit if a behaviour change has to be implemented in both codebases more
  than twice before the cutover completes, or if the TypeScript service still
  takes traffic 60 days after the first contact moves to Python. Sixty days is
  chosen, not measured. Either means the port has become two products
  maintained in parallel, and the fallback is to stop moving traffic and keep
  TypeScript, not to hurry the rest.
