---
status: implemented
implemented: 2026-10-24
pr: 273
constitution: [C1, C2, C3, C4, C5, C6, C8, C9]
adr: [0011]
---

# 043 — Complete Conversation Evals

Defines how scripted conversations exercise the agent's complete flow, with
state carried between generated replies, branch coverage, and two independent
runs per scenario. It leaves live delivery, human payment verification, and
tenant-specific scripts to their existing owners.

This is a contract spec. The runner and schemas belong to the framework;
private tenant projects own their branch inventories, scripts, and criteria.
The judge reuses `016`'s calibrated judge, extended to conversations.

## A supplied history cannot prove the agent reached it

The existing runner evaluates each `cases.jsonl` entry independently. A case
can supply history and a contact snapshot, but its generated reply does not
become another case's input. Its staged actions are inspected without being
performed, and inbound flow sends do not receive production-equivalent results.

A suite can therefore pass every isolated stage while the agent cannot reach
those stages in a real conversation. Supplying the correct modality or stage
by hand hides a missed write; supplying a hand-written agent reply hides an
earlier wrong question or premature payment link.

Conversation scenarios start once and execute every step against the actual
replies and performed state left by preceding steps. Existing single-turn
cases remain supported by `009`; their counts and coverage stay separate.

## Scripts supply contact messages and never supply the agent's answers

A suite adds `conversations.jsonl`, `branches.json` and an optional
`fixtures.json` beside its existing files. Each JSONL line is one scenario.
All inputs are schema-validated before any model call; duplicate IDs,
unresolved references, empty scripts, and invalid configured tool or
offering IDs fail validation.

The v1 scenario contract is:

| Field         | Meaning                                                       |
| ------------- | ------------------------------------------------------------- |
| `id`          | Stable, unique scenario ID                                    |
| `description` | Purpose and expected terminal outcome                         |
| `initial`     | Optional initial contact fixture; absent means a new contact  |
| `steps`       | Non-empty ordered list of scripted inputs and expectations    |
| `expect`      | Terminal state, termination kind, and conversation assertions |
| `review`      | Optional list of whole-conversation semantic criteria         |

`initial` may declare contact fields, tags, notes, performed action records,
and preceding history for a returning-contact scenario. Fixtures use
configured IDs and values. They are validated for consistency: a performed
offering write and the stored offering, for example, cannot disagree.
Seeded actions belong to the last agent turn of the seeded history, so a
scenario that seeds actions also seeds an agent turn; seeding never invents
one. Coverage labels distinguish a complete fresh conversation from a seeded
returning-contact scenario. An initial fixture never earns traversal coverage.

Every step has a unique `id`, an `input`, `expect`, and optional `review`:

- `input.kind: message` supplies `text`, optionally a configured advertising
  offering context. An empty string is allowed to exercise opening behavior.
- `input.kind: opening` supplies a configured opening-trigger keyword as a
  trusted channel event. The harness uses a valid isolated contact binding.
  Production matches the trigger on the whole message and cannot tell a
  typed keyword from the flow's event, so validation rejects a `message`
  whose text is an opening-trigger keyword: a script names which it means.
  Scripts cannot inject system instructions or bypass the opening-trigger
  checks.
- `input.kind: media` supplies an invented local fixture with its declared
  kind. Text or a deterministic transcription fixture can accompany it.
  Media fixtures travel through the production media boundary; a receipt
  scenario is identified separately from a text-only payment report.
  ManyChat delivers a file as its URL alone, with no caption, so the step
  names `media` (`audio`, `image` or `video`), `file` (relative to the
  suite, never outside it), `content_type`, and an optional `transcript`;
  text the contact types with it is its own `message` step. The simulated
  media host serves the file, and transcription answers with the step's
  `transcript`, at no cost. What the deployment can read follows its
  settings as production's does: images only when the agent model accepts
  them, speech only when `TRANSCRIPTION_MODEL` is set, video only when
  ffmpeg is installed; otherwise the turn takes the production fallback.
- `input.kind: silence` supplies `advance_minutes`, a week at most. It
  advances an isolated clock and drains any due scheduled nudges. It does
  not manufacture a nudge when no eligible job exists. `expect` includes the
  number of delivered replies or suppression, and may cover a named pending
  nudge: `replies` counts the replies the contact received in the step;
  `nudge` is `sent`, `suppressed` (the nudge ran and the model declined),
  `cancelled` (a check cancelled it at due time) or `none`; and
  `state.pending_nudge` names the pending nudge by its `tools.json` delay
  id, or `null`. The clock moves to each nudge as it comes due, so a nudge
  inside a long silence runs at its own time and not at the silence's end.

