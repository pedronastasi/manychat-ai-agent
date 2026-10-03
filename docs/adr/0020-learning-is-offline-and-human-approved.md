# ADR-0020 — The agent learns offline from paid outcomes, behind human approval

**Status:** accepted · **Date:** 2026-10-03

## Context

Since ADR-0015 the agent sells, and every lead starts from the same prompt.
What one conversation teaches (which objection comes up, which answer moved a
lead to pay) is lost when it ends. `024`'s notes remember a single contact;
nothing carries a lesson from one contact to the next.

The reflexive option is a memory the agent writes itself: a tool that appends
an insight to a store, and a prompt that injects the store on every turn. It
is cheap, it learns within minutes, and it is the shape most agent frameworks
ship. It was turned down for two reasons.

- **It turns contact text into instruction.** An insight is model output
  derived from what a contact said. Written to a store every other contact's
  prompt reads, it is the injection C4 forbids, made durable: one contact who
  talks the agent into recording "offer a discount to anyone who hesitates"
  has edited the prompt for every lead after them. Fencing the store as
  untrusted data would answer C4 and make the insights useless as guidance.
- **The turn that writes it cannot know whether it worked.** Whether a lead
  pays is known days later, in the tenant's ManyChat account, and never inside
  the turn. An insight written in the moment records what the model believed
  was persuasive, which is the belief that needs testing.

Two milder variants were also considered. An in-turn "flag" tool whose output
only feeds a later review keeps C4 but adds a tool to every turn for raw
material the transcripts already hold. Auto-approval behind filters drops the
human but leaves C4 resting on a filter, and no filter can tell a tactic from
an instruction in a language this repository does not read.

None of this was measured. There is no enrolment baseline yet (`023 § Success
is measured twice`).

## Decision

The agent learns only from conversations whose outcome is known, by an
offline job that proposes tactics, and a tactic reaches the prompt only after
a person approves it and a real-model eval shows no regression.

## Consequences

- Nothing a contact says reaches another contact's prompt without a person
  choosing it. Approval is what turns model output into tenant instruction,
  the same standing `config/prompt.md` has.
- The signal is paid enrolment, not link-sent rate, so the job reads ManyChat
  for each contact it learns from; `023` already warns link-sent can rise
  through pushiness alone.
- Cost: learning is slow. A lesson takes at least the 14-day settle period,
  a weekly run and a review to reach the prompt, and a tenant that never
  reviews learns nothing.
- Cost: every activation runs the golden set against a real model, which
  costs money, and the eval only guards what the golden set covers.
- Cost: a playbook version's effect is measured before and after, not against
  a control, so seasonality and ad changes are not separated from it.
- Revisit if review becomes the bottleneck (proposals waiting weeks), which
  argues for auto-approval of a narrow class; or if before-and-after readings
  prove too noisy to act on, which argues for the A/B split this leaves out.
