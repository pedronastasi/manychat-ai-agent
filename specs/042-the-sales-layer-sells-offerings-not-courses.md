---
status: specified
constitution: [C1, C8, C9]
adr: [0015]
---

# 042 — The Sales Layer Sells Offerings, Not Courses

Defines the words the framework uses for what a tenant sells and for a sale
that completes, everywhere the framework owns them: `catalog.json`,
`tools.json`, `rules.json`, the turn request, the system prompt's scaffolding,
the learning job, the eval case and the database. It amends `001`, `002`,
`003`, `009`, `023`, `026`, `028`, `029`, `031`, `032` and `034`, listed at the
end. It leaves out the shape of the funnel: the
six stages of `023`, their order and what moves a contact between them stay as
they are, and only the words around them change.

## The first tenant's business became the domain model

The reflexive way to build a vertical feature is to build it for the customer
in front of you. The first deployment sells courses, so the sales layer was
written in that customer's words, and the words became structure:

- `CatalogSchema` requires `courses`, and each one has an `enrollmentUrl`.
- `tools.json` marks a field `course: true`, and a flow names a `course`.
- The turn request carries `course`, and `conversations.course` stores it.
- The system instructions tell the model that "students, former students,
  suppliers" write in, that a prospect "asks about enrolling", and that the
  field "records the course this contact is buying".
- The learning job labels transcripts `enrolled` and `not_enrolled`, keyed on
  `enrolledTag`.

None of it is tenant data, so C1 never flagged it. All of it is a vertical the
framework assumes on every tenant's behalf. A clinic, a repair shop or an
agency can configure the agent today only by calling its services courses, and
the model then reads an instruction about students on every turn for a
business that has none. Even `test/fixtures/config-alt`, the fixture that
exists to prove a second tenant works, is a school.

The README promises an agent for any business behind a hard webhook timeout.
The race, the outbox and the ports keep that promise. The sales layer does not.

## Renaming the words in place is the same bug again

The obvious fix is a find-and-replace: `course` to `product`, `enrol` to
`purchase`. That picks a different vertical. A product is something shipped; a
haircut, a consultation and a repair are not, and a model told it is selling
products to a contact booking a consultation is as misled as one told about
students.

This is the argument of `005 § This is not a translation task`, applied to the
domain instead of the language. Translating hardcoded Spanish to English left a
codebase that served one linguistic market; renaming hardcoded courses to
products leaves one that serves one kind of business. The rule is the one
`005` reached:

> **The framework names what is sold and what completes a sale in words no
> vertical owns. The tenant's configuration supplies the vertical.**

## The framework says "offering" and "buy", and the tenant supplies the rest

Two words carry the scaffolding:

| Concept                                          | Framework word | Replaces                |
| ------------------------------------------------ | -------------- | ----------------------- |
| One thing in the catalog a contact can buy       | offering       | course                  |
| The contact paying for one, as a person confirms | conversion     | enrolment               |
| The verb the instructions use for that           | buy            | enrol                   |
| Someone who already bought, or is being served   | customer       | student, former student |

The prompt scaffolding of `src/agent/prompt.ts` uses only these: "an offering
and its catalog price have been put to the contact", "they mean to buy, or are
weighing it", "existing customers, suppliers and job seekers write in too". The
section headed `COURSES` becomes `OFFERINGS`, and the per-turn notices become
`OFFERING:`.

No vocabulary is configured. The rejected alternative is a `rules.json` block
such as `{ "item": "course", "purchase": "enrol" }` interpolated into the
scaffolding. It is unnecessary: under `005 § The four categories` the
scaffolding never reaches a contact verbatim, and the model already reads what
is sold from `CATALOG` and how to talk about it from `config/prompt.md`. A model
told to put "an offering" to a contact whose catalog lists a knife-skills class
says "class". The block would also be a second place a tenant's words live,
which a tenant would have to keep in step with the first.

What a tenant's customers typically ask, and what a sale is called in its
trade, belongs in `config/prompt.md`, as `034` already says of intent.

## `catalog.json` lists offerings

`courses` becomes `offerings`, still required and non-empty. Each entry:

