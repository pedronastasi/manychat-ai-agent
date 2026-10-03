---
status: implemented
implemented: 2026-10-03
pr: 150
constitution: [C1, C3, C5]
adr: [0010, 0015]
---

# 027 — Funnel Conversion Events

Defines how the agent's progress through a sale reaches the ad platform once
the drip is retired: the server fires a silent tracking flow when the funnel
stage advances. It leaves out the enrolment event (a human sets `enrolled`,
`023`), what each event carries (built inside the tenant's ManyChat flow), and
ad attribution, which is the ad platform's.

## Retiring the drip silently retires the ad signal

A tenant's drip does more than send content. Its steps log conversion events
to Meta's Conversions API: a lead entered, a lead saw the results, a lead
reached the payment step. Ad delivery is optimised on those events.

`023 § A fixed drip sends the same content to every lead` retires the drip and
hands the sale to the agent. Events logged _inside a content flow_ survive
that move, because the agent sends the same flow (see "Events inside content
flows stay where they are"). Events logged _between_ steps, on the drip's own
timeline, do not: nothing in this service fires them, and nothing reports their
absence. The campaign keeps running on a signal that has stopped.

## An event is a measurement, so the model never chooses it

The reflexive fix is to list each tracking flow in `tools.json` `flows[]`,
describe it ("send when the contact has seen the price"), and let `send_flow`
fire it. That is wrong for the same reason a thermometer is not asked for its
opinion. A model fires a described flow when the conversation seems to call
for it, which varies by phrasing, by turn and by model version. An event fired
on some offers and not others is noise the ad platform optimises on, and no
reader of the conversation can tell which contacts were counted.

So **an event is a consequence of a stage write, performed by the server, and
is never offered to the model.** The stage already records, forward-only and
once, the facts an event reports (`023 § The funnel is a field the agent
moves`). The event is that record, sent somewhere else.

## A tracking flow sends no message and is configured per stage

`tools.json` gains an optional `events` list:

```jsonc
{
  "events": [
    {
      "id": "lead_qualified",
      "stage": "nurturing",
      "flowNs": "content00000000000000_000101",
    },
    {
      "id": "checkout_started",
      "stage": "link_sent",
      "flowNs": "content00000000000000_000102",
    },
  ],
}
```

- `stage` is a value of the `funnel` field (`023`). A stage with no entry fires
  nothing. `new` may not carry one: it is the stage every contact starts at,
  and an event on it reports nothing the entry flow does not.
- At most one entry per `stage`; a second is a load failure.
- `flowNs` may not equal any `flows[].flowNs`, `MANYCHAT_REPLY_FLOW_NS`, or
  another event's `flowNs`. A tracking flow that is also a content flow would
  be sent once by the model and once by the server, and the event would count
  twice. Any collision is a startup failure.
- `events` without a `funnel` field is a load failure: there is no stage to
  key on.

The flow itself is the tenant's: one ManyChat flow containing a "Send event to
Meta Conversions API" action and **no message**. Nothing in this repository can
see inside it. A tracking flow that sends text puts an unannounced message
between the agent's replies, and the `012` history note will not show it.

The model never sees `events`, their ids or their flows. They are absent from
every tool enum and from the system instructions.

### Why a flow and not a tag

The other route is for the server to add a tag (`stage-nurturing`) and let a
ManyChat "tag applied" rule fire the event. It needs no new flow, and was
rejected because the event then happens where this service cannot see it: a
rule that is paused, deleted or misspelt fails silently, and `turns.actions`
records a tag, not an event. A tracking flow is one `sendFlow` request whose
result this service records.

## One event per stage per contact, because the stage only moves forward

An event fires when, and only when, a funnel write to its `stage` is
**performed** and **advances** the stage: the value is later than the last
stage recorded as `performed` for the contact. `023` refuses a write to an
earlier stage but accepts one equal to the current stage, and a model that
re-records `nurturing` on a later turn must not count the lead twice. Because
the stage only moves forward, a strict advance to a given stage happens at
most once per contact, so no separate record of sent events is needed.

The comparison is made when the follow-on is attached, against the same
last-performed stage `023` uses for its floor. Two turns of one contact racing
on the deferred path could each see the old stage; that window is the same one
`023`'s floor already accepts, and is not closed here.

A contact whose stage jumps (`qualifying` straight to `offered`) fires only
the event for the stage written, not those for stages skipped. The event
reports what the agent recorded, not a path the contact did not take.

## The event follows the stage write it records

The tracking flow is a **follow-on** of the funnel write, the same mechanism
`023 § The sale ends at the payment-link flow` uses for `link_sent`:

- it is performed after the funnel write, and only if that write was
  `performed`. A failed or discarded write fires nothing;
- the `link_sent` write is itself a follow-on of the payment-link flow, so its
  event is a follow-on of a follow-on, performed in that order: payment flow,
  stage write, event;
- it is not staged by the model and does not count against the per-turn cap
  (`012 § The loop is bounded at four steps`);
- it rides the same delivery path as the write: after the Dynamic Block
  response when the race is won, after the outbox delivers the text when it is
  lost, and not at all if the row is dead-lettered;
- it gets one attempt and is never retried (`012 § A failed action is logged,
never retried`). A retried event minutes later is still a correct event, but
  an outbox retry already re-delivers text only, and making events the one
  retried action is a second retry policy for one stage write.

A nudge turn (`025`) that writes a stage fires its event like any other turn.

## Every event is recorded beside the write that caused it

The follow-on is recorded in `turns.actions` like the `link_sent` write:

```jsonc
{ "tool": "send_event", "id": "lead_qualified", "status": "performed" }
```

`send_event` is a record kind, not a tool: no model is ever offered it. The
entry holds the configured `id` only, never the `flowNs` or contact data, so it
needs no redaction (C5). It is **excluded** from the `012` history note: the
note tells the model what reached the contact, and an event reached the ad
platform, not the contact.

## Events inside content flows stay where they are

A content flow that already logs an event (a "viewed the results" event inside
the results flow) keeps it. When the agent sends that flow, the event fires,
once, because `023` sends each content flow at most once per contact. Nothing
here moves those events into `events[]`, and nothing should: they measure that
a piece of content was delivered, which is exactly when they fire.

What `events[]` adds is the events that measure the **sale**, not a piece of
content: qualified, offered, checkout started.

## Verification

1. Config tests assert each load failure: two entries for one `stage`, an
   entry on `new`, a `flowNs` equal to a `flows[]` entry, the reply flow or
   another event, and `events` without a `funnel` field.
2. A unit test asserts no tool's schema, enum or description, and no part of
   the system instructions, contains an event `id` or `flowNs`.
3. A test over `fetchImpl` asserts a performed funnel write to a stage with an
   event sends that event's flow after the write, with the turn's
   `subscriber_id`, that a failed or discarded write sends none, and that a
   write equal to the contact's last performed stage sends none.
4. A test asserts the payment-link flow produces three requests in order
   (flow, `link_sent` write, event), and none after the first if it fails.
5. A test asserts an event follow-on does not count against the eight-action
   cap.
6. An integration test against PGlite asserts the `send_event` entry is
   written with the configured `id` and its status, on both delivery paths, and
   absent when the outbox row is dead-lettered.
7. A unit test asserts the `012` history note omits `send_event` entries.

What this misses: `performed` means ManyChat accepted the `sendFlow`, not that
the flow logged an event or that Meta received it. A tracking flow that is
unpublished, sends a message, or logs the wrong event name passes every check
here; the tenant opens each flow once and checks Meta's Events Manager. And
the events are only as good as the stage writes behind them: an agent that
moves leads to `offered` too early fires `offered` events too early, and the
ad platform learns from that.
