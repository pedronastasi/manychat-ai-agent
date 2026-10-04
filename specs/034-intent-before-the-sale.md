---
status: specified
constitution: [C1, C4, C6, C9]
adr: [0015]
---

# 034 — Intent Before the Sale

Defines how the agent learns whether a contact means to enrol before it sells
to them, what the server withholds until it knows, and what a contact who is
not a prospect gets instead. It amends `001`, `023`, `025` and `032`, listed
at the end, and leaves out sorting non-prospects by kind (student, supplier,
job seeker) or routing them to different people, demoting a prospect, flows a
tenant would send to non-prospects, and every message outside WhatsApp's
24-hour window.

## Not everyone who writes is a lead

The reflexive chat-marketing agent treats every inbound contact as a lead:
whoever writes has entered the funnel, and the only question is how far along
it they are. `023` built that shape. Every contact starts at `new`, meaning "a
lead we know nothing about yet", the SALES instructions open with "You take
the contact from their first reply to the payment link", and `032` sends the
opening flow on every first model turn that does not escalate.

It is wrong here for three reasons.

- **The front desk is also the sales desk.** The same number is written to by
  current students asking about a class, alumni asking for a certificate,
  suppliers, job seekers and wrong numbers. Each of them is qualified, sent
  the opening and asked to enrol. A student told to buy the course they are
  already taking stops trusting the number they were given.
- **A pitch to a non-lead is not free.** It costs the contact a message they
  did not want, and costs the tenant flows sent once per contact (`023 § Every
content flow is a leaf, sent once`) that are then spent on someone who will
  never need them.
- **The measures count them as lost sales.** `023`'s link-sent rate divides by
  every contact with a first turn. A week with many students writing in looks
  like a week the agent sold badly.

So **the server withholds the sale until the model has recorded that the
contact is a prospect, and the model judges that from what the contact
says.** Until then the agent is the front desk `001` describes: it answers
from the catalog and escalates the rest.

## Intent is a field the model records, not a guess the server makes

A `set_field` enum field in `tools.json` may carry `"intent": true`. Its
values are exactly `not_prospect` and `prospect`, in that order. A contact
with no value recorded is _unknown_.

| Intent         | Meaning                                                       |
| -------------- | ------------------------------------------------------------- |
| unknown        | Nothing the contact said yet shows whether they mean to enrol |
| `not_prospect` | The contact wrote for something other than enrolling          |
| `prospect`     | The contact means to enrol, or is weighing it                 |

Intent moves one way: unknown to `not_prospect` to `prospect`, and unknown to
`prospect`. `prospect` is final. A staged write that would leave it, or move
`prospect` back to `not_prospect`, is refused with `{ staged: false }`, as
`023` refuses a backward stage.

The server knows a contact's intent from its own records: the last
`performed` write to the intent field in `turns.actions`, or a write staged
earlier in the same turn. It never reads intent from the inbound request or
from the contact's ManyChat fields, so nothing the channel sends can open the
sale (C4). Each turn the model is told the result in an `INTENT:` notice,
beside `FUNNEL:` and outside the fence.

At most one field may carry `intent`, a field may not be both `intent` and
`funnel` or `course` (`028`), and a funnel field requires an intent field:
each is a load failure. A deployment that sells cannot run without the gate.
The field and its values are the system's, not the tenant's, as `023`'s stages
are.

## What counts as prospect intent

The system instructions tell the model to record `prospect` when the contact:

- asks about enrolling, or about a course's price, dates, modalities, duration
  or requirements;
- says they want to learn what a course teaches, or asks which course suits
  them;
- asks for the payment link or how to pay;
- arrived through a course's advert, so the entry flow set their course
  before they wrote (`028`).

And `not_prospect` when the contact says they are already enrolled, are a
former student, offer a product or service, ask for work, or wrote to the
wrong number.

Anything else is left unknown. A bare "hi" is unknown: the reply greets the
contact and asks how it can help, in the tenant's voice, and pitches nothing.
Unknown intent is not uncertainty about an answer, so it is not
`low_confidence`; a contact who has not said what they want is asked.

The list is system instructions in English, the same for every tenant (C9).
What a tenant's prospects typically ask belongs in `config/prompt.md`.

## Until intent is `prospect`, the sale's tools refuse

Before the contact is a prospect, every write except the intent field and the
notes refuses:

| Tool                                | Before `prospect`                           |
| ----------------------------------- | ------------------------------------------- |
| `set_field` on the intent field     | Accepted                                    |
| `set_field` on any other field      | `{ staged: false, reason: "not_prospect" }` |
| `send_flow`, every flow             | `{ sent: false, reason: "not_prospect" }`   |
| `add_tag`, `remove_tag`             | `{ staged: false, reason: "not_prospect" }` |
| `schedule_nudge` (`025`)            | `{ staged: false, reason: "not_prospect" }` |
| `get_contact`, `write_note` (`024`) | Unchanged                                   |
| The opening flow (`032`)            | Not sent (see the next section)             |

A refusal makes no request and, like `032`'s `not_prepared`, does not count
against the turn's action cap (`012 § The loop is bounded at four steps`).

The gate checks the contact's intent as the server knows it, which includes a
write to `prospect` staged earlier in the same turn. So a first message that
asks the price is answered, recorded as `prospect` and qualified in one turn,
exactly as `032` lets the model record `prepared` and send the link together.
The tools stay in their enums; refusing rather than removing them is what
makes the same-turn unlock possible.

Every tool is gated, not only the ones that look like selling. A tenant flow
that would help a non-prospect, a map to the school, say, is left out of this
spec: deciding which flows are sales would be a per-flow judgement nothing
here can check, and refusing all of them fails closed (C6).

