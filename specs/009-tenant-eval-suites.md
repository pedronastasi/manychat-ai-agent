---
status: implemented
implemented: 2026-09-16
pr: 19
constitution: [C1, C6, C8, C9]
---

# 009 — Tenant Eval Suites

Defines how a tenant carries its own evaluation suite alongside the framework's
golden set: how a suite is selected, what a case may contain, and which
assertions a staged sales conversation needs. It deliberately contains no
tenant's cases, introduces no model-graded scoring, and does not replace the
golden set.

## The golden set and a tenant set answer different questions

`evals/golden/cases.jsonl` asks whether **the framework** regressed. Does
escalation still fire on a refund request, does the fence still hold under
injection, does a reply still come back inside the race deadline. Its cases are
written against the fictional demo tenant precisely so they test nothing about
any real business.

A tenant set asks whether **this business still converts**. Does the agent still
qualify before quoting, still refuse to negotiate, still gate what the tenant
requires gating. Those questions have no answer that is true across tenants.

Conflating them means a change to prompt scaffolding and a change to a tenant's
price copy fail in the same file, and a reader of a red suite cannot tell which
kind of breakage they are looking at.

## Adding a tenant's cases to the golden set is the reflexive move, and it is wrong three times over

The obvious approach is to append the tenant's cases to
`evals/golden/cases.jsonl` and be done. It fails on three independent grounds,
and each alone is sufficient.

**C1 forbids it.** A funnel case worth writing quotes a real price, names a real
course, or reproduces a real objection. That is tenant data, and this repository
is published.

**It breaks the overlay.** A tenant deploying from a private repository layered
over this one stays rebase-clean only because it touches paths upstream never
touches. `evals/golden/cases.jsonl` is a path upstream edits — C8's definition of
done requires new guardrail behaviour to add a case to it. An overlay that owns
that file inherits a merge conflict on every sync, which is how a tenant ends up
pinned to a stale upstream.

**The status quo is worse than it looks.** A tenant that ships the golden set
unmodified runs the demo academy's English cases against its own catalogue and
persona. The suite goes green. It has asserted that the framework escalates on
the word "refund" and nothing whatsoever about the tenant's own conversation.
Green here is not weak evidence; it is evidence about a different system.

`005-language.md § The exception, scoped precisely` already carves out a
tenant's real `config/` as non-English and uncommitted. A tenant's eval cases
are tenant configuration in everything but file extension — they quote the
catalogue, they are written in the reply language, they change when the offering
changes — and this spec extends that carve-out to cover them.

## A suite is selected the way the config already is

`evals/run.ts` already resolves the tenant config from an environment variable
and falls back to the committed default:

```ts
const tenant = loadTenantConfig(process.env.CONFIG_DIR ?? 'config');
```

The case file becomes the same shape:

```ts
const evalDir = process.env.EVAL_DIR ?? 'evals/golden';
const cases = readFileSync(`${evalDir}/cases.jsonl`, 'utf8');
```

Nothing about the default path changes, so `pnpm eval:mock` in a fresh clone
behaves exactly as it does today. A tenant adds `evals/<name>/cases.jsonl` and
runs `EVAL_DIR=evals/<name> pnpm eval`.

One environment variable rather than a suite registry, a manifest, or a glob:
the framework does not need to enumerate a tenant's suites, only to be pointed
at one.

## A case carries history, because an objection is a position in a conversation

The runner calls `run({ text, history: [] })` for every case. That is adequate
for the golden set, whose cases are deliberately isolated probes.

It cannot express an objection. "That is more than I wanted to spend" is a
different turn depending on whether a price was quoted, and a correct reply to it
depends entirely on what the agent said immediately before. Evaluated with empty
history, the model is being asked to object to nothing.

```ts
const Turn = z.object({ role: z.enum(['user', 'agent']), text: z.string() });

const Case = z.object({
  id: z.string(),
  history: z.array(Turn).default([]),
  text: z.string(),
  expect: z.object({ escalate: z.boolean(), reason: z.string().optional() }),
  // ...existing assertions
});
```

`.default([])` is what keeps this additive: every case in the golden set parses
unchanged, and no existing behaviour moves.

## Two substring assertions replace four bespoke ones

The assertions a staged conversation needs look, at first, like four new
primitives: one for ordered disclosure, one for holding a price on a given
payment path, one for refusing to negotiate, one for staying in-flow rather than
escalating.

Three of the four need nothing new.

**Refusing to escalate on an objection** is `expect.escalate: false` with a
history that sets up the objection. The field already exists. What was missing
was the history to make the case meaningful, which the section above adds.

**Holding a price** is a substring assertion. A reply on one payment path must
quote that path's figure and not the other's.

**Ordered disclosure** — some artefact must not be sent until some prerequisite
has been — is a substring assertion _plus_ history, and it is expressed as a
**pair** of cases. One whose history contains the prerequisite, asserting the
artefact is now permitted; one whose history does not, asserting it is withheld.
A single case proves only one side and passes just as well against an agent that
always withholds, or always sends.

Against the demo tenant, whose enrolment URLs are per course:

```jsonl
{"id":"enrol-link-gated","history":[{"role":"user","text":"hi, what do you run?"}],"text":"just send me the signup link","expect":{"escalate":false},"must_not_contain":["https://example.com/enrol/"]}
{"id":"enrol-link-released","history":[{"role":"user","text":"how much is the foundation course?"},{"role":"agent","text":"The Foundation Course is $450 and runs Tuesdays and Thursdays. Want the signup link?"}],"text":"yes please","expect":{"escalate":false},"must_contain":["https://example.com/enrol/foundation"]}
```

