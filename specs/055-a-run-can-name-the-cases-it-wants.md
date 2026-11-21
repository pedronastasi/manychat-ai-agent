---
status: specified
constitution: [C1, C6, C8]
---

# 055 — A Run Can Name the Cases It Wants

Defines selecting individual cases from an eval suite on the command line: how
they are named, and what happens when a name matches nothing. It extends
[`009-tenant-eval-suites.md`](009-tenant-eval-suites.md), which defines the
suite, the `Case` schema and the assertions, and changes none of them. It
deliberately leaves out selecting by anything other than id — tag, stage,
category — and the scripted conversations of
[`043`](043-complete-conversation-evals.md), which have their own command.

This is a separate spec rather than a section in `009` because `009` is
`implemented` and this is not. `008-spec-metadata.md § Four statuses are enough`
settles that: a spec that gains a section nobody built is how a status rots, and
the part that has not shipped is its own spec.

## The whole file is the wrong grain for the work a suite is for

`EVAL_DIR` selects a suite. Nothing selects a case, so the smallest thing a
tenant can run is all of it.

That is the wrong unit for the loop the suite exists to serve. The work is:
change one rule in the prompt, find out whether the three cases covering that
rule moved. What the CLI offers instead is every case, at a model call each. On
a tenant suite of 128 cases that is a measured $0.13 and about twenty minutes
(demo-tenant suite against `anthropic:claude-haiku-4-5`, measured 2026-11-21) —
per iteration, for three cases' worth of information.

The cost is not mainly money. It is that nobody iterates at twenty minutes a
turn. The suite stops being the thing you check a change against and becomes
the thing you run once at the end, which is where a tenant discovers that a
prompt edit made four other stages worse.

The workaround available today is to copy the wanted cases into a scratch
directory and point `EVAL_DIR` at it. It works, and that it works is the
argument for this spec: the mechanism is already there, and every tenant that
needs it is reimplementing the same ten lines outside the repository.

## Cases are named by exact id, because a substring hides what it is about to do

```sh
agent eval                                    # the whole suite at EVAL_DIR
agent eval price-foundation enrol-link-released   # those two cases
```

Arguments are matched against `id`, exactly.

The reflexive alternative is a substring or glob match, and it reads better:
`agent eval payment` to run the payment cases. It is refused because the operator
cannot tell what it will do. `payment` is two cases or twenty depending on a file
they are not looking at, and that number is exactly what decides the run's cost
and duration — the two things this spec exists to control. A selector whose
breadth is invisible at the point of typing reintroduces the problem it was
added to solve.

Exact ids also make the command a record of what was run. `agent eval
price-foundation enrol-link-released` in a commit message or a PR body says
precisely
which cases were checked; `agent eval payment` says so only in combination with
the suite as it stood that day.

## An id that matches nothing runs nothing and exits non-zero

The run stops before any model call, naming the id that matched no case.

The alternative is to warn and run whatever did match. It produces a specific
and bad failure: a mistyped id selects zero cases, every assertion that executed
passed because none executed, and the summary reports a green run. A suite that
reports success for work it did not do is worse than one that fails, because
nobody looks a second time. `009 § A tenant suite covers its funnel stage by
stage` makes the same argument about missing coverage — "a stage with no case is
a stage nobody is watching, and the suite's pass count actively conceals that".
A filter that silently drops an id is that, per run.

This is C6 on the command line, in the form
[`054`](054-an-unrecognised-argument-stops-the-command.md) fixes it: an argument
the command cannot honour stops the command.

## The error names the rejected id and not the valid ones

The message contains the id the operator typed. It does not list the ids that
would have worked.

The affordance is refused for C1. The valid values are the ids in the tenant's
own `cases.jsonl`, and those ids are an index of a real business — what it
sells, what it is asked, where it loses the sale. `009` argues that a tenant's
cases are tenant configuration in everything but file extension; their ids
inherit that. A "did you mean…?" prints them to the terminal, and under CI into
a build log that outlives the run and is readable by anyone with repository
access.

The operator has the suite open in front of them and can read it. The build log
must not.

## Filtering changes nothing about how a case runs

Same config resolution, same assertions, same summary line. The counts describe
the cases that ran.

That last part is the one worth stating, because a filtered run invites being
quoted as though it were a suite result. `2 passed` after
`agent eval price-foundation enrol-link-released` is a claim about two cases and no
claim whatsoever about the other 126. A PR's Verification table citing a
filtered run has to say which cases, or it is reporting a number that reads like
coverage and is not.

## Verification

- A unit test asserts that selecting a subset of ids runs exactly those cases,
  by counting model invocations against a stub rather than reading the printed
  output: a test over stdout would pass against a runner that executed the whole
  suite and printed two of them.
- A unit test asserts that an id matching no case exits non-zero and invokes the
  model zero times.
- A unit test asserts the error text contains the rejected id and contains no
  other id from the suite it ran against.
- A unit test asserts the summary counts equal the number of selected cases, not
  the number in the file.
- `pnpm eval:mock` with no arguments continues to run the whole golden set, which
  is the claim that this is additive.

**What this does not prove.** None of it checks that the cases an operator
selected are the ones relevant to their change — a filter makes it cheap to run
three cases and no cheaper to pick the right three, and a green filtered run is
the most confident-looking way to miss a regression two stages away. The spec
can require that the summary describe the selection; it cannot stop a PR from
quoting that summary as though the suite had run.