| Key             | Type             | Change                                 |
| --------------- | ---------------- | -------------------------------------- |
| `id`            | string           | unchanged                              |
| `name`          | string           | unchanged                              |
| `description`   | string           | unchanged                              |
| `price`         | `Money`          | unchanged                              |
| `durationHours` | number or `null` | now optional, absent meaning `null`    |
| `schedule`      | string or `null` | now optional, absent meaning `null`    |
| `url`           | URL or `null`    | renamed from `enrollmentUrl`, optional |

The prompt renders `url` as `url:`, not `enrolment_url:`. `durationHours` and
`schedule` stay because a fixed-length service and a booking slot use them as
readily as a course; they become optional because a product has neither, and
a required `null` is a course-shaped hole every other tenant has to fill.

The price grounding of `src/agent/guardrails.ts` reads `offerings` and is
otherwise unchanged.

## The offering field and the flows tied to an offering replace the course ones

In `tools.json`, a field marked `"course": true` is marked `"offering": true`,
and a flow's `"course"` key is `"offering"`. Every rule `003`, `028` and `032`
state
for them carries over under the new name: at most one offering field, not the
`funnel` or `intent` field; its `values` exactly the catalog's offering ids; a
flow's `offering` one of them; none on the `payment_link` or `opening` flow;
the offering locked from `offered` on. One offering per contact at a time
stays the rule.

`conversations.course` is renamed `conversations.offering` by a migration that
keeps every stored value.

## The request carries `offering`, and still accepts `course`

The turn request gains `"offering": "{{offering}}"`, with the same treatment
`002` and `028` give `course`: optional, at most 256 characters, and an empty,
unrendered or unknown value is no offering. A request that carries `course`
and no `offering` is read as if `course` were `offering`. When both are
present, `offering` wins and `course` is ignored.

This is the one place this spec keeps the old name, because it is the one place
`agent upgrade` cannot reach. The External Request body is configured in the
tenant's ManyChat account, not in `config/`, so a migration cannot rewrite it,
and a request that stopped carrying the contact's offering would silently
detach every flow tied to one. Removing `course` from the request is a later
breaking change, made once deployments have moved.

## A completed sale is a conversion

In `rules.json`, `learning.enrolledTag` becomes `learning.convertedTag`, with
the same meaning: the ManyChat tag a person sets on seeing a payment, never
shown to the model. The learning job labels transcripts `converted` and
`not_converted`, the analyst's instructions say so, and the `enrolled_count`
and `not_enrolled_count` columns of `learning_runs` and `insight_proposals` are
renamed `converted_count` and `not_converted_count` by a migration that keeps
their values. Their TypeScript names follow: `enrolledCount` and
`notEnrolledCount` in `src/contracts/learning.ts` and `src/learning/`, and the
`OutcomeLabel` values. `pnpm insights:report` reports a conversion rate.

## Existing tenants move with `agent upgrade`

Every rename inside `config/` is breaking in the sense of
`033 § A release is a version bump, and a breaking config change ships its
migration`, and ships as one migration in the pull request that implements
this spec:

- `catalog.json`: `courses` to `offerings`, and each `enrollmentUrl` to `url`;
- `tools.json`: a field's `course` to `offering`, and a flow's `course` to
  `offering`;
- `rules.json`: `learning.enrolledTag` to `learning.convertedTag`.

An eval case's `contact.course` and `contact.advert_course` (`009`) become
`contact.offering` and `contact.advert_offering`. A renamed eval case field is
breaking by the same `033` definition, and a tenant's suite lives in its
project beside `config/`, so `agent upgrade` rewrites the `cases.jsonl` under
`EVAL_DIR` with the same migration, and the case loader accepts only the new
keys.

The migration is idempotent: a config or suite already in the new shape is left
byte-identical. It invents no value and touches neither `config/prompt.md` nor
any ManyChat object. The loader accepts only the new shape; a config in the old
one fails at boot naming the key and `agent upgrade`, rather than being read
through an alias that would leave two shapes in the code indefinitely. The
release bumps the minor (`010`).

