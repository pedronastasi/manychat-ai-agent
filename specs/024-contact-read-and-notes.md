---
status: specified
constitution: [C3, C4, C5, C6, C7]
adr: [0010, 0016, 0017]
---

# 024 — Contact Read and Free-Text Notes

Defines the `get_contact` read tool, the `write_note` tool and its note
fields, and the larger loop both need. It amends `012` in four places, listed
at the end, and leaves out reading anything but the current contact, writing
free text to any field that is not a declared note, and every page-level or
account-global endpoint.

## `get_contact` returns a whitelist, never the subscriber

ManyChat's `GET /fb/subscriber/getInfo` returns the whole subscriber: name,
phone, email, WhatsApp number, last input text, every tag and every custom
field. None of the identifiers is needed to sell, and all of them are PII.

`get_contact` takes no parameters. It closes over the turn's subscriber, as
every `012` tool does, and returns only what `tools.json` lists as readable:

```jsonc
{
  "tags": ["interested_foundation"],
  "fields": { "experience": "none", "sales_stage": "nurturing" },
  "notes": { "goal": "…" },
}
```

- `tags` lists the configured `tags[].id` whose ManyChat tag the contact has,
  plus any `readable.tags[]`: tags the tenant's own flows set, which the agent
  may see but not write. Unconfigured tags are omitted.
- `fields` maps each configured enum field, and each `readable.fields[]`, to
  its value. A value outside the field's configured `values` is returned as
  `"other"`, never as the raw string, because a flow may have filled it from
  the contact's typing.
- `notes` maps each configured note (below) to its current text.

`readable` has the same entry shapes as `tags` and `fields` in `012`, and the
model sees only its ids, never the ManyChat names:

```jsonc
{
  "readable": {
    "tags": [
      {
        "id": "came_from_ad",
        "tag": "source-ad",
        "description": "The contact arrived by clicking an ad.",
      },
    ],
    "fields": [],
  },
}
```

The identifiers in the subscriber record (name, phone, email, WhatsApp number,
profile picture, last input text) are never returned, whatever `tools.json`
says.

## Note values come back inside the contact fence

A note is model output summarising the contact's words, and an enum field
may have been filled by a flow from the contact's own input. Either can carry
an injected instruction. The tool result therefore places `notes` inside the
same untrusted fence as inbound text (C4). Tags and enum fields, which are
configured ids by construction, sit outside it.

## A read is performed, and its failure is not an escalation

`get_contact` is the one tool whose `execute` makes a ManyChat request
(ADR-0016). It goes through the existing `ManyChatClient` and its rate
limiter, with its own timeout of **1500 ms**, chosen, not measured, so that one
slow read cannot consume the race.

A failed or timed-out read returns `{ available: false }` and the turn
continues. Reading is a help to the reply, not a precondition of it, and C6
already covers what matters: a turn that cannot ground an answer escalates
for that reason, not because the read failed. The failure is logged at
`warn` with the subscriber redacted (C5).

A turn may read at most **twice**. A third call returns
`{ available: false }` without a request.

## The loop grows to four steps and eight actions

| Bound          | `012` | Now |
| -------------- | ----- | --- |
| Steps          | 2     | 4   |
| Staged actions | 3     | 8   |
| Reads          | —     | 2   |

Steps one to three may call tools; step four offers none and must produce the
`AgentReply`. Both numbers were chosen, not measured: four steps fit read,
act, read again and reply; eight actions fit a flow, a funnel stage, two
qualification fields, a tag and three notes. Server follow-on writes
(`023 § The sale ends at the payment-link flow`) do not count against the cap.

The race deadline and model abort in `002` are unchanged and apply to the
whole loop. More turns will be deferred; that is accepted (ADR-0016). Eight
actions after a deferred reply is a burst of up to eight requests through a
limiter whose burst is smaller, so the last of them wait. Change these
numbers when an eval shows a need, and record the measurement date here.

## Three free-text notes, declared and bounded

`tools.json` gains a `notes` list. Each entry is a note field the tenant
declares is never rendered to the contact (ADR-0017):

```jsonc
{
  "notes": [
    {
      "id": "goal",
      "field": "agent_note_goal",
      "maxLength": 280,
      "neverRendered": true,
      "description": "Why the contact wants the course, in one sentence.",
    },
    {
      "id": "handoff_summary",
      "field": "agent_note_handoff",
      "maxLength": 500,
      "neverRendered": true,
      "onEscalation": true,
      "description": "What the person taking over needs to know, in two or three sentences.",
    },
  ],
}
```