## The opening waits for a prospect

`032` sends the opening flow on the contact's first model turn. This replaces
that rule: **the opening is sent on the turn that first stages a write of
`prospect`, if that turn's reply does not escalate**, then the reply is
delivered after it, as `030` says. That may be the first turn ("how much is
the course?") or a later one ("actually, I would like to enrol").

- **A non-prospect never receives it.** A contact who stays unknown or
  `not_prospect` is never sent the opening.
- **At most once.** A contact with an `origin: "opening"` entry in
  `turns.actions` is not sent it again, whatever their intent does next.
- **It needs the write.** A contact who counts as a prospect by the rollout
  rule below never staged the write, so is not sent it.

The model learns of it from the write itself: `set_field`'s result for the
intent write names the opening as `openingQueued`, so the reply does not
repeat what the flow says and closes with the question the flow asks. That
replaces `032`'s first-turn system instruction, since the server cannot know
before the loop runs that this turn will make the contact a prospect.

Everything else in `032 § The opening flow is the server's, not the model's`
holds: the model never chooses it, it is recorded with `"origin": "opening"`,
it does not count against the cap, and a lost race sends it when the deferred
call settles.

## A non-prospect gets the front desk, and can still become a lead

A contact who is unknown or `not_prospect` is answered as `001` describes:
grounded answers from the catalog, and an escalation, with the reasons in
`001 § Escalation` unchanged, for anything the catalog cannot answer. A
student asking whether Thursday's class is moved is escalated as
`out_of_scope` if the catalog does not say; that is the front desk working.

The reply does not sell. The closing question offers further help, never the
enrolment, and the SALES instructions apply only from `prospect` on. `001`
rule 8, "continue the sales flow", becomes "continue the conversation".

`not_prospect` is not a verdict. A supplier who asks, two messages later,
what the course costs is a prospect from that turn: the model records it, the
opening goes out, and the funnel starts at `new`.

## Existing contacts are not asked again

When this spec is rolled out, a contact whose last `performed` funnel stage is
past `new` counts as `prospect` without a write. They were already being sold
to, and an agent that stopped mid-sale to work out whether they wanted to buy
would lose them. Every other existing contact starts unknown.

## Success is measured over prospects

Two measures join `023 § Success is measured twice`, from `turns.actions` in
this service:

| Measure            | Definition                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------ |
| Prospect share     | Contacts with an intent write of `prospect` over contacts with a first turn, the same week |
| Prospect link-sent | Contacts whose payment-link flow was `performed`, over prospects that week                 |

`023`'s link-sent rate over every contact is still reported, so the series
before and after rollout stays comparable. A prospect share that falls while
the volume of contacts holds steady means the model is reading leads as
non-leads, which is the failure this spec cannot see turn by turn.

## What this changes elsewhere

- `001 § Role`: the agent sells only to a contact recorded as a prospect, and
  is the front desk for everyone else; rule 8 drops "sales".
- `023 § The funnel is a field the agent moves`: a funnel write is refused
  before `prospect`; `§ Qualify before sending content` begins once the
  contact is a prospect; `§ Success is measured twice` gains the two measures
  above.
- `025 § The agent schedules a nudge`: `schedule_nudge` refuses before
  `prospect`, so a non-prospect is never followed up.
- `032 § The opening flow is the server's, not the model's`: sent on the turn
  that first stages `prospect`, not the first model turn;
  `§ Verification` item 5's "a first 'hi' gets the opening" is reversed.
- `003 § tools.json`: a field takes `"intent": true`, with the load checks
  above.
- `012 § Six tools`: every write but the intent field and `write_note` may
  return `reason: "not_prospect"`.
- `026`: the Python port mirrors all of it.

A deployment's `tools.json` and its ManyChat account must gain the intent
field before the pull request that implements this spec is deployed, or the
file fails at load.

## Verification

1. Config tests assert that a funnel field without an intent field, an intent
   field whose values are not exactly `not_prospect` and `prospect`, two
   intent fields, and a field that is both `intent` and `funnel` or `course`
   each fail at load.
2. A unit test asserts that, before `prospect`, `send_flow`, `add_tag`,
   `remove_tag`, `schedule_nudge` and `set_field` on any field but intent
   return `not_prospect` with no request; that `get_contact` and `write_note`
   are unaffected; that each is accepted after `prospect` is performed or
   staged earlier in the turn; and that a write from `prospect` to
   `not_prospect` is refused.
3. A unit test asserts the `INTENT:` notice follows the last performed write,
   ignores an intent value in the inbound request, and reads a contact whose
   funnel stage is past `new` and who has no intent write as `prospect`.
4. An integration test over the ManyChat HTTP boundary asserts the opening is
   sent before the reply on the turn that first stages `prospect`, on a first
   turn and on a later one; not sent on an unknown or `not_prospect` turn, on
   an escalating turn, to a prospect by the rollout rule, or a second time.
5. Golden eval cases, demo tenant: a first "hi" is not sent the opening, calls
   no sales tool and asks how it can help; a first price question is recorded
   `prospect`, sent the opening and answered; a current student and a
   supplier are recorded `not_prospect` and not asked to enrol; a "hi" from a
   course advert is recorded `prospect`; a `not_prospect` contact who later
   asks to enrol is recorded `prospect` and sent the opening.

What this misses: intent is the model's judgement, and every check above
assumes it judged right. A prospect read as `not_prospect` is a lost sale that
looks, turn by turn, like a correctly answered student; only a falling
prospect share and a person reading conversations catch it. The golden cases
cover the phrasings they thought of. And a non-prospect who says, to be sent
something, that they want to enrol becomes a prospect: that is the gate
working as written, not a breach, since everything the sale can send is
already the tenant's to send.
