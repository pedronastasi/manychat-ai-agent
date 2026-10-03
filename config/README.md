# Tenant configuration

Everything in this directory except `*.example` and this README is **gitignored**
and must never be committed (Constitution C1).

```bash
cp config/prompt.md.example   config/prompt.md
cp config/catalog.json.example config/catalog.json
cp config/rules.json.example   config/rules.json
```

`pnpm bootstrap` copies the examples for you (it never overwrites an existing
file). Invalid config fails at startup rather than at the first customer
message. A failed **reload** (`kill -HUP <pid>`) keeps the previous config, so
a typo cannot take down a running bot.

## `prompt.md`: persona

The system prompt preamble. Write it as instructions to the model: what tone to
use, what it may and may not do. The rest of the system prompt — the catalog,
the rules, the security fence — is assembled by the server.

The file is read as-is: there is no template substitution. The example uses
`{{businessName}}` as a placeholder for the person writing the prompt to
replace with the actual business name.

## `catalog.json`: facts the agent may cite

The only source of factual claims the agent may make. A price change is an edit
here plus `kill -HUP <pid>`, with no prompt editing and no deploy.

| Field                          | Type                   | Notes                                                   |
| ------------------------------ | ---------------------- | ------------------------------------------------------- |
| `businessName`                 | string                 | Interpolated into `prompt.md`                           |
| `currency`                     | string                 | ISO 4217, e.g. `USD`, `ARS`                             |
| `courses[]`                    | array (min 1)          | At least one course is required                         |
| `courses[].id`                 | string                 | Unique identifier                                       |
| `courses[].name`               | string                 | Display name                                            |
| `courses[].description`        | string                 |                                                         |
| `courses[].price`              | `{ amount, currency }` | `amount` is in minor units (cents) to avoid float drift |
| `courses[].durationHours`      | number \| null         |                                                         |
| `courses[].schedule`           | string \| null         |                                                         |
| `courses[].enrollmentUrl`      | URL \| null            |                                                         |
| `faq[]`                        | array                  | Optional (defaults to `[]`)                             |
| `faq[].question`               | string                 |                                                         |
| `faq[].answer`                 | string                 |                                                         |
| `paymentOptions[]`             | array                  | Optional (defaults to `[]`); see below                  |
| `paymentOptions[].id`          | string                 | Unique identifier                                       |
| `paymentOptions[].description` | string                 | How the option works, in your contacts' language        |

`paymentOptions` lists the ways to pay you offer: instalments, a deposit, a
private-class rate. The agent presents one when a contact says the course is too
expensive or asks to pay in parts. A request it does not cover, such as a
discount, still goes to a person (`specs/023-sales-funnel.md`).

## `rules.json`: behaviour and limits

### `messages` (required, no defaults)

Every message is required and has no default, because a missing value must fail
at boot rather than silently emitting English at a contact who does not read it
(Constitution C9).

| Key               | When it is sent                                                                   |
| ----------------- | --------------------------------------------------------------------------------- |
| `acknowledgement` | The model lost the race and the reply is deferred to the outbox                   |
| `escalation`      | The turn hands off to a human (any reason)                                        |
| `mediaFallback`   | The contact sent a voice note, image or video the agent cannot read (`specs/020`) |
| `closer`          | The model's reply repeats an earlier one word for word (`specs/013`)              |

`mediaFallback` is optional: without it, an unreadable media message hands off
with `escalation` instead of asking the contact to type.

`closer` is optional too: without it, a reply that repeats an earlier one is
recorded as `duplicate_detected` and sent as it is.

### Thresholds and limits

| Key                       | Default | Purpose                                                  |
| ------------------------- | ------- | -------------------------------------------------------- |
| `confidenceThreshold`     | `0.6`   | Below this, force escalation                             |
| `maxTurnsPerConversation` | `25`    | After this many turns the conversation escalates         |
| `idleResetHours`          | `24`    | Hours of silence after which the turn cap resets (`018`) |
| `historyDays`             | `30`    | How far back the model's history reaches (`018`)         |