Contact messages are fixed. Their text never depends on a judge or a second
model. The agent's own answer is always generated. Within a scenario steps
are sequential; a message such as "yes" receives the question actually asked,
even when that question is wrong. The runner does not rewrite the script to
rescue the agent from a prior failure.

Conversation histories include every delivered message, including the
rendered closing question, and the actual action records. The harness keeps
an ordered delivery trace for customer-visible flow fixtures as well. It
must not insert hand-written assistant turns between generated turns.

## Each scenario runs twice from independent state

Every scenario executes exactly twice, in the same script order. Two is a
user-selected reproducibility check, not a measured reliability threshold.

Each repetition receives a fresh database, contact identity, clock, action
ledger, delivery trace, and nudge queue. No state crosses scenarios or
repetitions. Both use the same frozen config, script, model settings, and
playbook snapshot. Responses are never cached across repetitions.

A failure in either repetition makes the scenario fail. A pass/fail pair is
also labeled `unstable`; it is never averaged into a pass. An unresolved
criterion leaves the scenario pending review unless a known failure already
determines its result. Retrying a scenario starts a new run with its own
record; a retry never replaces the evidence of the previous run.

## The production turn path determines state and action outcomes

The harness runs the production turn orchestration, including scripted
openings, keyword prechecks, guardrails, contact binding, action gating,
opening and stage-tied flows, deferred replies, and nudge decisions. It uses
isolated PGlite and replaces the external model and channel boundaries as
`004` permits. The real-model run uses the configured agent model.

The next step begins only after the current turn's background work, delivered
reply, and eligible staged actions have settled. Virtual flow durations and
nudge delays advance the test clock rather than requiring wall-clock sleeps.
Model deadlines use actual elapsed time; virtual time never makes an
unfinished model call appear to finish within its budget.

The repetition's clock moves by moving its own database's stored times back:
production compares the current time with times it stored, in code and in
SQL, so every stored time moving back by a minute is, to all of it, a minute
passing. Production takes no clock it could be handed, and needs none. A
`date` column moves only when the total advance crosses a day. A reply held
inline for a flow that ends before the race deadline waits in real time,
because that wait is inside the turn's own response and bounded by the
deadline; a reply held past it is queued, and the clock moves to it.

The channel fake implements the production action and contact-read contracts.
It updates fields, tags, and notes only after successful execution. It
returns the same result shape the agent receives in production. In particular:

- A staged write is not a performed write. Escalation discards actions under
  `012`, preserving only eligible escalation notes under `024`.
- A flow already sent inside the inbound tool loop stays recorded even when
  the final reply escalates, as `029` requires.
- Opening flows, stage-tied flows, silent tracking flows, follow-on writes,
  conversion events, and duplicate-send protections use production rules.
- `get_contact` reads the scenario's current fake record. Note writes can be
  checked for presence and validated length without printing their text.
- A successful payment-link action cancels pending nudges as in production.
- Delivery order is recorded, including deferred replies after playing flows.

The harness must reuse these production operations rather than maintain a
second implementation of the sales funnel. Any test seam needed belongs
upstream and is exposed through the package's supported surface (`033`).

Declared channel fixtures map customer-visible flows to authored content or
a labeled content summary for semantic review. Silent flows have no content.
Which flow a criterion depends on cannot be known before the run, so a
suite with any `review` criterion needs a fixture for every customer-visible
flow its tenant configures, and a fixture for a flow that is not configured
fails validation. The trace labels summaries as fixtures; it does not claim
to have downloaded or verified the tenant's live ManyChat media.

Simulated channel, contact, transcription, and media resolution make no
external requests. Paid network traffic is limited to explicitly selected
agent and judge providers. Live plugins with external reads or actions must
have fixture adapters for this mode; otherwise validation rejects the suite.
No adapter contract exists yet, so a tenant that loads any plugin is rejected
until one does.

## Assertions cover steps, transitions, and terminal outcomes

Step assertions retain `009`'s escalation, reason, substring, price grounding,
format, and latency checks over the delivered reply. They also support:

| Assertion           | Meaning                                                                          |
| ------------------- | -------------------------------------------------------------------------------- |
| `state`             | Selected fields, stage, offering, intent, tags, or pending jobs after settlement |
| `actions.required`  | Each matching action exists, allowing unrelated valid actions                    |
| `actions.forbidden` | No matching action exists                                                        |
| `actions.exact`     | The complete matching set equals the expectation, when explicitly needed         |
| `actions.order`     | Matching actions occur in the declared order                                     |
| `delivery.order`    | Matching flows and reply messages appear in the declared order                   |
| `closing_question`  | Required, absent, or a declared exact value in structured output                 |
| `witnesses`         | Branch IDs and the assertion or criterion IDs proving this step reached them     |

