---
status: specified
constitution: [C3, C4, C5, C6, C7]
adr: [0010]
---

# 012 — Agent Tools

Defines the tools the agent can call during a turn to send a tenant-built
ManyChat flow, add or remove a tag, and set a custom field, and when those calls
take effect. It deliberately leaves out any tool that reads from ManyChat
(`getInfo`, `findBy*`), page-level and account-global endpoints, creating or
updating subscribers, and MCP.

## A tool stages an action; the server performs it

The AI SDK's default tool has an `execute` that does the work: here, that would
mean calling ManyChat mid-generation. That default is rejected (ADR-0010). At
that point the model has not yet decided whether to escalate, and the guardrails
have not run, so a turn that ends in a handoff would already have sent media and
tagged the contact.

Every tool's `execute` therefore **records an action and returns
`{ staged: true }`**. No ManyChat request is made inside the model call.
Staged actions travel with the model's result and are performed only as
described below.

The model is told an action was staged, never that it succeeded. The persona
must not have it claim "I've sent it" as fact. It says what it is sending, the
way a person does before pressing send.

## Four tools, each built from tenant configuration

| Tool         | ManyChat endpoint                          | Model supplies            |
| ------------ | ------------------------------------------ | ------------------------- |
| `send_flow`  | `POST /fb/sending/sendFlow`                | a flow id                 |
| `add_tag`    | `POST /fb/subscriber/addTagByName`         | a tag id                  |
| `remove_tag` | `POST /fb/subscriber/removeTagByName`      | a tag id                  |
| `set_field`  | `POST /fb/subscriber/setCustomFieldByName` | a field id and a value id |

Each parameter is a `z.enum` built from `config/tools.json` at load, so the
model can only name something the tenant configured (C3). A tool whose list is
empty is not offered at all. The file reloads on `SIGHUP` with the rest of the
tenant config, and is added to `003-config-schema.md` in the pull request that
implements this spec. Shape, with values invented for the demo tenant:

```jsonc
{
  "flows": [
    {
      "id": "gel_course_brochure",
      "flowNs": "content00000000000000_000001",
      "description": "PDF brochure for the gel course. Send when the contact asks for details, a syllabus or something to read.",
    },
  ],
  "tags": [
    {
      "id": "interested_gel",
      "tag": "interested-gel-course",
      "description": "Contact showed interest in the gel course.",
    },
  ],
  "fields": [
    {
      "id": "preferred_shift",
      "field": "preferred_shift",
      "values": ["morning", "evening"],
      "description": "Which shift the contact said suits them.",
    },
  ],
}
```

The `description` fields are the "what it contains, when to use it" guidance the
model reads. They are tenant copy, so they may be in the tenant's language
(`005-language.md`). The model sees `id` and `description` and never sees
`flowNs`, `tag` or `field`. Those name objects in the tenant's ManyChat account,
and keeping them server-side means renaming one is a config edit that no prompt
depends on.

## The subscriber is never a parameter

No tool takes a subscriber id. Each tool closes over the current turn's
subscriber. Contact text cannot change which contact an action lands on (C4),
and one contact's turn cannot write to another contact's record, which would be
a disclosure under C5 rather than just a bug.

## Free-text field values are refused

`set_field` takes a value from the field's configured `values`, never a string
the model composed. A free-text write would put unvalidated model output into a
field that a ManyChat flow may later render to the contact, which bypasses C3.
It would also invite the model to copy the contact's own words (names, phone
numbers) into the CRM. If a tenant needs an open field, that is a new spec.

## Guardrails run before any action is performed

Staged actions are performed only if the final reply, **after** `applyGuardrails`,
has `escalate: false`. Every other outcome discards them, and the count
discarded is logged:

- the model set `escalate: true`;
- confidence fell below the threshold;
- a prompt or fence leak was detected;
- the output failed schema validation, or the model call threw;
- the model call hit `MODEL_ABORT_MS`.

