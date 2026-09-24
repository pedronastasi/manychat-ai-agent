# ADR-0011 — Model-graded evals, admitted only behind a calibration run

**Status:** accepted · **Date:** 2026-09-24

## Context

`specs/009` refused model-graded scoring: a judge is a second model whose drift
nobody evaluates, and a failing case becomes ambiguous between the agent and the
judge. In its place it put `review`, a criterion printed beside the reply for a
person to read. That holds only while a person reads every reply on every run,
and it stops holding as suites grow. Two gaps are also admitted in writing and
cannot be closed by a substring: a concession phrased without the forbidden
word (`009 § Verification`) and the same answer repeated in different words
(`013 § Verification`).

The reflexive fix is a stronger model asked to rate each reply from 1 to 10,
failing anything under a threshold. The strongest case for it is that it is
cheap to build and immediately catches drift a person skimming output misses.
The strongest case for keeping 009's refusal is that an unvalidated grader turns
every red suite into an argument about the grader. Both are right about the
other.

## Decision

A second model grades eval replies against binary criteria, and its verdicts
count only in a run where it has first agreed with a hand-labelled calibration
set; otherwise they fall back to `review`.

## Consequences

- `review` criteria, implicit concessions and semantic repetition get a verdict
  without a person reading every reply, and a judged failure fails the run.
- 009's objection is answered rather than overruled: the judge is evaluated on
  every run, and its outcomes are counted apart from asserted ones.
- If calibration fails, the suite falls back to exactly what 009 already
  accepts. A bad judge costs visibility, never a false green.
- It costs money per run: three judge calls per criterion per case, plus three
  per calibration item, on top of the agent's own calls.
- It costs a hand-labelled calibration set that someone must write and keep
  honest. The judge is calibrated to that person's labels, not to correctness.
- A judged failure is weaker evidence than an asserted one, and the summary has
  to keep saying so, which adds two statuses a reader must learn.
- The agreement threshold is unmeasured at the time of writing. Until it is, the
  spec demands unanimous agreement, which may leave the judge grading nothing.
- Revisit if no affordable judge model reaches the threshold on the golden
  calibration set, or if a person reading judged failures routinely overturns
  them. Either means the judge is noise, and `review` alone was the better
  instrument.