Action matchers specify a configured tool/id, optional value, outcome status,
and optional origin. The matcher's status is mandatory: tests must distinguish
attempted, performed, failed, and discarded actions. Production-generated
events and openings are included in the trace and can be matched explicitly.

Whole-conversation assertions support final state, action counts, ordering,
required or forbidden artifacts, and terminal kind: `completed`, `handoff`,
`declined`, or `error`. A run ends `error` on an execution error and
`handoff` on an escalation; otherwise it is `declined` when the contact's
final recorded intent is `not_prospect` (`034`), and `completed`. Artifact
selectors use catalog paths and declared
formatting, so a suite can check the selected offering's price or URL without
copying a price into every script. Unresolved selectors are validation errors.

Temporal assertions compare named steps or trace entries: T&C before bank
details; material discussion before ordinary payment; offering selection before
the offer; no reminder after the link. Scripts separately cover intentional
exceptions, such as a contact explicitly asking to pay before materials.

The same terminal state alone does not prove the flow was respected. Every
intermediate assertion remains decisive, including after a later recovery.

## Branch coverage requires an executed witness

`branches.json` contains the branch inventory and source manifest. Each branch
has a stable `id`, a source file and clause, a description, prerequisite,
transition or condition, expected outcome, and applicable scenario IDs.

The source manifest identifies the behavior-defining prompt, tool
descriptions, rules, and catalog fields using repo-relative paths and hashes.
It keeps framework operating rules distinct from tenant rules. A changed
source hash makes coverage `stale` until the inventory is reconciled and its
affected scenarios rerun. A changed prompt is not covered merely because an
old script still passes.

A branch is covered only when a declared witness actually executes and its
referenced deterministic assertions and semantic criteria pass in both
repetitions. Listing a branch on a scenario, seeding it in `initial`, or
skipping the relevant step earns no coverage. A criterion left ungraded also
leaves its dependent witness unverified.

`branches.json` holds `sources` and `branches`. A tenant source is
`{ "path", "sha256" }`, its path relative to `CONFIG_DIR`, the tenant's own
config directory, and never outside it. A framework source is
`{ "framework", "sha256" }`: `operating-rules` hashes the prompt's framework
text as this tenant's configuration renders it, without the persona and
without section overrides, and `tool-descriptions` hashes the tool
descriptions the model is offered on an inbound turn, with `get_contact` and
flows sent when called. A persona edit leaves the framework
current; a framework upgrade that rewords either makes the inventory stale.
The manifest lists every behaviour-defining tenant file present in
`CONFIG_DIR` (`prompt.md`, `catalog.json`, `rules.json`, `tools.json`,
`prompt-overrides.json`) and both framework sources; one left out is a
validation error, since it could change while the inventory reads current.
A branch has `id`, `source` (`file`, a manifest source such as `prompt.md`
or `framework:operating-rules`, and `clause`), `description`,
`prerequisite`, `condition`, `outcome`, `scenarios`, and an optional
`conflict` naming the competing sources. A step's `expect.witnesses` names
a branch, the step's assertions that prove it by their keys, and its
`review` criteria by position; a witness names at least one. A criterion is
ungraded until the judge of part 3 exists, so a branch proved only by one
stays unreviewed. A source's hash is its file's SHA-256; a stale report
prints both hashes, so a person reconciling the inventory copies the new
one.

Coverage reports separately show declared, attempted, verified, failed,
unreviewed, not reached, and stale branches. Percentages name their
denominator. A suite earns complete branch coverage only when every active
inventory entry is verified in both repetitions and the source manifest is
current. No branch can be silently excluded to make the report green.

This is coverage of the authored inventory, not automatic proof that every
natural-language instruction has been discovered. A person reconciles the
inventory against every prompt section and tool description. It covers each
branch and transition, not every possible combination of user utterances.

Conflicting instructions are explicit inventory blockers. The runner reports
their competing sources and the affected scenarios. An expected failure can
document a conflict, but cannot count as verified coverage or pass promotion.
Changing the policy is a separate behavior change with its own spec updates.

## The judge sees the conversation and quotes its evidence

Deterministic failures cannot be overridden by a judge. Whole-conversation
semantic criteria cover answering the actual question, continuity after a
detour, appropriate next steps, semantic repetition, pressure, tone, and
unsupported concessions or promises. The judge receives the transcript,
ordered fixture deliveries, state transitions, catalog, and criterion.

