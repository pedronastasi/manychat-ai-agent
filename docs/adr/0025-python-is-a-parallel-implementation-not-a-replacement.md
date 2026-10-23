# ADR-0025 — Python is a second implementation in its own repository, not a replacement

**Status:** accepted · **Date:** 2026-10-22

## Context

ADR-0018 decided to rewrite the agent in Python and move production traffic to
it beside the TypeScript service, on one database, until TypeScript could be
retired. Its revisit trigger already named the outcome it feared: the port
becoming two products maintained in parallel. That is now the goal rather than
the risk. The Python version exists for developers who work in Python and want
the same agent on LangChain, LangGraph, FastAPI and Pydantic. Nothing here asks
for the TypeScript service to go away, and it keeps serving every tenant it
serves today.

The reflexive shape follows ADR-0018: one repository, both codebases in it,
one Postgres schema, and traffic moved step by step through ManyChat routing.
Its strongest case is that sharing a repository and a database forces the two
to stay identical, because every spec, test and migration sits beside its twin.
It is rejected because nothing moves between the two any more. The shared
database, the outbox both workers drain, the callbacks that pin a contact to
one service and the gate on each traffic step all exist to make a handover
safe, and there is no handover. A Python developer reading a TypeScript
repository to find the Python package is the audience this is meant to serve,
served badly.

## Decision

The Python implementation lives in its own repository, ships its own package
and image, owns its own database, and is maintained alongside the TypeScript
one for as long as both have users; `specs/` in this repository stays the
behaviour both must meet.

## Consequences

- **Supersedes ADR-0018.** No traffic moves between the two, so nothing in
  ADR-0018 that exists for the cutover still applies: one shared schema, the
  outbox both workers drain, callback pinning, halved rate limits and the
  60-day retirement trigger. Its choice of LangChain, LangGraph, FastAPI and
  Pydantic v2 for the Python side stands, and so do the supersessions of
  ADR-0002 and ADR-0003 it made for that side. Both keep holding for the
  TypeScript side.
- **C2 is kept as amended by ADR-0018**, with "while both run" now meaning
  indefinitely: one registry module per codebase.
- Buys: a Python developer finds a Python project, with Python tooling,
  migrations it owns, and no TypeScript to read past. A tenant picks an
  implementation and stays on it; neither one's release waits on the other's
  traffic.
- Buys: `026` shrinks to what makes the two the same agent: pinned framework
  defaults, a mechanical module mapping, the bounded loop, and a parity gate
  each Python release passes against this repository's specs.
- Cost: every behaviour change is written twice, forever, not just during a
  cutover. A spec lands here first; the Python release that claims to match a
  given TypeScript version must implement it.
- Cost: two repositories drift silently where one would drift loudly. The
  parity gate in `026` is the only thing that notices, and it runs in the
  Python repository's CI, out of sight of a reviewer here.
- Cost: no Python code exists yet. Everything ADR-0018 counted (5,581 lines of
  `src/`, 747 tests on 2026-10-02) is still to be written, now without the
  option of stopping halfway and keeping TypeScript, because there was never a
  handover to stop.
- Revisit if the Python implementation lags the TypeScript one by more than one
  minor release for 60 days, or has no tenant running it six months after its
  first release. Both numbers are chosen, not measured. Either means the second
  implementation costs its upkeep without serving the developers it was built
  for, and the choice is then to freeze it at a named version or archive it.
