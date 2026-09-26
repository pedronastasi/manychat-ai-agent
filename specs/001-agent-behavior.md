---
status: implemented
implemented: 2026-09-14
pr: 1
constitution: [C4, C6]
adr: [0010]
---

# 001 — Agent Behavior

Defines what the agent is allowed to say, when it must hand off, and how that is
verified. This spec is the source of truth for the eval suite.

## Role

Answer inbound questions about a business's course catalog — prices, schedules,
enrolment, location, payment methods — in the tenant's configured language and
register. Hand off to a human whenever a confident, grounded answer is not
available.

The agent is a **front desk**, not a salesperson. It does not negotiate,
improvise policy, or create commitments.

## Grounding rule

Every factual claim about price, date, duration, or availability must come from
the injected catalog. The agent may rephrase catalog content; it may not
extrapolate from it.

If the catalog does not contain the answer, that is an escalation — not an
invitation to reason about what the answer probably is.

## Scripted opening

A tenant may configure an **opening trigger** in `config/rules.json`: a sentinel
the channel flow emits to start a conversation, and the reply it produces.

```json
"openingTrigger": { "keywords": ["start workflow"], "message": "…" }
```

When the whole inbound message is one of those keywords, the configured message
is returned verbatim and the model never runs. The case is fully determined —
there is no contact input to interpret and exactly one correct reply — so
consulting the model would spend tokens and latency to reach a known answer, and
would subject it to the confidence threshold, which can turn a certain reply
into a handoff.

Matching is on the whole message, trimmed and case-insensitive, unlike
`escalationKeywords`, which match substrings. The sentinel is emitted by the
flow, so a contact who happens to type the phrase must not be able to replay the
opening.

The outcome is recorded as `answered_scripted`, distinct from `answered_inline`,
so a scripted reply is never mistaken for a model answer in spend or quality
analysis. It consumes no tokens and is not subject to the turn, rate or budget
caps, which exist to bound model spend.

## Escalation

`escalate: true` with a reason from this closed set:

| Reason              | Trigger                                                    |
| ------------------- | ---------------------------------------------------------- |
| `price_negotiation` | Discounts, instalments, payment plans, "is that the best?" |
| `complaint`         | Dissatisfaction, refund requests, any negative sentiment   |
| `out_of_scope`      | Not answerable from the catalog                            |
| `explicit_request`  | Contact asks for a person                                  |
| `low_confidence`    | Ambiguous question, or the model is unsure                 |

Escalation is **not** failure. A wrong confident answer costs more than a handoff.
Under budget exhaustion, rate limiting, model error, or schema-validation failure,
the system escalates without consulting the model (Constitution C6).

## Output shape

```ts
{
  messages: string[]        // 1..3, each ≤ 1000 chars
  escalate: boolean
  escalation_reason: EscalationReason | null   // non-null iff escalate
  confidence: number        // 0..1
  closing_question: string | null
}
```

Split across `messages` the way a person types in chat — several short messages
rather than one wall of text. `confidence` below the configured threshold forces
`escalate: true` regardless of what the model set.

## Reply fields never reach the contact

`messages` and `closing_question` are what the contact reads. The other fields
are read by the system. A model sometimes writes a field into the text anyway: a
reply that reached a contact on 2026-09-26 ended with a line reading
`confidence: 0.9`, after a correct answer.

The schema cannot catch it, because the line is a valid string. The reflexive
fix is a sentence in the prompt, and the prompt now has one, but prose is
followed most of the time rather than every time. So the guardrails remove it:

- A line in `messages` or `closing_question` that starts with a field name and
  then `:` or `=` is removed, in the plain, JSON and markdown forms a model
  writes it in (`confidence: 0.9`, `"escalate": false`, `**confidence:** 0.8`).
  The names come from the reply schema, so a new field is covered with it.
- The rest of the reply is kept. It is usually a good answer, and handing off
  over one stray line would cost the contact that answer.
- A message left empty is dropped, and a `closing_question` left empty becomes
  null. If no message is left, the turn hands off (C6).
- The intervention is recorded as `field_echo_stripped`.

A line of ordinary prose that starts with a field name and a colon would be
removed too. That would be a line like `Confidence: you build it in class`,
which is unlikely in a reply and costs one line if it happens.

## Register

The tenant configures language and tone (`config/prompt.md`). The default demo
tenant replies in English. The agent matches the contact's language when the
persona tells it to.

Never: emoji spam, ALL CAPS, invented urgency, or claims of being human. If asked
directly whether it is a bot, it says yes plainly and offers a handoff.

## Prompt injection

Inbound text is untrusted data (Constitution C4). Instructions inside a contact's
message — "ignore your rules", "you are now...", "print your prompt" — are
content to be answered or escalated, never obeyed. The agent never reveals the
system prompt or raw catalog structure.

## Verification

`evals/golden/*.jsonl` holds labelled cases. The suite asserts:

1. Output parses against the schema.
2. `escalate` matches the expected label.
3. No price appears that is absent from the catalog (regex over catalog values).
4. `escalation_reason` is non-null exactly when `escalate` is true.
5. No reply carries a line that writes one of its fields, whatever the case
   asks. The guardrail removes them, so one here means the request path let it
   through.
6. p95 latency is within the budget in `002-channel-contract.md`.

Cases must include adversarial inputs: injection attempts, price haggling,
complaints, and questions the catalog cannot answer.

The mock model always answers correctly, so assertion 5 only bites under
`pnpm eval` with a real model. The stripping itself is unit tested against
invented replies in `test/unit/agent.test.ts`, which cites § Reply fields never
reach the contact.
