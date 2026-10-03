---
status: implemented
implemented: 2026-10-03
pr: 152
constitution: [C6, C7, C8]
adr: [0010, 0016, 0019]
---

# 029 — Flows Go Out Before the Reply

Defines when a flow the agent chooses is sent on an inbound turn: when the model
calls `send_flow`, before it writes its reply, so the contact receives the flow,
then the reply, then its closing question. It amends `012` in three places and
`027` in one, listed at the end, and leaves out what a flow contains (the
tenant's) and every other write, which stays staged.

## The question arrived before what it asked about

`012` staged every action and performed it after the reply was sent. For a flow
that fixes the order the contact reads: the announcing line, the closing
question ("would you like the prices?"), then the flow. The next step comes
before the thing it follows from, and scrolls away under it. The model also
wrote about a flow it had not seen go out, and, without its content in view,
often wrote that content into the reply as well, so the contact read it twice.

Two fixes that kept staging were weighed and rejected:

| Fix                                                             | Why not                                                                                                                              |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Hold the closing question back and send it after the flow       | A second, background send to the contact beside the outbox; two sends that interleave show one text twice and lose the other (`002`) |
| No closing question on a flow turn, or a fixed one in each flow | The turn loses its next step, or the model's choice of it                                                                            |

## A flow is sent when the model calls it

On an inbound turn, `send_flow`'s `execute` sends the flow and returns
`{ sent: true }` when ManyChat accepted it, `{ sent: false }` when it refused.
The model then writes its reply knowing what went out. The tool description
says so, and that the reply must not repeat what the flow contains.

- **Follow-ons go with it.** The payment-link flow's `link_sent` write and that
  stage's event (`023`, `027`) are performed right after the flow, in that
  order, as before, and a pending nudge is cancelled by the write as before.
- **Once per turn.** A flow already sent this turn is not sent again; the
  second call returns the first outcome. The sent-once rule across turns
  (`023`) is unchanged.
- **The cap counts it.** A sent flow counts against the eight actions of
  `012 § The loop is bounded`. One over the cap is not sent and returns
  `{ sent: false }` with the reason.
- **Course scoping first.** A flow for another course is refused before any
  request, as `028` has it.

Every other write (tags, fields, notes, nudges) stays staged and is performed
after the reply, as `012` describes (ADR-0019).

### Nudge turns keep flows staged

A nudge turn (`025`) declines by escalating, and nothing is then sent. A flow
sent first would arrive alone, with no reply to introduce it. So a nudge turn
stages its flows, and they follow its text as in `012`. Evals stage too: no
ManyChat account is involved.

### The reply step is told what went out

When the loop reaches its last step, the notice that replaces the tool results
(`024 § The loop grows to four steps`) names the flows already sent, says the
contact receives them before the reply, and names any ManyChat refused, so the
reply does not claim those were sent.

## An escalation cannot recall a flow

A turn that escalates after it sent a flow, on the model's call, the confidence
threshold, a guardrail, a schema failure, a thrown call or `MODEL_ABORT_MS`, has
still sent it. The contact receives the flow, then the handoff message. This is
accepted for every flow, the payment link included: flows are content the
tenant built and chose to offer, and one arriving before a handoff does no harm
a person cannot follow up on (ADR-0019). It narrows C6 for flows only: the
turn still reaches a human, with the flow recorded as sent.

The turn's record keeps each sent flow's outcome, `performed` or `failed`,
beside the staged actions, in the order the model made them; an escalation marks
the staged ones `discarded` and leaves the sent ones as they are. A deferred
call that fails or hits `MODEL_ABORT_MS` after sending a flow, which before
this spec recorded nothing, records an agent turn with the holding line the
contact was given and outcome `error`, so the next turn knows the flow went
out and does not send it again.

## The race includes the request

The flow's request runs inside the race (`002`), so a turn that sends one is
slower and more likely to be deferred. A deferred turn has already sent its
flow; the outbox delivers the reply after it, which keeps the order. The
request is bounded by the client's timeout and the action cap.

## ManyChat accepting a flow is not ManyChat finishing it

`performed` means ManyChat accepted the request. It then plays the flow with
its own timing, so a flow with a long Smart Delay is still playing when the
reply arrives a few seconds later, and the reply lands inside it. A flow the
agent sends should therefore deliver its content without long delays. Nothing
here can see inside a flow, so this is the tenant's to check.

## Amendments

- `012 § A tool stages an action`: `send_flow` on an inbound turn sends.
- `012 § Guardrails run before any action is performed`: a flow sent during
  the turn keeps its outcome when the turn escalates.
- `012 § Actions follow the text`: on an inbound turn, flows precede it.
- `027 § The event follows the stage write it records`: the payment link's
  chain goes out with the flow, during the turn.

## Verification

1. A unit test asserts that with a flow sender, `send_flow` sends during the
   call and returns `{ sent }`, sends a flow once per turn, counts it against
   the cap, refuses another course's flow without a request, and that without
   one it stages as before.
2. A unit test asserts the turn's record keeps a sent flow's outcome in call
   order and does not mark it `discarded` on an escalation.
3. A unit test asserts the reply step's notice names sent and refused flows.
4. An integration test asserts, over the ManyChat HTTP boundary, that an
   inbound turn's flow request is made before the turn returns, that the
   payment link's `link_sent` write and event follow it, and that the reply's
   staged actions are performed after the response.
5. An integration test asserts an escalated turn has still sent its flow and
   records it, that a deferred call aborted after sending one records it, and
   that a nudge turn's flow stays staged until its text is delivered.

**What this does not prove.** Every check stops at ManyChat accepting the
request. Whether a flow finishes before the reply arrives depends on the
flow's own delays, visible only on a phone.
