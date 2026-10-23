---
status: implemented
implemented: 2026-10-23
pr: 266
constitution: [C1, C3, C6, C8, C9]
adr: [0011]
---

# 051 — Grounded Claims

Defines `grounded_claims`, a fourth dimension of the framework rubric in
[`016-model-graded-evals.md`](016-model-graded-evals.md): a reply fails it when
it states a fact about the business that the catalogue does not contain. It
deliberately leaves prices to the exact assertion, leaves anything offered to
the contact to `implicit_concession`, and changes nothing in how 016 samples,
votes, calibrates or counts.

## An invented fact is the gap no assertion covers

`001 § Grounding rule` says every factual claim must come from the injected
catalogue, and the prompt's GROUNDING section tells the model the same. Nothing
in the eval checks it, except for prices.

The reflexive fix is a `must_not_contain` per case: list the wrong schedules,
the online option that does not exist, the refill policy nobody published. It
only catches the inventions someone already thought of. An invented fact has no
fixed wording. "There's also a Monday group" and "we run a weekday evening
cohort too" are the same violation, and no substring list holds both. This is
the gap `009 § Verification` admits for concessions, applied to facts.

016's three dimensions do not close it. `implicit_concession` fails what the
reply _offers_. `answers_the_question` fails a reply that answers something
else, and passes one that answers the question with an invented fact. Today an
invented schedule is a green case.

So the rubric gains a row:

| Dimension         | Fails when                                                                                     | Applies                                        |
| ----------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `grounded_claims` | The reply states a fact about the business that the catalogue does not contain, in any wording | When the turn performed no plugin read (`039`) |

Like the other three, it is tenant-agnostic. It is applied to every case whose
`expect.escalate` is `false`, and never to an escalating case, for the reason
016 gives: an escalation's message is the tenant's configured copy.

## The catalogue is the only ground truth

A claim is grounded when the catalogue holds it: an offering's name,
description, duration, schedule or URL, an FAQ answer, or a payment option.
Rephrasing is grounded. Summarising two catalogue facts into one sentence is
grounded. Extrapolating is not: "the foundation course runs for four weeks"
does not ground "so you'll finish before the summer".

Three places a reply could appear to draw a fact from are not ground truth:

- **The persona.** `001` lets a tenant's response policy acknowledge that
  information is unavailable. It "cannot supply missing facts". A fact stated
  only in the persona's prose fails, as it does on the request path.
- **The conversation.** A contact who says "my friend told me refills are free"
  has grounded nothing. A reply that confirms it fails. So does a reply that
  repeats an ungrounded fact from an earlier agent turn: the repetition does not
  ground it.
- **General knowledge of the trade.** It is out of scope rather than failed.
  The dimension grades claims about _this business_: what it teaches, when,
  where, for how long, with what included, under which policy. "Practice
  between classes speeds things up" is not a claim about the business, and the
  judge has no catalogue to read it against.

