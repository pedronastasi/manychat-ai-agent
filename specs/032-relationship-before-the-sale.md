---
status: implemented
implemented: 2026-10-04
pr: 157
constitution: [C1, C6, C9]
adr: [0015, 0019]
---

# 032 — Relationship Before the Sale

Defines how the agent opens a conversation, which content it sends without
being asked, and that it checks the contact is ready to start before it
offers the payment link. It amends `023` in three places and `003`, `012` and
`029` in one each, listed at the end, and leaves out everything after
`link_sent`, nudges (`025`), messages outside WhatsApp's 24-hour window, and
whatever the contact receives after paying, which a person sends.

## A warm lead is not a lead ready to pay

The reflexive sales agent answers what it is asked and moves to the close as
soon as the lead looks warm: a question about price or schedule is read as
buying intent, and the next message offers the payment link. `023` built that
shape, and every content flow in it waits for the contact to ask.

It is wrong here for three reasons.

- **Content on request is content most leads never see.** A lead who asks
  the price and the schedule, and never says "I'm not sure I can do this",
  is never shown the students' results, though the tenant built that flow
  for exactly this lead. The proof reaches only the leads who voice a doubt.
- **An opening the model has to remember is an opening it forgets.** The
  opening voice note was a model choice, gated on a contact read and a tag.
  On the live deployment on 2026-10-03, a lead who wrote first from the
  tenant's website was answered with the course options and never received
  it: the conditions were met, and the model did not send it.
- **The link arrives before the contact knows what starting takes.** A lead
  who pays and then learns what else they need to begin is a refund request
  or a no-show. `023 § Success is measured twice` already names the symptom:
  link-sent rate rising while paid enrolment stays flat means the agent asks
  too early.

So **the server guarantees the steps a relationship needs, opening, proof
and a readiness check, and the model decides only how to word them.** The
order is: the opening, then the course content, modalities and price, then
what the contact still needs to start, then the offer to send the payment
methods.

## The opening flow is the server's, not the model's

A `flows[]` entry may carry `"role": "opening"`. At most one may, it carries
no `course` (`028`), and it may not also be the `payment_link` flow, nor
`repeatable`; each is a load failure.

The opening flow is sent on the contact's **first model turn**: the first
turn for this conversation on which the model runs. A turn answered by the
scripted opening (`001`) or escalated before the model ran (budget, rate or
turn caps, escalation keywords) is not one. Turns recorded before this spec
was rolled out count, so an existing contact does not receive it.

- **It is sent only if the reply does not escalate.** When the model's reply,
  after the guardrails, has `escalate: false`, the server sends the opening
  flow and then delivers the reply, which waits for it as `030` says. A first
  message that reports a payment, complains or asks for a person escalates,
  and the opening is not sent, then or later.
- **The model does not choose it.** The opening flow is never in
  `send_flow`'s enum. On a first model turn the system instructions tell the
  model that the flow will go out before its reply unless it escalates, so the
  reply does not repeat what the flow says and closes with the question the
  flow asks.
- **No tag decides it.** A contact who heard the same content in the tenant's
  entry flow may hear it twice. That is accepted: a repeat costs one message;
  a lead who never hears it costs the opening.
- **It is recorded like any flow.** The `turns.actions` entry carries
  `"origin": "opening"`, and the `012` history note lists it as a performed
  flow, so no later turn sends it again.
- **Once, when first messages arrive together.** A contact who sends three
  messages in a row starts three turns that are each a first model turn. The
  turn that sends the flow first claims it on the conversation row, in one
  conditional update, and the others send nothing (`026 § A scheduled job
runs where its claim is atomic` takes the same approach). Their models
  were told the flow would go out; one did, so the reply still follows it.

When the model loses the race (`002`), the holding line goes out at the
deadline, and the opening flow is sent when the deferred call settles without
escalating, before its queued reply. The contact reads the holding line, the
flow, then the reply. That order is accepted; holding the acknowledgement
back for a flow not yet sent would leave the contact with nothing for the
model's whole call.

