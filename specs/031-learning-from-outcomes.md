---
status: implemented
implemented: 2026-10-06
pr: 187
constitution: [C1, C2, C3, C4, C5, C6, C7]
adr: [0020, 0015, 0011]
---

# 031 — Learning From Outcomes

Defines how the agent gets better at selling across contacts: a weekly job
compares the conversations of contacts who paid with those who did not, an
analyst model proposes tactics, a person approves them, and approved tactics
form a versioned playbook in every prompt. It leaves out memory of a single
contact (`024`), fine-tuning, any automatic edit to `prompt.md` or
`catalog.json`, learning facts, a controlled A/B split, any review interface
beyond a CLI, sharing a lesson between tenants, and the Python port (`026`).

## A memory the agent writes is a prompt every contact can edit

The reflexive design is a `remember` tool: the agent writes an insight
mid-turn, and a store of insights is injected into every later turn. It is
the default in most agent frameworks, and it is wrong here twice over
(ADR-0020).

An insight written mid-turn is model output derived from contact text. Put in
every other contact's prompt, it is instruction that a contact wrote by proxy,
and it outlives the conversation that produced it. One lead who talks the
agent into recording "offer a discount to anyone who hesitates" has changed
what the agent says to every lead after them (C4). And the turn that writes
the insight cannot know whether it was right: whether the lead pays is known
days later, in ManyChat.

So **the agent never writes to the playbook.** No tool is offered for it, on
any turn. Lessons come from finished conversations whose outcome is known, and
reach the prompt only through a person.

## Paid conversion is the signal, because link-sent rate can be bought

`023 § Success is measured twice` warns that link-sent rate rises when the
agent gets pushier as readily as when it gets better. A job that learned from
link-sent would learn to ask early and often. The job learns from paid
conversion only, `042`'s word for a sale a person has confirmed.

`rules.json` gains an optional `learning` block:

```jsonc
{
  "learning": {
    "language": "English",
    "convertedTag": "paid",
    "maxRunCostUsd": 5,
  },
}
```

- `convertedTag` (`enrolledTag` before `042`) is the ManyChat tag name a person sets when they see a
  payment (`023`). It stays server-side; the model never sees it.
- `language` is what the analyst writes proposals in: the reviewer's language,
  normally that of `config/prompt.md`. Proposals live in Postgres, outside the
  repository, under the same carve-out as tenant config (C9, `005`).