So the schema gains two list fields, not four flags:

| Field              | Type       | Asserts                                 |
| ------------------ | ---------- | --------------------------------------- |
| `must_contain`     | `string[]` | Every entry appears in the joined reply |
| `must_not_contain` | `string[]` | No entry appears in the joined reply    |

Both are case-sensitive substring checks over the messages joined with a space.
Case-sensitive because the strings that matter — URLs, account identifiers,
formatted prices — are not prose, and a case-insensitive match on a short token
produces false passes that are harder to notice than false failures.

The fourth assertion is genuinely new, because nothing existing expresses it.

## A message that ends in a full stop ends the conversation

A tenant whose prompt requires every reply to end in a question has a rule the
model drifts off silently. The reply stays accurate, stays on-brand, and stops
advancing. Nothing in the current suite notices, because the reply is correct by
every assertion the runner makes.

```
must_end_with_question: boolean
```

True asserts the final message ends with `?` after trailing whitespace and
trailing emoji are stripped — emoji trail questions routinely, and an assertion
that fails on `"...want the schedule? 🤍"` would be abandoned within a week.

The exceptions are the tenant's to define and are expressed by omitting the
field, not by encoding exception logic here. A tenant whose prompt exempts
escalations and refusals writes those cases without it. The framework does not
know which turns are exempt and must not guess.

## Register is the assertion that cannot be one

A tenant may need replies that read as a warm salesperson rather than a
reference desk — a particular register, a particular emoji density, vocabulary
that lands with that tenant's audience. This is frequently the difference between
a suite that is green and a bot that is working.

No assertion here checks it, and the temptation to add one should be refused.
A regex over emoji counts the emoji; it says nothing about whether the sentence
around it sounds like a person. A model grading tone introduces a second model
whose drift nobody is evaluating, and makes a failing eval ambiguous between the
agent and the judge.

Two things a machine can check honestly:

```
max_lines: number      # no single message exceeds the tenant's format rule
must_end_with_question # above
```

Everything else is delegated, explicitly:

```
review: string         # a criterion a person reads the printed reply against
```

`max_lines` is per message rather than per reply, because a format rule
constrains what lands in the chat as one bubble: two three-line messages are not
a six-line reply.

`review` asserts nothing. It prints alongside the reply, so the person already
reading the output — the runner prints every reply for exactly this reason — is
told what to look for instead of being left to notice drift unprompted. A case
carrying `review` is never counted as failed on its account, and never counted as
fully verified either: the summary line reports reviewed cases separately from
passed ones, so a suite of nothing but `review` cases cannot report itself green.

This is weaker than an assertion and is labelled as such. The alternative on
offer was not a stronger check; it was a weaker check wearing an assertion's
clothes.

## A tenant suite covers its funnel stage by stage, or it covers nothing

A tenant whose prompt names an ordered flow has, in that list, its own coverage
obligation. Every stage the prompt names gets at least one case that **enters at
that stage** — history positioned immediately before it, `text` being the message
that should advance it.

Cases clustered at the opening are the failure mode. They are the easiest to
write, they pass most readily, and they leave every stage where money is actually
at risk unwatched. A stage with no case is a stage nobody is watching, and the
suite's pass count actively conceals that.

Beyond the stages, a tenant suite covers the turns that leave the flow:

| Category     | What the case must pin down                                             |
| ------------ | ----------------------------------------------------------------------- |
| Doubt        | Answered from the catalogue, then returned to the stage it interrupted  |
| Fear         | Handled in-flow, without pressure and without escalating                |
| Objection    | Held, without conceding a price the catalogue does not contain          |
| Hard handoff | Escalates, with the reason the tenant's rules name                      |
| Prohibition  | The reply omits what the prompt forbids, asserted by `must_not_contain` |

The distinction that matters across the first four rows is that a doubt, a fear
and an objection are all `escalate: false` and a handoff is not. An agent that
escalates every objection is failing closed, which C6 permits and a business
cannot afford — the suite is where that shows up as a number.

## Verification

- A unit test parses every `evals/*/cases.jsonl` against the `Case` schema, so a
  malformed suite fails in CI rather than after a paid model run. In this
  repository that covers the golden set; in an overlay it covers the tenant's.
- A unit test asserts the golden set parses with no `history` key present, which
  is the claim that this change is additive.
- `pnpm eval:mock` continues to pass unchanged against the demo tenant. If it
  does not, the default path was altered, which this spec forbids.
- The runner's summary reports passed, failed and reviewed as three separate
  counts, and exits non-zero on any failure. A suite whose cases are all `review`
  reports zero passed.

**What this does not prove.** `must_contain` and `must_not_contain` are substring
checks. `must_not_contain: ["discount"]` catches the word and misses "I can
probably work something out for you", which is the same concession. They pin
down artefacts — URLs, identifiers, formatted figures — reliably, and intent
poorly.

A tenant's suite also cannot run in this repository's CI, because the
configuration it evaluates against is not here and must not be. It runs in the
overlay that holds both. This spec defines the mechanism; it cannot enforce that
any particular tenant uses it, and a tenant suite that is never run is
indistinguishable from one that does not exist.
