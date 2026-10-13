---
status: specified
constitution: [C1, C3, C4, C6, C8, C9]
---

# 044 — Tenants Override Individual System Prompt Sections

Defines optional tenant-owned replacements for the conversational sections of
the system prompt, their precedence, validation and reload behaviour. It leaves
out implementation, deployment, changing runtime guardrails and replacing the
entire prompt. This contract is specified, not available in the agent yet.

## A tenant replaces a section instead of arguing with its default

`config/prompt.md` already defines persona, tone and business policy (`003`).
The framework also adds operating, formatting, closing and sales instructions.
Appending another instruction can leave both policies in the model's input,
even when the tenant policy has declared precedence. A section replacement
removes the displaced default from the effective prompt.

The optional file is `config/prompt-overrides.json`, resolved inside `CONFIG_DIR`
alongside the other tenant files. It belongs to the tenant project (`033`), may
use the tenant's language (`005`), and contains no credentials. Production
contents never enter the framework repository (C1, C9).

## Only the named conversational sections are replaceable

The file is a JSON object whose allowed keys are listed below. Each supplied
value is a string containing the complete replacement body for that section.
There is no append mode, template evaluation, file inclusion or environment
variable expansion. A JSON string is text, never executable configuration.

| Key         | Replaces                                            | Included when                          |
| ----------- | --------------------------------------------------- | -------------------------------------- |
| `operating` | Conversational response and escalation policies     | Always                                 |
| `format`    | Style, language and presentation guidance           | Always                                 |
| `closing`   | When to ask a closing question or return `null`     | Always                                 |
| `actions`   | Conversational guidance for using available actions | Any built-in or plugin tool is offered |
| `intent`    | How to interpret and record purchase intent         | An intent field is configured          |
| `sales`     | Qualification, objections and sales progression     | A funnel field is configured           |
| `offerings` | How to select and continue the contact's offering   | An offering field is configured        |
| `followUps` | When and how to propose a follow-up                 | Nudge configuration is present         |

For example, a fictional tenant can change only its closing policy:

```json
{
  "closing": "Ask a next-step question while the contact is deciding. After a farewell, return null."
}
```

Omitting a key selects its framework default. Omitting the file or supplying
`{}` selects all defaults. A supplied but inactive section is validated and
retained, but omitted from the prompt until its capability is configured.
An override never creates a tool, enables a flow or supplies a missing field.

Section headings and ordering belong to the framework. Values replace bodies,
not headings. The ordering of keys in the JSON file has no effect on prompt
assembly. `config/prompt.md` remains the persona; these overrides do not replace
that file or create an alternative persona source.

## Mandatory instructions are separated before defaults are replaced

The current operating block mixes conversation policy with factual grounding.
The format and action blocks likewise mix style with protocol instructions.
Implementation must separate these concerns before accepting replacements.
Keeping a full old block as an additional mandatory section would defeat this
contract.

The following remain framework-owned instructions, independently present in
the effective prompt and never replaceable through this file:

- Security and input fencing, prompt confidentiality, untrusted contact and
  plugin-read data, and truthful interpretation of media actually received.
- Factual grounding in the configured catalog and successful authorised reads,
  no invented prices, dates, availability or policies, no invented payment
  confirmation, and fail-closed handling of uncertainty (C4, C6).
- Output schema and channel limits, the meaning of `confidence` and the active
  escalation threshold, and placing the final question in `closing_question`
  rather than duplicating it in `messages`.
- Actual tool availability, tool schemas and execution constraints, action
  limits, staged versus performed results, and truthful claims about delivery.
- Runtime restrictions on intent, funnel transitions, offering locks, payment
  links, opening flows, follow-up timing and plugin capabilities.

Thus `operating` can change escalation policy for a known business question,
bot wording, interpretation of short replies or acknowledgements. It cannot
authorise guessing an unknown fact or claiming to be human. `format` can change
style within the channel's limits. `closing` decides when a question belongs;
the framework still owns how its field is rendered. `actions` changes guidance
on choosing available actions, not their actual execution semantics.