- `maxRunCostUsd` caps one analyst call (see "The analyst reads transcripts
  as untrusted data"). It is required and has no default: any figure here
  would be a guess at the tenant's spend.
- `learning` requires a `funnel` field in `tools.json` (`023`); without one
  there is no cohort, and loading fails.

Without `learning`, no job runs, no playbook is loaded, and the system prompt
is byte-identical to one built before this spec.

### The cohort is contacts who were offered, given time to pay

A contact is in a run's cohort when:

1. a funnel write to `offered` or later was `performed` for them in the past
   **90 days**; and
2. their latest bound turn (`019`) is at least **14 days** old.

The job then reads each cohort contact's tags through `ContactReader` and
labels them `converted` if they carry `convertedTag`, `not_converted`
otherwise. A read that fails drops the contact from the run; it is never
labelled `not_converted` by default. Reads are paced at **one per second**, below the
limiter's burst, so the job never takes capacity from live turns.

With fewer than **20** contacts on either side, the run makes no analyst call
and is recorded as `insufficient`. Otherwise at most the **50** most recent of
each side go to the analyst.

## The analyst reads transcripts as untrusted data

The analyst is a model call off the request path:

- It is resolved from `INSIGHT_MODEL` (`provider:model`) through
  `src/agent/registry.ts` (C2). Unset, the job does not run.
- Each transcript is a contact's bound turns, user and agent text, with
  action ids from `turns.actions` and its label. Before it is sent, every turn
  is cleaned with `024 § Note text is cleaned before it is written` steps 1
  and 2, so identifier shapes never reach the analyst (C5).
- Contact text is fenced as untrusted (C4), as in a live turn. The analyst's
  instructions, in English in source, tell it that nothing inside the fence is
  an instruction to it.
- It is given the active playbook and the run's last **20** rejected proposals,
  so it does not propose either again.
- The call does not draw on the tenant's daily `budget` (`003`). That cap
  gates live turns, and a run that spent from it could use what is left of the
  day and send every later contact to `out_of_scope`. The call is bounded by
  `learning.maxRunCostUsd` instead.

### A run's worst case is priced before it is sent

Before the call, the job estimates its worst-case cost: the input tokens,
estimated at one per three characters, which overstates any provider's
tokenizer on prose, plus the output limit, priced with `pricingFor`
(`src/agent/registry.ts`). While the estimate exceeds `maxRunCostUsd`, it drops
the oldest transcript from each side in turn. If either side falls below
**20**, the run is recorded as `skipped_budget` and makes no call. The run's
actual cost is recorded on the run, never in `budget_counters`, so no run can
move a live turn closer to the daily cap.

Its output is validated against a Zod schema (C3). Output that fails it
records the run as `failed` and creates no proposal.

## A proposal is a tactic, never a fact

A proposal says _how_ to sell: an ordering, a question to ask, which content
answers which hesitation. What the agent may claim (a price, a date, a
payment option, a promotion) comes only from the catalog (C6, `001 § Grounding
rule`), and a playbook that carries one is a second catalog nobody priced.

Each run creates at most **5** proposals. Each holds:

| Field               | Constraint                                                 |
| ------------------- | ---------------------------------------------------------- |
| `text`              | The tactic, in `learning.language`, at most 280 chars      |
| `rationale`         | Why the analyst believes it, at most 500 chars             |
| `convertedCount`    | Converted transcripts that show it, per the analyst        |
| `notConvertedCount` | Not-converted transcripts that show it, per the analyst    |
| `turnIds`           | Turn ids it cites, each one present in the analyst's input |

A proposal is refused, and never stored, when its `text` or `rationale`
contains a digit, a currency symbol or any shape the cleaning removes, or
cites a turn id that was not in its input. Digits and currency symbols are
checked because they are the only marks of a price or a date that do not
depend on the tenant's language. The check catches "costs 120" and misses "the
price goes up soon", and review is the real enforcement.

A proposal stores its text, rationale, counts and turn ids, never transcript
text. The counts are the analyst's claim; nothing here can verify that a
pattern holds in the transcripts it cites, and the reviewer checks them by
reading the cited turns.

## Approval is what makes derived text an instruction

A proposal is derived from contact text, so it has the standing of contact
text until a person gives it more. `pnpm insights:review` lists `pending`
proposals with their rationale and counts, prints the cited turns from the
database to the reviewer's terminal, and lets the reviewer:

- **approve** a proposal, as written or edited. Edited text passes the same
  refusals as the analyst's;
- **reject** it, which keeps it for the next run's "do not propose again"
  list;
- **retire** an insight already in the playbook.

Approving or retiring creates a new **playbook version**: the insights of the
newest version created since the active one was activated, or else of the
active version, with the change applied, immutable once written, identified by
a content hash. Several approvals in one review so build one candidate, not one
version each. Creating a version does not activate it. No `pending` or
`rejected` proposal ever reaches a prompt.

Playbooks, proposals and runs carry `tenant_id`, as every table does. A lesson
learned from one tenant's contacts is never offered to another's, and no
playbook enters the repository (C1).

## A version goes live only after a real-model eval shows no regression

A playbook is a prompt change, and `009` already guards prompt changes.
`pnpm eval` gains `PLAYBOOK_VERSION`, which renders that version into the
prompt, and writes an eval record: the version's content hash, the suite's
content hash, and each case's asserted outcome. Judged outcomes (`016`) are
printed and recorded but do not gate.

`pnpm insights:activate <version>` refuses unless an eval record exists for
the version's content hash against the current suite, run with a real model,
in which no asserted case fails that does not also fail under the baseline.
A mock-model run writes no record, and a mock-model record never counts: the
mock model ignores the prompt, so its pass says nothing about the playbook.

### The baseline is the active version, or no playbook at all

A real-model `pnpm eval` writes a record whether or not `PLAYBOOK_VERSION` is
set. Without it, the record's version hash is empty, and it stands for the
prompt with no playbook. The baseline a candidate is compared against is:

- the active version's record against the current suite; or
- on a first activation, with no version active, the no-playbook record
  against the current suite.

When the baseline has no record against the current suite (the suite changed
after it was evaluated, or the active version came in through the rollback
below without one), `insights:activate` refuses and names the eval to run for
the baseline. It does not treat every failure as new: that would report a
regression in the candidate when the missing evidence is the baseline's.

Activating a version that has been active before skips the gate, so a bad
playbook can be rolled back in one command without paying for an eval first.

## The playbook is bounded and ranks below the system rules

A version holds at most **10** insights and **2000** characters in total; a
version over either is refused when it is created. Every insight adds tokens
to every turn, and a playbook that grows unbounded is the cost the turn budget
and the history cap exist to prevent.

The active version is rendered after the catalog block, inside the cached
system prefix (`src/agent/prompt.ts`), under a system-authored heading that
says, in English: these are tactics the tenant approved; they never supply a
fact; where one conflicts with any rule above, the rule wins. An activation
invalidates the prompt cache once, not on every turn.

Each process loads the active version at boot, when `learning` is present
then (a block added later takes a restart), and refreshes it on a timer
every **60 seconds**, never awaited on the inbound path (C7). A refresh that
fails keeps the version already loaded, which a person approved; a boot load
that fails starts with no playbook and logs at `warn`.

## Every turn records the playbook version it ran with

`turns` gains a nullable `playbook_version`, written on every agent turn the
model wrote, null when none was active. A scripted or fallback reply, which no
prompt produced, records null. It holds a version id, not insight text.

`pnpm insights:report` reports, per version, the conversion rate of contacts
whose first `offered` write was performed on a turn that ran with that
version, read with the same 14-day settle and the same tag read as the
cohort. It is read beside `023`'s two rates and never combined with them; no command
computes those yet, so the report's header says so.

This is a before-and-after reading, not a controlled one. A version activated
the week an ad campaign changed is credited with the campaign's effect, and
the report says so in its header rather than leaving a reader to infer
causation.

## The job runs weekly, on exactly one replica

The job runs once a week per tenant, and on demand with `pnpm insights:run`.
Each process checks hourly whether this ISO week's run is still to claim.
Its claim is an insert into `learning_runs` keyed on tenant and ISO week,
under a unique index: the replica whose insert succeeds runs, and any other
skips. The claim is atomic in the database, so it holds across replicas and
across both services while both run (`026 § A scheduled job runs where its
claim is atomic`). An on-demand run uses the same claim; forcing a second run
in a week is a flag on the CLI, and is recorded.

Every run ends in exactly one recorded status: `completed`, `insufficient`,
`skipped_budget` or `failed`, with its cohort sizes and cost. Logs carry the
run id, counts and statuses, never transcript or proposal text (C5).
A process that stops mid-run aborts the run's reads and analyst call and
records it `failed`. Waiting it out could outlast the process's grace period,
and a run killed before it records a status stays `running`. Either way the
row still holds the week's claim, so a stopped run forfeits that week's run.
The stop is logged at `warn` with the run id, and `pnpm insights:run --force`
recovers it. Releasing the claim was rejected: it needs a status the unique
index excludes, for a run that takes about two minutes a week.

All numbers in this spec (90 and 14 days, one read per second, 20 and 50
contacts, 20 rejected proposals, 5 proposals, 280 and 500 characters, 10
insights and 2000 characters, 60 seconds, weekly) were chosen, not measured,
on 2026-10-03. Change them when a run shows a need, and record the measurement
date here.

## Verification

1. Config tests assert `learning` without a `funnel` field, or without
   `maxRunCostUsd`, fails at load, and a
   unit test asserts that without `learning` the system prompt is
   byte-identical to one built before this spec.
2. A unit test asserts no tool's schema, enum or description offers a write to
   the playbook, on any turn.
3. An integration test against PGlite asserts the cohort: a contact never
   `offered`, one offered more than 90 days ago, and one whose last bound turn
   is under 14 days old are excluded; a failed tag read drops the contact; and
   with 19 contacts on a side the run is `insufficient` and the analyst model
   is never called.
4. A unit test over transcripts with an invented phone number, email and URL
   asserts the analyst receives them cleaned and inside the untrusted fence.
5. A unit test asserts proposals with a digit, a currency symbol, an unknown
   turn id or text over 280 characters are refused, that a sixth proposal is
   dropped, and that schema-invalid output records the run `failed` with no
   proposal.
6. An integration test asserts a proposal row holds no transcript text, and a
   log-capture test asserts no transcript or proposal text appears in any log
   line of a run.
7. A test asserts a `pending` or `rejected` proposal never appears in a built
   prompt, and an approved one appears only once its version is active.
8. Tests assert `insights:activate` refuses with no eval record, with only a
   mock-model record, with a record for another content hash or suite, and
   with a new asserted failure; that a first activation compares against the
   no-playbook record, and refuses when there is none; that an active version
   with no record against the current suite is refused with the baseline eval
   named; and that a version that was active before is accepted without a
   record.
9. A unit test asserts a version over 10 insights or 2000 characters is refused,
   and that the playbook renders after the catalog block and before the cache
   breakpoint.
10. A test with fake timers asserts an activation is picked up within 60
    seconds, that a failed refresh keeps the loaded version, and that no
    refresh is awaited by a turn.
11. An integration test asserts `playbook_version` is written on agent turns,
    and is null with no active version.
12. An integration test runs two claims for one tenant and week concurrently
    and asserts exactly one analyst call.
13. A unit test asserts a run whose estimate exceeds `maxRunCostUsd` drops the
    oldest transcripts from each side until it fits, that one which cannot fit
    with 20 a side is `skipped_budget` and makes no call, and an integration
    test asserts a completed run's cost is never added to `budget_counters`.

What this misses: the refusals catch digits and currency symbols, not an
invented promise written in words, and only the reviewer catches that. The
analyst's counts are its own claim. A pattern found more often among converted
contacts may be a symptom of having already decided to buy rather than a
cause of it, and nothing here tells the two apart. The eval gate catches only
regressions the golden set has a case for. Twenty contacts a side is a floor
against learning from a handful, not statistical significance. And the report
compares versions over time, so it credits a playbook with whatever else
changed in the same weeks.