The judge follows `016` and ADR-0011: model resolution through the registry,
fenced evaluation data, schema-validated binary verdicts, quoted evidence,
three samples per criterion, majority voting, and calibration every run.
The three judge samples are separate from the two agent repetitions.

Conversation criteria require conversation-shaped hand-labeled calibration
items, including passing and failing examples for each graded group. The
judge must quote exact transcript evidence with scenario, repetition, and
step IDs. A missing-event failure quotes the relevant surrounding exchange
and names the absent event. Invalid evidence makes the sample ungraded.

A verdict carries `verdict`, `step`, `evidence`, `absent` and `reason`. The
judge names the step and the run supplies the scenario and repetition, so
the quote is checked against that step's transcript: what the contact sent,
what a flow showed by its fixture, and every reply message. The transcript's
recorded changes (field, tag, offering, pending nudge and action outcomes)
are shown to the judge and cannot be quoted. A step criterion is graded on
the whole conversation, told which step it is about. The judge is consulted
only when no deterministic assertion failed in either repetition, as for a
case under `016`, and a step the script did not reach has nothing to grade.
The calibration set is `conversation-calibration.jsonl` beside the suite:
hand-written transcripts, each with a criterion and a label. Only the groups
the suite's criteria use are calibrated, so a suite pays for the groups it
grades. `EVAL_JUDGE_MODEL` names the judge, as for `016`.

The report keeps deterministic failures, judged failures, judged passes,
pending human review, and execution errors distinct. Calibration failure,
judge outage, or an absent judge leaves semantic criteria pending review;
it never silently satisfies them. The transcript and criteria remain
available for a human to review.

Human review records the criterion verdict, evidence, reviewer reference, and
the immutable run identifier. A human can resolve an ungraded criterion.
Disagreement with a judge is recorded alongside its verdict for investigation;
it does not erase failures or rewrite the original run. Required review work
must be resolved for a conversation to earn full verification.

Review records live in `reviews.jsonl` beside the suite, one per criterion
and repetition: `run`, `scenario`, `repetition`, `criterion` (`review[0]`
for a scenario's, `<step>.review[0]` for a step's), `verdict`, `step`,
`evidence` copied from that step, `reviewer`, and an optional `note`. Beside
a judge's verdict the stricter stands: a person's failure fails the
criterion, and a person's pass does not erase the judge's failure. A review
whose evidence is not in the step it names cannot be applied, and fails the
gate until it is corrected.

## A failed conversation continues until a terminal event

An assertion failure marks the repetition failed but does not skip the next
scripted input when the harness can continue. Subsequent failures are retained
and labeled downstream of the first failure, without guessing causality.

A human handoff ends the script. The runner checks whether it occurred at the
expected step, with the expected reason and allowed side effects. Remaining
steps are reported as not reached. An expected handoff can pass its scenario;
an early unexpected handoff fails it and cannot cover later branches.

Suppression on a nudge turn is not a human handoff. It can correctly produce
no customer message while the scripted conversation continues later.

An unrecoverable harness, model, or media error ends the repetition and marks
it failed. A provider error that production converts to a fallback remains
identified as an execution error even if the fallback's escalation matches
an expected handoff. Infrastructure failure never passes a behavior test.

Independent scenarios and the second repetition still run. The report shows
not-reached steps, incomplete transcripts, and failure categories explicitly.

## Reports identify the evaluated version and the first deviation

A run emits machine-readable JSON and a readable Markdown transcript in a
configurable, gitignored artifact directory: `EVAL_ARTIFACTS_DIR`, by default
`.eval-artifacts/`. Its record contains:

- Suite, scenario, and repetition IDs; start time; framework version; config,
  source-manifest, script, fixture, and calibration hashes; agent and judge
  model/settings; and playbook version or explicit absence.
- Every input and delivered reply, its closing question, ordered flow
  fixtures, state differences, action outcomes, guardrail interventions, and
  model errors. Internal note text and contact tokens are omitted.
- Every assertion and semantic criterion, its verdict and evidence, first
  failing step, terminal outcome, skipped steps, and repetition comparison.
- Branch coverage, source conflicts, pending reviews, latency per agent turn,
  agent cost, judge cost, and total cost, without treating unknown costs as zero.

Scripts use invented contact data. Tenant-language transcripts and artifacts
stay in the private tenant environment (C1, C9). Operational logs obey C5;
explicit eval transcripts are private artifacts rather than message-body logs.
Credentials, real subscriber identities, token bindings, and private notes
must not appear in those artifacts or CI output.