The mandatory catalog block and system-authored per-turn notices remain
framework-owned. Overrides cannot remove, rewrite or interpolate the catalog,
contact state, opening or delivery notices, history, current message or tool
results. Dynamic content stays outside the cacheable static prefix.

## The effective section has one policy source

Precedence is: mandatory framework invariants, explicit tenant overrides,
persona policies, then defaults for sections without an override. This applies
to conversational policy only; tool descriptions explain the configured
capabilities and cannot expand their runtime permissions.

For each active section, assembly emits either the override or the default,
never both. It adds no paraphrase of the displaced default elsewhere. The
persona may supply additional business context, but an explicit section
override wins if the persona conflicts with it. A tenant should keep both files
consistent rather than rely on that conflict resolution.

An unchanged tenant must retain the existing effective policies, catalog,
capability gates and protocol instructions. Refactoring sections may move an
instruction; it must not silently change its meaning. All turn paths that use
the tenant prompt, including live replies, follow-ups and evaluations, use the
same resolved configuration. Identical configuration produces identical static
prompt parts; request-specific values do not change that prefix.

## Loading and reloading validate one complete snapshot

The loader accepts only a JSON object with the named keys and non-empty string
values after trimming. Unknown keys, `null`, arrays, non-string values, blank
values and malformed JSON fail validation. A present but unreadable file is
an error, not permission to fall back silently. Diagnostics identify the file
and invalid key without logging its contents or the assembled prompt (C5).

Invalid configuration fails startup before accepting turns. On `SIGHUP`, the
loader validates overrides together with the persona, catalog, rules, tools
and plugins as one candidate snapshot. A failure retains the previous complete
snapshot; a success atomically replaces it. Turns already running finish with
the snapshot they started with. Deleting the optional file and successfully
reloading restores defaults for subsequent turns.

Validation checks structure, not whether arbitrary prose agrees with every
invariant. Mandatory instructions and runtime guards remain independent of
that prose; there is no claim that a text scanner can prove consistency.

## Evaluations judge the effective tenant policy

Framework fixtures use invented English overrides. Tenant evaluations load
the tenant's overrides through the same `CONFIG_DIR` resolution as production
(`009`); they do not assemble a different prompt for grading.

Review the effective persona, selected section bodies, catalog and tool
constraints when judging a reply. A test that requires a displaced
conversational default is an evaluation-policy mismatch, not evidence that the
reply violated the tenant policy. Record and correct that mismatch separately
from model failures. Mandatory constraints remain valid evaluation targets
even when an override requests conflicting behaviour.

## Verification

Implementation tests cite the clauses above and must demonstrate:

1. Missing files and `{}` retain existing policies with and without tools;
   changing one section leaves other selected bodies unchanged.
2. Every allowed key replaces its default body exactly once, without emitting
   displaced policy elsewhere. A conflicting persona does not outrank an
   explicit override, and JSON key order does not affect prompt assembly.
3. Capability gates omit inactive sections, including plugin-only action
   configurations; overrides cannot add capabilities or bypass tool refusals.
4. Mandatory security, grounding, output, confidence and execution instructions
   survive every replacement. A rejected action stays rejected even if its
   override asks for it, and fenced input never becomes system instruction.
5. Invalid shapes, values, keys, unreadable files and malformed JSON fail boot;
   failed reloads preserve the entire previous snapshot. Valid reloads and
   deletion of the file take effect atomically for subsequent turns.
6. Live replies, follow-ups and evals select the same bodies. Identical
   configuration preserves a stable prefix, without per-contact content.
7. An invented tenant eval whose override contradicts an old closing or
   qualification default is graded against the effective policy. Review
   distinguishes an obsolete expectation from a model or mandatory-rule failure.

Structural assertions prove selection, validation and retained runtime guards.
They do not prove model obedience to prose. Semantic evaluations and human
review must check conversational behaviour; their results must not be reported
as deterministic guarantees. No real-model run is required to publish this
spec-only change.