Turns where the model never runs (the scripted opening, escalation keywords,
budget, rate and turn caps) have no tools and so stage nothing.

## The loop is bounded at two steps

Step one may call tools, several in parallel. Step two offers no tools, so it
must produce the `AgentReply`. If no reply is produced, the turn fails closed
exactly as a schema failure does today.

A turn stages at most **3** actions. A call past that returns
`{ staged: false }` and is dropped. Identical staged actions are de-duplicated.

Both numbers were chosen, not measured. Two steps is the smallest loop in which
the model can act and then answer. Three actions bounds the burst a single turn
can put through the ManyChat rate limiter, where each action is one request
against the existing token bucket. Change them when an eval shows a need, and
record the measurement date here.

## The whole loop runs inside the race

The race deadline and model abort in `002-channel-contract.md` are unchanged and
apply to the entire loop, not to each step. A tool turn is more likely to lose
the race. That is accepted, since the outbox exists for exactly that. The
reply is deferred, never dropped, and its staged actions are deferred with it.

## Actions follow the text, on both delivery paths

- **Race won:** actions are performed after the Dynamic Block response has been
  sent, never before.
- **Race lost:** the outbox payload carries the staged actions alongside the
  messages. The worker performs them only after the text is delivered. If the
  row is dead-lettered, the actions are dropped with it, because media arriving
  without the reply that introduces it is worse than neither.

Actions are performed in the order the model staged them, one request each,
through the existing `ManyChatClient` and its rate limiter.

## The flow set may not include the reply flow or field

`flows[].flowNs` may not equal `MANYCHAT_REPLY_FLOW_NS`, and `fields[].field` may
not equal `MANYCHAT_REPLY_FIELD`. The reply flow renders whatever the reply
field holds, so firing it as a tool would resend a stale reply, and writing that
field as a tool would overwrite a reply in flight (`002 § The two calls are one
delivery`). Either collision is a startup failure, not a runtime surprise.

## A failed action is logged, never retried

Each action gets one attempt. A failure is logged at `warn` with the tool, the
configured id and the ManyChat error, with the subscriber redacted (C5), and is
not retried. The text is the reply of record. Actions are enhancements to it,
and a retry that lands minutes later, after the conversation has moved on, is
worse than a missing tag.

On the deferred path, an outbox retry re-delivers text only. Actions are
performed once, after the first successful delivery.

On the inline path, actions run in-process after the response. A crash between
the response and the actions loses them. This is accepted for the same reason.

## Verification

1. A unit test asserts each tool's parameter schema rejects an id absent from
   `config/tools.json`, and that a tool with an empty list is not offered.
2. A unit test asserts that `execute` makes no request: a `fetchImpl` spy
   records zero calls for the whole model step.
3. A test drives each escalation path listed under "Guardrails run before any
   action is performed" and asserts zero ManyChat requests.
4. A test asserts a fourth staged action returns `{ staged: false }` and is not
   performed.
5. A unit test over `fetchImpl` pins each action's request body. Each carries the
   current turn's `subscriber_id`, and `set_field` carries a configured value.
6. On both paths, a test asserts the order: text is delivered before any action
   request. On the deferred path, a retried row performs its actions once, and a
   dead-lettered row performs none.
7. A config test asserts that a flow equal to `MANYCHAT_REPLY_FLOW_NS`, or a
   field equal to `MANYCHAT_REPLY_FIELD`, fails at load.
8. The mock model gains a tool-calling case. Golden eval cases assert the tool
   choice for a request that should send a flow, and for one that should not.
   `001 § Verification` item 5 (p95 latency) now covers tool turns.

What this misses: as in `002`, ManyChat returning success is not WhatsApp
delivering. A flow that was renamed, is unpublished or points at a missing file
passes every check here. Ordering is also only enforced on this side. Once the
Dynamic Block response and a `sendFlow` are both with ManyChat, the order in
which the contact sees them is ManyChat's. And no test can tell whether a
`description` leads the model to the right flow. Evals sample that, and a person
reading real conversations is the actual check.
