---
status: standing
---

# 000 — Constitution

Non-negotiable principles for this project. Every spec, ADR, and pull request is
checked against this document. Changing a principle requires an ADR that
supersedes the relevant clause.

## C1. No tenant data in version control

No production prompt, price list, course catalog, customer message, phone
number, or credential may enter git history. Tenant configuration lives in
`config/` and `.env`, both gitignored; only `*.example` scaffolds are tracked.

_Enforced by:_ `.gitignore` + CI secret scanning.
_Rationale:_ the repository is published. Scrubbing history later is unreliable;
never committing is the only guarantee that holds.

## C2. Provider access only through the registry

No module imports `@ai-sdk/anthropic`, `@ai-sdk/openai`, or `@ai-sdk/google`
directly except `src/agent/registry.ts`. Everything else depends on the
`AgentRunner` port. The active model is resolved at runtime from configuration.

_Enforced by:_ lint rule + unit test asserting a model swap changes no source.
_Rationale:_ model-agnosticism is a hard requirement, not an aspiration. A single
direct import silently destroys it.

## C3. Every outbound message is schema-validated

No string reaches a customer without passing the `AgentReply` schema and the
active channel's capability constraints. Model output is untrusted input.

_Enforced by:_ `guardrails.ts` + renderer unit tests.

## C4. User text is untrusted data, never instruction

Inbound message text is fenced and labelled untrusted in the prompt. The catalog
and system rules are injected server-side and never echoed back. No inbound
field may alter tool availability, model selection, or system instructions.

## C5. No PII in logs or traces

Phone numbers, names, emails, and full message bodies are redacted at the logger,
not at the call site. A new log statement cannot opt out.

_Enforced by:_ pino redaction config + a test asserting known PII shapes are
scrubbed.

## C6. Fail closed, toward a human

When the agent is uncertain, over budget, rate-limited, or erroring, it escalates
to a human. It never guesses at a price, a date, or a policy. A customer waiting
for a person is an acceptable outcome; a customer quoted an invented price is not.

## C7. The 10-second budget is a hard external constraint

ManyChat terminates external requests at 10s. Any code path on the inbound
request may not exceed the budget in `002-channel-contract.md`. Work that cannot
finish in time moves to the outbox, never blocks the response.

## C8. Tests assert against specs, not implementation

Behavioral tests cite the spec clause they enforce. A spec change that breaks a
test is a real finding, not a test to update mechanically.

## C9. English in the repository, no copy in source

Everything committed is in English. Beyond that, **no customer-facing natural
language lives in source at all** - acknowledgements, escalation messages and
persona text belong to the tenant, in gitignored configuration.

_Enforced by:_ `.gitignore` for tenant config, review and a stopword check for
the rest.
_Rationale:_ hardcoded copy limits the product to one linguistic market
regardless of which language is hardcoded. See [005-language.md](005-language.md).