### `escalationKeywords` (default `[]`)

Substring matches checked before the model runs — an instant, free handoff.

### `openingTrigger` (optional)

A sentinel the channel flow sends to start a conversation, and the scripted
reply it produces verbatim. The model never runs for it, so the opening is
instant and free and cannot be turned into a handoff by a low confidence score.
Unlike `escalationKeywords`, which match substrings, this matches the whole
message — a contact who mentions the phrase must not be able to replay the
opening. See `specs/001-agent-behavior.md`.

```json
"openingTrigger": { "keywords": ["start workflow"], "message": "…" }
```

### `budget`

| Key               | Default   | Purpose                 |
| ----------------- | --------- | ----------------------- |
| `dailyTokenCap`   | `1000000` | Max tokens per day      |
| `dailyCostCapUsd` | `5`       | Max spend (USD) per day |

### `rateLimit`

| Key                         | Default | Purpose                   |
| --------------------------- | ------- | ------------------------- |
| `turnsPerSubscriberPerHour` | `60`    | Per-subscriber rate limit |

## `tools.json`: actions the agent can take (optional)

Without `tools.json` the agent only replies. With it, the agent can also act on
the contact in ManyChat while it answers: send one of your flows, tag the
contact, record a choice they made, read what is recorded on them, or write a
note for your team. It can also schedule one follow-up for a contact who goes
quiet (see [Follow-ups](#follow-ups-optional)). The design is in
`specs/012-agent-tools.md`, `specs/024-contact-read-and-notes.md`,
`specs/025-in-window-nudge.md` and
`docs/adr/0010-bounded-tool-loop-with-staged-actions.md`.

`pnpm bootstrap` does not create this file, because tools are opt-in. To turn
them on:

```bash
cp config/tools.json.example config/tools.json
```

Then edit the file and restart, or send `kill -HUP <pid>`.

### What you configure

| Tool          | What it does in ManyChat                      | Configured by                            |
| ------------- | --------------------------------------------- | ---------------------------------------- |
| `send_flow`   | Sends the contact one of your flows           | `flows`                                  |
| `add_tag`     | Adds one of your tags to the contact          | `tags`                                   |
| `remove_tag`  | Removes one of your tags from the contact     | `tags`                                   |
| `set_field`   | Writes one allowed value to a field           | `fields`                                 |
| `get_contact` | Reads the contact's tags, fields and notes    | `tags`, `fields`, `readable` and `notes` |
| `write_note`  | Writes a short free-text note to a note field | `notes`                                  |

`schedule_nudge` is a fifth tool, configured by `nudge`. It makes no ManyChat
request when the model calls it; see [Follow-ups](#follow-ups-optional).

A list you leave empty or omit offers no tool for it. Each entry has:

- **`id`**: the name the model uses for the entry. Lowercase letters, digits,
  `_` and `-`, unique within its list. It is also what the turn record and the
  logs show.
- **`flowNs`, `tag` or `field`**: the object's name in your ManyChat account. The
  model never sees it, so renaming the object in ManyChat only needs an edit
  here.
- **`values`** (fields only): the only values the agent may write. The model
  picks one of them and can never write free text.
- **`description`**: what the entry is and when to use it. This is the only
  guidance the model gets, so write it as a condition, for example "Send when
  the contact asks for details, a syllabus or something to read". It may be in
  your contacts' language.

The agent always acts on the contact whose message it is answering. No tool
takes a contact as a parameter.

### The sales funnel (optional)

Three keys turn on the sales funnel of `specs/023-sales-funnel.md`:

- **`funnel: true`** on one field marks it as the place the agent records where
  the sale stands. Its `values` must be exactly `new`, `qualifying`, `nurturing`,
  `offered`, `link_sent`, in that order. The stage only moves forward, and the
  agent never writes `link_sent` itself.
- **`role: "payment_link"`** on one flow marks the flow that sends your payment
  link. When it is performed, the server writes the funnel field to
  `link_sent`.
- **`repeatable: true`** on a flow lets the agent send it more than once to the
  same contact. Every other flow is sent at most once per contact. The payment
  link is the usual case.

A reply that sends a flow ends on a question, and the question is held back
until the flow has played out, so the contact reads it after the flow's content
(`specs/029-question-after-flow.md`). If a flow takes time to finish, for
example a Smart Delay between its messages, give it **`settleSeconds`**, from 0
to 30: how long the question waits after the flow is sent. Without it, the
question follows as soon as ManyChat has accepted the flow.

Each content flow must be a leaf: it must not start another flow. Nothing here
can see inside your flows, so this is yours to check. And turn off any drip
sequence that sends the same flows on a timer, or contacts will get each piece
twice.

Every other field in `fields` is a qualification question. The agent learns the
answers before it sends the first content flow, one question per turn, so write
each `description` as what to ask, for example "Whether the contact has studied
the subject before. Ask before sending content." The example file has two.

Add `paymentOptions` to `catalog.json` if you offer instalments or a deposit;
without them, "can I pay in parts?" goes to a person as `price_negotiation`.

#### Rolling it out

Most of this happens in your ManyChat account, not here:

1. **Measure the baseline first.** Record your enrolment rate over the four
   weeks before rollout, and the dates it covers. Without it, nothing can show
   the funnel changed anything.
2. **Create the funnel field** in ManyChat with the name you put in `field`,
   plus one field per qualification question. Create an `enrolled` tag for the
   person who confirms payments; the agent never sets it.
3. **Make each content flow a leaf.** Open every flow listed in `flows` and
   remove any step that starts another flow.
4. **Retire the drip.** Change the entry flow so it hands the contact to the
   agent's Dynamic Block instead of starting a sequence. An agent and a drip on
   the same contact send every piece twice.
5. **Tell whoever answers handoffs** about the new `payment_reported` reason:
   those contacts say they have paid and are waiting for a person to check.
6. **Add eval cases** for your own flows and objections, and run `pnpm eval`
   against the real model (`specs/009-tenant-eval-suites.md`).

#### Measuring it

Two rates, reported separately and never combined:

| Measure        | Over contacts whose first turn fell in the week…      | Where it comes from   |
| -------------- | ----------------------------------------------------- | --------------------- |
| Link-sent rate | …whose payment-link flow was `performed`              | `turns.actions`, here |
| Paid enrolment | …that a person tagged `enrolled` after seeing payment | Your ManyChat account |

Link-sent rate is the one this service can compute. Replace
`enrolment_link` with your payment-link flow's `id`:

```sql
WITH firsts AS (
  SELECT c.id, date_trunc('week', min(t.created_at)) AS week
  FROM conversations c JOIN turns t ON t.conversation_id = c.id
  GROUP BY c.id
), linked AS (
  SELECT DISTINCT t.conversation_id AS id
  FROM turns t, jsonb_array_elements(t.actions) AS a
  WHERE a ->> 'tool' = 'send_flow'
    AND a ->> 'id' = 'enrolment_link'
    AND a ->> 'status' = 'performed'
)
SELECT f.week, count(*) AS contacts, count(l.id) AS link_sent,
       round(100.0 * count(l.id) / count(*), 1) AS link_sent_pct
FROM firsts f LEFT JOIN linked l USING (id)
GROUP BY f.week ORDER BY f.week;
```

A rising link-sent rate with a flat enrolment rate means the agent is asking
too early, or too hard. Only the enrolment rate tells a better agent from a
pushier one, so read real conversations after rollout as well: the golden set
only catches the pressure phrasings someone thought to write down.

### Several courses in one funnel (optional)

To sell more than one catalog course through the same funnel, record the
contact's course in a field and tie each course's content to it
(`specs/028-multi-course-funnels.md`). Two keys turn it on:

- **`course: true`** on one field marks where the contact's course is kept. Its
  `values` must be exactly the `id`s of the courses in `catalog.json`, in any
  order, and it may not be the funnel field.
- **`course`** on a flow names the catalog course it belongs to. The agent can
  send that flow only once the contact is on that course. A flow without a
  `course` (an intro, testimonials, the payment link) is available for every
  course.

The agent places a contact who has no course yet, by asking or once the fit is
clear, before it sends any course content. It may move them to another course
until the stage is `offered`. From then on the course is locked, and a contact
who asks to switch goes to a person as `explicit_request`. A flow the contact
already received stays sent when the course changes.

Most of the setup is in your ManyChat account:

1. **Create the course field** with the name you put in `field`.
2. **Send it to the agent.** Add `"course": "{{course}}"` to the Dynamic
   Block's request body, using your field's name inside the braces. The agent
   adds the key to its own follow-up callbacks, but the Dynamic Block your entry
   flow calls is configured by you.
3. **Set it in each advert's entry flow,** so a lead who comes from one
   course's advert starts on that course. Without it the agent asks.
4. **Branch the payment flow on it.** One payment-link flow serves every
   course. It reads the course field and sends that course's link. Nothing here
   can see that branch, so test it by hand for every course.

### Reading the contact and writing notes (optional)

`get_contact` lets the agent read what is recorded on the contact right now,
including what your own flows set. It returns ids only: the tags you list that
the contact has, the value of each field you list, and each note's text. It
never returns the contact's name, phone, email or anything you did not list. A
field holding a value that is not one of its `values` reads as `other`.

- **`readable`** lists tags and fields your flows set that the agent may see
  but never write, in the same shape as `tags` and `fields`. For example a tag
  your ad flow adds.
- **`notes`** lists free-text fields the agent may write, for whoever follows
  up. Each has `id`, `field`, `description`, `maxLength` (at most 500) and
  `"neverRendered": true`. The last is your promise that no flow ever shows
  that field to a contact: nothing here can check it, so the file refuses to
  load without it.
- **`onEscalation: true`** on a note, usually a handoff summary, means it is
  still written when the agent hands the contact to a person. Every other
  action is dropped on a handoff.

Before a note is written, links, emails, phone numbers and long numbers are
replaced by `[removed]`, whitespace is collapsed, and the text is cut to
`maxLength` at a word. A name or any other detail in prose is not removed. A
note replaces what the field held. The turn record and the logs hold the
note's length, never its text.

The agent reads only on a turn that carries the contact's token, at most twice
a turn, and gives up on a read after 1.5 seconds. A failed read is logged at
`warn` as `contact read failed` and the turn goes on without it.

### Follow-ups (optional)

A `nudge` section lets the agent follow up once with a contact who stops
replying, while WhatsApp's 24-hour window is still open. The design is in
`specs/025-in-window-nudge.md`. A timer does not decide this: the agent decides
whether a follow-up would help, and what it says. The server only checks that a
follow-up is still allowed when it is due.

```jsonc
{
  "nudge": {
    "delays": [
      { "id": "later_today", "minutes": 120 },
      { "id": "tomorrow", "minutes": 1200 },
    ],
    "humanActiveTag": "human-handling",
  },
}
```

- **`delays`**: the waits the agent may choose from, at least one. `id` follows
  the same rules as every other `id`. `minutes` may be at most **1380** (23
  hours). The hour of margin covers the worker's poll, a deferred delivery and
  the model call, so the follow-up still lands inside the 24-hour window. Any
  more fails the boot.
- **`humanActiveTag`** (optional): the name of a tag your team or your flows
  set in ManyChat while a person handles the contact. When it is due, a
  follow-up for a contact with that tag is cancelled. The model never sees the
  name. It may not be one of your `tags[].tag`, so the agent can never add or
  remove the tag that silences it.

Without a `nudge` section the agent is offered no `schedule_nudge` tool, and
the follow-up worker has nothing to do.

#### How a follow-up runs

1. **The agent schedules it.** On an ordinary turn the model may call
   `schedule_nudge` with a delay id, usually after an offer, an objection or a
   question of its own. Like every action it is only staged. It is discarded if
   the turn hands off, and it is performed after the reply has gone out.
2. **One waits at a time.** Performing it writes a row in the `nudges` table,
   due `minutes` after that moment. Scheduling again replaces the one that is
   waiting. The database allows only one pending row per conversation.
3. **Anything that makes it wrong cancels it.** See the table below. All of
   these checks run before the model is called, so a cancelled follow-up costs
   nothing.
4. **At due time it is a model turn.** The worker checks every 15 seconds,
   claims due rows with `FOR UPDATE SKIP LOCKED`, and runs the agent with the
   conversation's history. In place of a contact message it gets a note from
   the system:
   `[no reply from the contact since 2026-01-15T10:00:00.000Z; decide whether to follow up]`.
   No contact wrote that note, so it is not fenced. The contact never sees it.
   A follow-up turn is not offered `schedule_nudge`, so it cannot schedule
   another one. After a contact's last message they get at most one follow-up,
   and then nothing until they write again.
5. **The model may decline.** It declines by escalating. Nothing is sent, not
   even your `escalation` message, because the contact asked nothing. No person
   is notified, and any action it staged is dropped. The turn is recorded as
   `nudge_skipped` and never appears in later history. A failed model call ends
   the same way.
6. **Otherwise it is delivered like a deferred reply.** Nobody is waiting on a
   Dynamic Block, so the reply goes straight to the outbox: written to
   `MANYCHAT_REPLY_FIELD`, rendered by `MANYCHAT_REPLY_FLOW_NS`, then any
   actions it staged. The turn is recorded as `nudge_sent`. It counts against
   the budget, the hourly rate and the turn cap like any model turn.

```mermaid
flowchart TD
    staged["The model stages schedule_nudge"] --> handoff{"Does the turn hand off?"}
    handoff -- yes --> dropped(["Discarded, no row"])
    handoff -- no --> pending(["pending, due after the delay"])
    pending -- "the contact writes, the conversation escalates, or link_sent is written" --> cancelled(["cancelled, with the reason"])
    pending -- "due" --> checks{"Still allowed? Window, funnel, caps, takeover tag"}
    checks -- no --> cancelled
    checks -- yes --> model["Model turn on the system note"]
    model --> declined{"Did the model escalate?"}
    declined -- yes --> skipped(["skipped: nothing sent, nudge_skipped turn"])
    declined -- no --> sent(["sent: outbox delivers it, nudge_sent turn"])
```

#### Why a follow-up is cancelled

| `cancel_reason`   | When                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `contact_replied` | The contact sent any message, before the follow-up was due or while its model call was running |
| `escalated`       | A turn of the conversation handed off to a person                                              |
| `link_sent`       | The funnel field reached `link_sent`: the sale is closed                                       |
| `window_closing`  | At due time, more than 1380 minutes have passed since the contact's last message               |
| `human_active`    | At due time, the contact has the `humanActiveTag` tag                                          |
| `read_failed`     | At due time, the contact's tags could not be read from ManyChat                                |
| `cap_reached`     | At due time, the daily budget, the hourly rate or the turn cap would refuse the turn           |

A cap never sends your escalation message for a follow-up. The contact asked
nothing, so there is nothing to hand off. A failed tag read cancels rather than
sends: an unprompted message on top of a person's conversation is worse than a
missed follow-up.

#### Seeing what happened

Each row of `nudges` holds the conversation id and no contact data. Its
`status` is `pending`, `running` (claimed by the worker), `sent`, `skipped` or
`cancelled`, and `cancel_reason` is set when it is cancelled. A row left
`running` means the process stopped during the turn. That follow-up is lost,
never sent twice.

```sql
-- What became of follow-ups in the last week
SELECT status, cancel_reason, count(*)
FROM nudges
WHERE created_at > now() - interval '7 days'
GROUP BY 1, 2 ORDER BY 3 DESC;

-- Reply rate: follow-ups the contact answered within 24 hours
SELECT count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM turns r
         WHERE r.conversation_id = n.conversation_id AND r.role = 'user'
           AND r.created_at BETWEEN n.created_at AND n.created_at + interval '24 hours'
       ))::float / NULLIF(count(*), 0) AS reply_rate
FROM turns n
WHERE n.outcome = 'nudge_sent';
```

The reply rate is the only evidence that follow-ups help rather than annoy.
Report it next to the link-sent rate of `specs/023`. It does not say whether a
follow-up read as helpful or as pressure. For that, read the follow-up
conversations themselves.

#### Before turning follow-ups on

- **Tag every takeover.** A person who takes a conversation over without
  setting `humanActiveTag` is invisible to this check. So is a tag spelt
  differently from `humanActiveTag`: the match is exact, and nothing warns you
  when it never fires. Without a `humanActiveTag` there is no takeover check at
  all.
- **The window is computed from what this service saw.** A contact who wrote to
  you through a flow that never reached this service has a later window than
  the one computed here. The error is on the safe side: the follow-up is
  cancelled, never sent outside the window.
- **Reads need `MANYCHAT_API_TOKEN`.** Without it, every follow-up for a tenant
  with a `humanActiveTag` is cancelled as `read_failed`.
- **Test the follow-ups.** An eval case with `"nudge": true` runs as a
  follow-up turn on its `history`, and `text` is ignored. In `cases.jsonl` it is
  one line:

  ```json
  {
    "id": "nudge-after-instalments",
    "history": [
      {
        "role": "user",
        "text": "can i pay in instalments?"
      },
      {
        "role": "agent",
        "text": "Yes, any course can be paid in three equal monthly instalments."
      }
    ],
    "nudge": true,
    "text": "",
    "expect": {
      "escalate": false
    },
    "must_contain": ["instalment"],
    "review": "Follows up on paying in instalments, in one short message that does not press."
  }
  ```

  `expect.escalate: true` asserts the model declines. Run them with `pnpm eval`
  against the real model.

- **Turn off timed reminders.** A ManyChat sequence that messages quiet
  contacts on a timer sends a second follow-up on top of this one.

### Startup checks

`tools.json` is validated like the other config files: a malformed file fails
the boot, and a malformed reload is refused and the previous config is kept. A
file is also refused if it names an object this service already uses for
delivery:

- a flow whose `flowNs` is `MANYCHAT_REPLY_FLOW_NS`;
- a field whose `field` is `MANYCHAT_REPLY_FIELD` or `MANYCHAT_TOKEN_FIELD`;
- a note whose `field` is either of those, a `fields` entry's `field`, or
  another note's.

It is also refused if more than one field is marked `funnel`, if a funnel field's
values are not the five stages in order, or if more than one flow has
`role: "payment_link"`. With courses, it is refused if more than one field is
marked `course`, if one field is marked both `funnel` and `course`, if the course
field's values are not exactly the catalog's course ids, if a flow names a course
the catalog does not have or has a `course` with no course field, or if the
payment-link flow has a `course`. A note without `"neverRendered": true` or with a
`maxLength` over 500 is refused too, and so is a `nudge` delay over 1380
minutes, or a `humanActiveTag` that is empty or is one of your `tags[].tag`.

### What happens on a turn

1. **The model chooses.** It may call tools before writing its reply. A call
   only stages the action. Nothing reaches ManyChat while the model is running.
   A turn stages at most 8 actions, and identical calls count once. A call past
   the limit is dropped. The model gets up to three rounds of tool calls before
   it must write the reply, so it can read, act and read again.
2. **The model writes the reply.** It is told what was staged and that nothing
   has been sent yet, so it says what it is sending rather than claiming it
   has sent it.
3. **The guardrails decide.** If the turn ends in a handoff for any reason, every
   staged action is discarded. The reasons are: the model escalated,
   confidence was too low, a prompt leak, an invalid reply, a failed model call,
   or `MODEL_ABORT_MS`. A note marked `onEscalation` is the one exception: it is
   still written when the model escalated or confidence was too low.
4. **The text goes first, then the actions.** On an inline reply, the actions run
   after the response to ManyChat has been sent. On a deferred reply, the outbox
   worker runs them after it has delivered the text, and if the reply is
   dead-lettered its actions are dropped. Actions run in the order the model
   staged them, one request each, with a 10-second timeout. Each gets one
   attempt: a failure is logged at `warn` as `action failed` and is not retried.
5. **Later turns remember.** History shows the model a line such as
   `[actions performed: send_flow foundation_brochure]` under the reply that
   performed it, so it does not send the same flow again. Only `performed`
   actions are listed. The server writes that line, and the guardrails remove
   it if the model copies it into a reply.

Turns where the model does not run (the scripted opening, escalation keywords,
budget, rate and turn caps) offer no tools and stage nothing.

### Seeing what the agent did

Every agent turn records its actions in the `actions` column of `turns`. It is
`null` when no tool was offered and `[]` when tools were offered and none was
chosen. Otherwise it has one entry per staged action:

```json
[{ "tool": "send_flow", "id": "foundation_brochure", "status": "performed" }]
```

How an action reaches each status. The rounded boxes are the statuses you will
see in the column:

```mermaid
flowchart TD
    call["The model calls a tool"] --> cap{"8 actions already staged this turn?"}
    cap -- yes --> over(["dropped_over_cap"])
    cap -- no --> handoff{"Does the turn end in a handoff?"}
    handoff -- yes --> discarded(["discarded"])
    handoff -- no --> staged(["staged"])
    staged --> deadline{"Reply ready before the 8 s race deadline?"}
    deadline -- yes --> inline["Dynamic Block response sent"]
    deadline -- no --> outbox{"Outbox delivers the reply?"}
    outbox -- "no, dead-lettered" --> dead(["dead_lettered"])
    outbox -- yes --> run
    inline --> run["One request to ManyChat, 10 s timeout"]
    run --> accepted{"ManyChat accepts it?"}
    accepted -- yes --> performed(["performed"])
    accepted -- "no, or timed out" --> failed(["failed"])
```

| `status`           | Meaning                                                    |
| ------------------ | ---------------------------------------------------------- |
| `staged`           | Waiting to be performed, after the response or the outbox  |
| `performed`        | ManyChat accepted the request                              |
| `failed`           | ManyChat refused it or it timed out; `error` says why      |
| `discarded`        | The turn ended in a handoff                                |
| `dropped_over_cap` | Staged past the limit of 8 and never sent                  |
| `dead_lettered`    | Its deferred reply was dead-lettered, so it was never sent |

Entries hold ids and values only, never ManyChat names or contact text. A note's
entry holds its `length` instead of its text. An entry
that stays `staged` means the process stopped before the action ran. That action
is never retried.

```sql
SELECT t.created_at, t.outcome, t.actions
FROM turns t JOIN conversations c ON c.id = t.conversation_id
WHERE c.subscriber_id = '<subscriber id>' AND t.role = 'agent'
ORDER BY t.seq;
```

### Before turning tools on in production

- **Expect slower replies.** A tool turn takes two to four model calls. In a
  local run on 2026-09-28 with `openai:gpt-5-mini` at low reasoning effort,
  four two-call tool turns took 8.4 to 15.5 seconds. All of them missed the 8-second deadline, so each
  contact got the holding message first and the answer through the outbox.
  The same model answered a question with no tools offered in 5.8 seconds.
- **Test the descriptions.** No check can tell whether a `description` leads the
  model to the right flow. Add eval cases that state the expected choice with
  `expect.actions`, as the golden set does:

  ```jsonl
  {"id":"flow-brochure","text":"can you send me something to read about the foundation course?","expect":{"escalate":false,"actions":["send_flow foundation_brochure"]}}
  {"id":"flow-not-for-schedule","text":"when does the weekend intensive run?","expect":{"escalate":false,"actions":[]}}
  ```

  `[]` asserts that tools were offered and none was chosen. Run them with
  `pnpm eval` against the real model.

- **`performed` is ManyChat's answer, not the contact's.** It means ManyChat
  accepted the request. A flow that is unpublished, or points at a missing file,
  can still be accepted. Send each flow to yourself once from ManyChat before
  listing it here.
- **Actions need `MANYCHAT_API_TOKEN`.** Without it every action is recorded as
  `failed`.