## A second fixture tenant that is not a school proves the scaffolding neutral

A neutral scaffolding is a claim no test of the demo academy can check, since
every word the academy's catalog supplies is one the old scaffolding also used.
So the pull request adds `test/fixtures/config-repair`: an invented
appliance-repair business, written in English, whose offerings are a diagnostic
visit, a repair and a maintenance plan, with prices that match no deployment
(C1). It has an offering field, a funnel field, an intent field, a
`payment_link` flow and a content flow tied to one offering.

It carries its own suite, `evals/repair/cases.jsonl` (`009`), run by
`eval:mock` in CI beside the golden set with `CONFIG_DIR` pointing at the
fixture. Its cases ask a price, a booking time, for the payment link, and say
they are an existing customer with a broken appliance; none mentions a course.

The mock model answers a price question and a schedule question from the
first offering in the system prompt's `CATALOG`, not from a sentence about the
demo academy: its price, then its `durationHours` and `schedule` when present
and nothing when they are absent. So the repair suite's
`must_not_invent_prices` cases hold, and its booking-time case gets the
offering's schedule rather than a course's. The demo academy stays the
default tenant, the bootstrap example and the README's demo.

## What this changes in other specs

- `001 § Role`: the agent answers about a business's catalog of offerings, and
  for everyone who is not a prospect, an existing customer among them, it
  does not ask them to buy.
- `002`: the request's optional key is `offering`, with `course` accepted as
  above.
- `003`: `catalog.json` lists `offerings` as tabled above; `tools.json`'s
  field marker and flow key are `offering`; `rules.json`'s learning tag is
  `convertedTag`.
- `009`: a case's `contact` carries `offering` and `advert_offering`; its
  examples use the new keys.
- `023`: "enrolment" in its measures and stage descriptions reads
  "conversion". The stages are unchanged.
- `028`: course reads offering throughout; the rules are unchanged.
- `029 § Course scoping first`: becomes offering scoping; a flow for another
  offering is refused before any request.
- `031`: the signal is paid conversion; the labels and the tag are renamed as
  above.
- `032`: the `offered` stage reads "an offering and its catalog price have been
  put to the contact"; an `opening` flow carries no `offering`.
- `034`: the intent criteria are stated in the words of the table above, and
  an advert's course is an advert's offering.
- `026`: the Python port uses the new names from its first line, so its module
  mapping, including the state table's course row, never carries the old ones.

Examples elsewhere that name a course as one tenant's data, such as `012`'s
brochure flow and `024`'s note, are illustrations of the demo tenant and stay.

## Verification

1. A unit test builds the system prompt from `test/fixtures/config-repair` and
   asserts that, with the tenant's `prompt.md` and catalog text removed, it
   contains none of `course`, `enrol`, `student` or `academy`, in any case.
2. A unit test builds the system prompt from the demo tenant and asserts the
   `OFFERINGS` section and the `OFFERING:` notice replace `COURSES` and
   `COURSE:`, with the rules of `028` otherwise intact.
3. Config tests assert that a catalog with `courses`, a field marked
   `"course": true` and a `learning` block with `enrolledTag` each fail at
   load, naming the key and `agent upgrade`.
4. A test runs `agent upgrade` on a config and an eval suite in the old shape
   and asserts the new shape loads; runs it again and asserts no file changed; and asserts
   `config/prompt.md` is untouched.
5. A contract test asserts a request with `course` only, `offering` only, and
   both, stores the offering as described, `offering` winning.
6. An integration test against PGlite asserts the migration keeps every
   stored `course` value as `offering`, and every count in `learning_runs` and
   `insight_proposals` as its renamed column.
7. `eval:mock` passes on `evals/repair` against `test/fixtures/config-repair`
   in CI, beside the golden set.

What this misses: item 1 catches four word stems, not every way a vertical can
leak into scaffolding. "Syllabus", "class" or "tuition" would pass it, and so
would an instruction whose logic assumes a course while naming none, such as
one that assumes every offering has a start date. The repair suite catches
some of that, and only for the phrasings its cases thought of. Review is the
real enforcement, as it is for `005`.