`neverRendered` must be the literal `true`, or the entry fails at load. It
does not make a flow safe. It makes the tenant state, in the file, the one
thing this repository cannot check.

The intended notes are `goal`, `objections` and `handoff_summary`; the ids are
the tenant's to choose. `maxLength` may not exceed **500**, chosen to fit a
ManyChat text field with room to spare. `onEscalation` is optional and
defaults to `false`; its meaning is in "A handoff summary survives the
escalation it describes". Any note may carry it, but it exists for the
handoff summary, and a note that is only useful before a sale (`goal`) should
not.

`write_note` takes a note id and text. It is staged like any `012` write. The
note's `field` may not equal `MANYCHAT_REPLY_FIELD`, `MANYCHAT_TOKEN_FIELD`,
any `fields[].field` or another note's `field`; any collision fails at load.

## Note text is cleaned before it is written

Before a staged note is performed, the server:

1. removes phone-number, email and URL shapes, each replaced by `[removed]`;
2. collapses whitespace and strips control characters;
3. truncates to `maxLength` at a word boundary.

A note left empty is not written. A write replaces the field's value; it does
not append. A model that wants to add to a note reads it first.

The shapes in step 1 are the same ones the logger already redacts (C5), so a
change to one is a change to both.

## A handoff summary survives the escalation it describes

`012 § Guardrails run before any action is performed` discards every staged
action when the turn escalates. A handoff summary is staged precisely on that
turn, so the rule would discard every one.

A note marked `"onEscalation": true` is therefore performed when the turn
escalates, **only** if the escalation came from the model (`escalate: true`)
or the confidence threshold, and the output passed schema validation and the
leak checks. A note on a turn that escalated because of a leak, a schema
failure, a thrown call or an abort is discarded with everything else, since
the text it carries is exactly what failed. All other staged actions are
discarded as `012` says.

Such a note is performed after the escalation message is delivered, on
whichever path delivers it, as any action follows its text. In `turns.actions`
it is written as `staged` and moves to `performed` or `failed`, like an action
on a turn that did not escalate. It is the one entry on an escalated turn that
is not `discarded`, so `012`'s status table needs no new value: `discarded`
keeps meaning "dropped because the turn escalated", and an `onEscalation` note
that was dropped for a leak or a failure is recorded as `discarded` too.

## Note text never reaches the record or the logs

The `turns.actions` entry for a note holds its id and the length written,
never the text:

```jsonc
{ "tool": "write_note", "id": "goal", "length": 74, "status": "performed" }
```

The `012` history note lists it as `write_note goal`. The text lives only in
the tenant's ManyChat account, which the model can read back with
`get_contact`. A failure log for a note carries the id and the ManyChat error,
never the text.

## What this changes in `012`

- `§ Four tools` gains `get_contact` and `write_note`.
- `§ Free-text field values are refused` holds for `fields[]`; free text is
  permitted only in `notes[]`, as above.
- `§ The loop is bounded at two steps` is replaced by the table above.
- `§ Guardrails run before any action is performed` gains the `onEscalation`
  exception.

`012` and `003` are edited in the pull request that implements this spec.

## Verification

1. A unit test over a full `getInfo` fixture with invented name, phone and
   email asserts `get_contact` returns none of them, omits unconfigured tags,
   and maps an out-of-enum field value to `"other"`.
2. A unit test asserts note values in the tool result are inside the fence,
   and tags and fields are outside it.
3. A test asserts a read that times out at 1500 ms returns
   `{ available: false }` and the turn still produces a reply, and that a third
   read makes no request.
4. A test asserts the fourth step offers no tools, and a ninth staged action
   returns `{ staged: false }`.
5. Config tests assert a note without `neverRendered: true`, with `maxLength`
   over 500, or with a colliding `field`, fails at load.
6. A unit test asserts the cleaning: an invented phone number, email and URL
   are replaced, and text over `maxLength` is cut at a word boundary.
7. A test drives each escalation path and asserts an `onEscalation` note is
   performed after the escalation message for model and confidence
   escalations, recorded `performed`, and recorded `discarded` for leak,
   schema, error and abort. A note without `onEscalation` is `discarded` on
   every escalation path.
8. An integration test asserts a note's `turns.actions` entry has `length` and
   no text, and a log-capture test asserts the text is absent from every log
   line of the turn.

What this misses: `neverRendered` is the tenant's word, and nothing here can
see a flow that renders a note. The cleaning catches identifier shapes, not
identifiers: a name, a town or a health detail in prose passes through to the
tenant's CRM. And the read reflects ManyChat at the moment of the call; a flow
that changes a tag a second later is not seen until the next read.