The opening does not count against the turn's action cap (`012 § The loop is
bounded at four steps`): it is the server's, like the payment link's
`link_sent` write.

## A stage move can carry a flow

A `flows[]` entry may carry `"onStage"`, a value of the funnel field. It
names the stage at which the contact should receive this flow whether or not
they asked for it: the demo tenant ties its student-work gallery to
`nurturing` and its common-questions flow to `offered`.

```jsonc
{
  "flows": [
    {
      "id": "student_work",
      "flowNs": "content00000000000000_000003",
      "onStage": "nurturing",
      "settleSeconds": 6,
      "description": "Photos of work by students who started with no experience.",
    },
  ],
}
```

When the model stages a funnel write to exactly that stage on an inbound
turn, and the write is accepted (`023` refuses a backward one), the server
sends the tied flow at that point, as `029` sends a flow the model calls: the
contact receives it before the reply, and the reply waits for it (`030`).

- **Sent once, as every flow is.** A tied flow already performed for the
  contact is not sent again (`023 § Every content flow is a leaf, sent once`).
  The model may still send it earlier, when the contact asks; then the stage
  move sends nothing.
- **The course still decides.** A tied flow with a `course` is sent only when
  it is the turn's course (`028`). Otherwise the move sends nothing.
- **Only the stage written.** A write that skips a stage does not send the
  skipped stage's flow, so a lead who jumps from `qualifying` to `offered`
  does not receive two flows at once.
- **The model is told.** `set_field`'s result names the flow sent, as
  `flowSent`, or one ManyChat refused, as `flowRefused`, so the reply does not
  repeat the flow's content or claim it went out. On a nudge turn it says
  `flowStaged`. A tied flow past the per-turn cap is neither: it comes back
  as `flowDropped` with the reason, since it was never sent and the stage
  move will not send it again, so the model knows it may still send the flow
  itself on a later turn.
- **It counts against the cap**, since the model's write caused it, and it is
  recorded with `"origin": "stage"`.

At most one flow may be tied to a stage, `onStage` may not be `new` or
`link_sent`, and it may not be set on the opening or payment-link flow; each
is a load failure. On a nudge turn a tied flow is staged and follows the
text, as `029 § Nudge turns keep flows staged` has it for any flow.

## Readiness comes between the offer and the link

The funnel gains a stage, `prepared`, between `offered` and `link_sent`:

| Stage       | Meaning                                                                |
| ----------- | ---------------------------------------------------------------------- |
| `offered`   | A course and its catalog price have been put to the contact            |
| `prepared`  | The contact has been asked what they still need to start, and answered |
| `link_sent` | The payment-link flow was performed                                    |

At `offered`, the closing question asks what the contact still needs to
start, not for the enrolment. What that is belongs to the tenant, in
`config/prompt.md`: the demo tenant asks whether the contact already has the
starter kit. The answer comes from the catalog (`001 § Grounding rule`); a
contact who needs something the catalog does not cover is escalated as
`out_of_scope`, as today. The model sets `prepared` once the contact has
answered, whatever the answer, and only then does its closing question offer
to send the payment methods.

The stages are the system's, not the tenant's (`023`), so every deployment's
funnel field gains `prepared`, in order. `028`'s course lock is unchanged: it
starts at `offered`, which `prepared` follows.

## The payment link waits for readiness, unless the contact asked to pay

`send_flow` refuses the payment-link flow before `prepared`, returning
`{ sent: false, reason: "not_prepared" }` with no request. The stage it checks
is the contact's last performed stage, or one staged earlier in the same turn,
so the model may record `prepared` and send the link in one turn.

The exception is a contact who asks to pay. `send_flow` takes an optional
`contactAsked: true`, which lets the payment link through before `prepared`.
The tool description tells the model to set it only when the contact's
message in this turn asks for the link, the payment methods or how to pay.
`023 § Qualify before sending content` already gives a contact who asks for
the link the link; this keeps that true. A lead ready to pay is never held
back for a conversation they did not ask for.

The model asserts `contactAsked`, and nothing here can check it. So when it
opened the gate, the payment link sent before `prepared`, it is recorded on
the link's `turns.actions` entry; a link at or after `prepared` records none,
whatever the model passed, and the bypass rate,
payment links sent with `contactAsked` over all payment links sent in a
week, is reported beside `023`'s two measures. A model that claims the
contact asked whenever it wants to close shows up as a bypass rate near one.

## What this changes elsewhere

- `023 § The funnel is a field the agent moves`: the stage table gains
  `prepared` between `offered` and `link_sent`.
- `023 § The agent asks for the sale`: the plain ask for the enrolment moves
  from `offered` to `prepared`; at `offered` the closing question is the
  readiness question.
- `023 § The sale ends at the payment-link flow`: the flow is refused before
  `prepared` unless `contactAsked`; `§ Success is measured twice` gains the
  bypass rate.
- `003 § tools.json`: `flows[]` entries take `role: "opening"` and `onStage`,
  with the load checks above, and the funnel field's values gain `prepared`.
- `012 § Six tools`: `send_flow` takes an optional `contactAsked`;
  `§ Every staged action is recorded on its turn`: entries carry `origin`
  (`opening`, `stage`) for flows the server sent, and `contactAsked` on the
  payment link.
- `029 § A flow is sent when the model calls it`: a flow the server sends on a
  stage move follows the same timing; the opening flow is sent after the
  model's reply settles and before it is delivered.
- `001 § Role`: the readiness check joins qualifying, content and objections.
- `026`: the Python port mirrors all of it.

A deployment's `tools.json` and its ManyChat funnel field must gain
`prepared` before the pull request that implements this spec is deployed, or
the file fails at load.

## Verification

1. Config tests assert two `opening` flows, an `opening` flow with a `course`,
   one that is also `payment_link` or `repeatable`, two flows on one
   `onStage`, an `onStage` of `new` or `link_sent` or outside the funnel
   values, and a funnel field without `prepared`, each fail at load.
2. An integration test over the ManyChat HTTP boundary asserts the opening
   flow is sent before the reply on a first model turn and recorded with its
   origin; that it is not sent when that turn escalates, nor on any later
   turn; that it is sent on the first model turn after a scripted opening;
   that three first messages arriving together send it once; and that a
   deferred call sends it after the holding line. A unit test asserts it is
   absent from `send_flow`'s enum.
3. A unit test asserts a funnel write to a tied stage sends the tied flow
   once, names it in the result as `flowSent`, sends nothing when the flow
   was already performed, belongs to another course or the write skipped its
   stage, and stages it on a nudge turn.
4. A unit test asserts the payment-link flow is refused with `not_prepared`
   before `prepared`, accepted after `prepared` performed or staged earlier in
   the turn, accepted with `contactAsked`, and that `contactAsked` is recorded.
5. Golden eval cases, demo tenant. The suite runs the model without the turn
   handler, so it cannot see the server send the opening; it asserts the
   decision that gates it instead: on a first model turn, a "hi" and a course
   question do not escalate, and a reported payment does. A lead at `offered`
   who accepts the price stages no link, and its reply is reviewed for the
   readiness question; a lead who asks how to pay at `nurturing` stages the
   link.

What this misses: `contactAsked` is the model's word, and only the bypass rate
and a person reading conversations catch a model that overclaims it. Whether
the readiness question builds trust or only delays the sale is a judgement no
assertion makes; paid enrolment against the `023` baseline is the measure. A
contact who heard the opening in the tenant's entry flow hears it again, by
design. A stage flow sent on a turn that then escalates has still gone out,
as every flow has since `029`. And the golden set never sees the opening
itself go out; only the integration test does, against a fake ManyChat.
