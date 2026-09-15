# ADR-0008 — Classes implement the ports, functions transform data

**Status:** accepted · **Date:** 2026-09-15

## Context

The repository answers the same question two ways. `AgentRunner` and
`ChannelAdapter` are interfaces satisfied by factory functions —
`createAgentRunner`, `createManyChatAdapter`, `createManyChatClient` — that
close over their dependencies and return an object literal. `ConfigStore` and
`TokenBucket` are classes. Nothing has broken as a result and no incident forces
a choice, so this is a decision about consistency rather than a fix: every new
module is currently a fresh judgement call, and a codebase that answers the same
question differently each time teaches its conventions to nobody.

The reflexive choice is to keep the factory, and the case for it is strong
enough to state plainly: a factory's parameters are its constructor, its closure
is genuinely private state that no caller can reach, and it never exposes `this`
to be unbound. It already supplies most of what a class supplies, which is why
the existing code drifted toward it without anyone deciding.

## Decision

A port implementation is a class whose constructor takes its dependencies;
functions remain the form for pure transformation — `prompt.ts`,
`guardrails.ts`, `redact.ts`, and the schema contracts.

## Consequences

- Dependencies are declared in one place a reader can point at, the constructor
  signature, instead of being split between a factory's parameters and the
  variables it closes over.
- A test double declares `implements ChannelAdapter`, so the compiler names the
  port a fake is standing in for rather than matching it structurally and
  silently.
- The two components that already earn a class stop being exceptions, and the
  repo stops holding two conventions at once.
- Nothing forced this, and the rejected option provides most of the same
  guarantees. The gain is consistency and little else, while the cost is paid up
  front: `runner.ts`, `adapter.ts` and `client.ts` work today and get rewritten
  for no behavioural change, which is diff noise over tested code.
- `this` becomes a hazard the codebase did not previously have. A method passed
  as a callback loses its binding, and it fails at runtime rather than at
  `tsc`.
- Parameter properties are unavailable. The repo runs TypeScript directly under
  `node --experimental-strip-types`, so `erasableSyntaxOnly` is on and
  `constructor(private readonly db: Database)` does not compile. Every field is
  declared and assigned by hand, which is the boilerplate the factory did not
  have.
- No lint rule can express "implementations of this interface are classes", so
  unlike C2 this standard rests on review alone, and a standard that is only
  sometimes applied is worse than none.
- Revisit if the classes start growing protected helpers or a base class shared
  between adapters. That is the surface-area creep ADR-0005 exists to prevent,
  and the port stops being narrow the moment it appears.