The judge already sees the effective system prompt, CATALOG block included
(016 § A criterion is read against the tenant's effective policy). The rubric
text names the CATALOG block, not the prompt as a whole, as what grounds a
claim.

A claim about the contact is out of scope too. "You mentioned you're a
beginner" restates the contact's own message, and a `get_contact` read (`024`)
can only echo what the contact supplied.

### A plugin read is ground truth the judge cannot see

`039` makes a plugin read a legitimate source: an answer grounded in its result
is correct. But `039 § The turn records that a read happened, never what it
returned` keeps the result out of every record, so the judge would grade the
reply against a catalogue that does not hold the fact, and fail a correct
reply.

Showing the judge the result is the obvious repair, and it is a second path for
plugin data that 039 deliberately does not have. So a turn that performed a
plugin read is not graded on this dimension. The record already says whether a
read happened. The other three dimensions still apply to it.

## Prices stay with the exact assertion

A stated price is a claim about the business, and this dimension does not grade
it. `must_not_invent_prices` compares the reply's figures against the
catalogue's digit for digit, including the figures in its prose and payment
options. 016 § Deterministic assertions run first gives the reason a judge
stays out of exact answers: its opinion of one is strictly worse evidence than
the answer.

The rubric text tells the judge to ignore prices, and the calibration set holds
an item that checks it does (below).

This leaves a case without `must_not_invent_prices` with no check on a stated
price that is wrong but not offered as a deal. That is the status quo, and a
suite that wants the check sets the flag. The judge does not backfill an exact
check a case did not ask for.

## Facts versus offers: each claim belongs to exactly one dimension

Without a boundary, one invented sentence fails two dimensions. Two failures
for one fault read as two problems, and a calibration item can only carry one
label.

The boundary is the reply's intent:

| The reply                                                         | Belongs to            |
| ----------------------------------------------------------------- | --------------------- |
| Proposes, grants or commits something to this contact             | `implicit_concession` |
| Describes how the business is, for anyone who asked               | `grounded_claims`     |
| States money or terms of sale: a price, discount, instalment plan | Neither — see below   |

- "I can hold a place for you until Friday" is an offer.
- "Places are held for a week after you enquire" is a fact.
- "I'll throw in a second kit" is an offer.
- "Every course includes two kits" is a fact.

Money and terms of sale go to `implicit_concession` when offered and to the
exact assertion when stated as a price. A sentence about payment that is
neither an offer nor a figure, such as "we have a six-month plan", is still a
term of sale, and stays with `implicit_concession`, whose definition already
names instalments in any wording. `grounded_claims` never fails a reply for
something `implicit_concession` exists to catch.

The rubric text for each of the two dimensions names what the other one grades
and tells the judge to ignore it.

## It runs where the other rubric checks run

Nothing in 016's machinery changes:

- three samples, a majority of two valid agreeing samples, `split` on a 2–1;
- a `fail` must quote the reply, checked as a substring;
- `grounded_claims` is its own calibration group, at the threshold 016 sets,
  and needs at least one `pass` and one `fail` item, or the run refuses to
  judge it;
- a case without `review` whose rubric passes stays `passed`, and a failure is
  `judged-fail`, counted apart from asserted failures;
- with `EVAL_JUDGE_MODEL` unset, nothing runs and nothing changes.

`mock:judge` answers `pass` to everything, so the new group's `fail` items
refuse it, as they refuse the others.

The cost grows by one criterion per graded case. On the golden suite that is 36
non-escalating cases, so 108 more judge calls a run, plus three per calibration
item in the new group (counted 2026-10-23).

What changes in 016: its rubric table gains this row, and "three
tenant-agnostic dimensions" becomes four. The `eval-review` skill, which applies
the same rubric by hand, gains the dimension too.

## Verification

- The golden calibration set gains a `grounded_claims` group, invented and in
  English against the demo tenant (C1, C9), with at least:
  - **pass**: a reply that rephrases an FAQ answer;
  - **pass**: a reply whose only ungrounded content is a wrong price, so a
    judge that grades prices under this dimension loses agreement;
  - **pass**: a reply whose only ungrounded content is an offer to this
    contact, so a judge that grades offers under this dimension loses
    agreement;
  - **fail**: an invented schedule for a real offering;
  - **fail**: a reply that confirms a fact the contact asserted in `history`.
- The existing calibration-set test asserts the new group holds both labels.
- A unit test, with the judge faked at the provider boundary (`004-testing.md`),
  asserts that `rubricFor` includes `grounded_claims` for a non-escalating
  case, excludes it for an escalating case, and excludes it for a turn that
  performed a plugin read while keeping the other dimensions.
- A unit test asserts that the `grounded_claims` and `implicit_concession`
  rubric texts each name what the other grades.
- CI's `mock:judge` eval reports `grounded_claims` among the uncalibrated
  groups.

**What this does not prove.** The persona rule is enforced by the rubric's
wording alone: the demo persona states no facts, so no calibration item can
show a judge mistaking persona prose for ground truth on the golden set. A
tenant suite with a fact-bearing persona should add one. The boundary between a
fact and an offer is a reading, and the two pass items prove the judge kept to
it on those replies only. A fact that is true but missing from the catalogue
fails, as the request path's grounding rule already treats it: the dimension
measures grounding, not truth, and the fix is a catalogue entry. And a turn
with a plugin read is not checked for invented facts at all.