Human-review records bind to the immutable evaluated hashes. An edit to the
prompt, catalog, tools, rules, scenarios, fixtures, calibration, or playbook
requires a new run rather than reusing a previous approval. A run's
`evaluated` hash covers the framework version, the tenant config, the
framework's rendered rules and tool descriptions, the scenarios, fixtures,
inventory and calibration, the agent and judge models, the temperature and
the playbook; its `runId` is that hash's prefix and the start time, so no
two runs share one. Costs are reported as agent, judge and total; with no
judge the judge's cost is null, not zero.

## Offline validation and paid conversation runs are separate commands

The package exposes `agent eval conversations --validate` for schema,
reference, source-inventory, and fixture validation without provider calls,
and `agent eval conversations` for the two-repetition execution. Both use
the existing `CONFIG_DIR` and `EVAL_DIR` selection rules.
Validation exits nonzero on a suite with no `branches.json`, a stale source
or a conflicted branch, as a run does: none of them can become gate
evidence. The framework's golden suite pins its manifest to CI's fixture
tenant, `test/fixtures/config`.

Real runs explicitly select the agent and judge models. CI runs validation
and meaningful harness tests with mock providers. A mock result proves the
harness executes; it is never evidence of prompt quality or a promotion gate.

Tenant projects run real conversations under demand and against the changed
version before publishing a prompt or tool-description change. Publication
requires both repetitions to pass, a current fully verified branch inventory,
and resolved required semantic criteria. Single-turn checks remain additional
checks; their pass cannot substitute for a missing conversation run.

The command exits nonzero on failure, execution error, incomplete coverage,
stale inventory, source conflicts, or required criteria pending review. JSON
distinguishes these outcomes for automation. Users may inspect a partial run,
but it must not generate successful gate evidence.

The report estimates call counts before execution from script steps,
repetitions, criteria, and calibration; provider-dependent token costs remain
estimates. This spec introduces no unmeasured spend or latency threshold.
Existing agent deadlines apply, with `EVAL_MAX_LATENCY_MS` used for the agent
latency assertion. Judge latency is reported separately.

`agent eval conversations --gate <report.json>` is the gate: it reads a
written run, applies the reviews recorded against its `runId`, and writes
its decision beside the report, as `<report>.gate.json`, without changing
the run. It passes only when the run is not stale (its `evaluated` hash
still matches what the suite would evaluate now), the inventory is current,
every scenario passes once reviews are applied, and coverage is complete.
A review made against another run is counted and never applied.

## Verification

1. Schema tests reject duplicate IDs, inconsistent initial state, missing
   flow fixtures, unresolved catalog selectors, branch references, and live
   plugin adapters before any provider call. Legacy `cases.jsonl` still loads.
2. A provider-boundary fake produces a distinctive first reply and state
   write; the second call receives precisely that reply and performed state.
   An alternative fake omits the write, and the later state assertion fails.
3. Production-path tests exercise prechecks, opening, stage-tied flows,
   ordering, offering locking, deduplication, and successful versus discarded
   writes. Their expected outcomes cite the governing production specs.
4. Tests prove sent flows survive escalation, failed sends do not create
   performed state, escalation notes follow `024`, and a deferred reply is
   settled before the next scripted message starts.
5. A fake performer and clock demonstrate scheduled silence, reply ordering,
   cancellation at the payment link, and suppressed nudges. Advancing time
   with no scheduled nudge produces no manufactured contact message.
6. A test drives two repetitions where only one fails, asserts fresh state
   for each, and checks the scenario is failed and labeled unstable.
7. Tests prove coverage requires passing executed witnesses in both runs;
   seeded, skipped, stale, conflicted, and ungraded branches cannot turn green.
8. Judge tests extend `016` with conversation-shaped calibration and exact
   step-linked evidence. A permissive judge fails calibration; an unavailable
   judge leaves required semantic criteria pending and the gate incomplete.
9. Tests assert continuation after a recoverable assertion failure, terminal
   behavior at an expected and unexpected handoff, suppression without
   handoff, and identification of provider errors behind fallback replies.
10. Report tests assert version binding, both transcripts, first failure,
    action outcomes, source coverage, judge evidence, separate costs, and
    exclusion of credentials, token bindings, and note text. Gate tests reject
    stale approvals, unresolved reviews, and incomplete coverage.
11. CI runs the offline command and harness tests without provider or ManyChat
    network access. Fictional framework scenarios are English and invented;
    tenant scenarios remain in the private project.

**What this does not prove.** Two runs expose some instability, not a
statistical reliability bound. Fixed user scripts can become unnatural after
an incorrect agent answer; that is reported rather than repaired. Authored
branch inventories can miss instructions. Fixtures do not verify live media
or WhatsApp delivery, and a calibrated judge can still misread a conversation.
Real conversations and human review remain evidence alongside this suite.
