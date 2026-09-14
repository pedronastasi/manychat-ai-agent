# 005 — Repository Language

Everything committed to this repository is in English. The only exception is a
tenant's own configuration, which is gitignored and never committed.

## This is not a translation task

The Spanish currently in `src/` is a symptom, not the problem. Customer-facing
copy is **hardcoded in source**:

```ts
// src/routes/turn.ts
const ACK_MESSAGE = 'Dame un segundo que lo chequeo 👍';

// src/agent/guardrails.ts
const ESCALATION_TEXT = 'Dejame que te pase con alguien del equipo...';
```

Translating those to English produces the same bug in a different language: a
codebase that can serve exactly one linguistic market, now English instead of
Spanish. A tenant in São Paulo would be equally stuck.

So the rule is stronger than "write English". It is:

> **No customer-facing natural language lives in source at all.** Copy belongs to
> the tenant, in configuration. Source contains English identifiers, comments,
> and documentation — and no sentences a contact could ever read.

That makes the repository publishable in English _and_ makes the product
multi-tenant in a way it currently is not.

## The four categories

| Category                                                                  | Rule                                      |
| ------------------------------------------------------------------------- | ----------------------------------------- |
| Code, comments, identifiers, docs, specs, ADRs, commit and PR text        | English, always                           |
| Customer-facing copy (acknowledgement, escalation message)                | Not in source — tenant config             |
| Prompt scaffolding the framework owns (operating rules, catalogue labels) | English; never reaches a contact verbatim |
| A tenant's persona, catalogue, and reply language                         | Tenant config, any language, gitignored   |

## Reply language is configuration, not a property of the code

The framework's prompt scaffolding is English. The tenant's persona file states
the language and register to answer in. Models follow a persona instruction to
reply in another language reliably, so English scaffolding does not force English
replies — it only stops the framework from assuming a language it has no business
assuming.

This is already how `config/prompt.md` works. The change is that the _rest_ of
the prompt stops being Spanish too.

## What changes

### 1. Copy moves to `rules.json`

`ESCALATION_TEXT` and `ACK_MESSAGE` become tenant-configured, with the schema
requiring them. No default is shipped in source: a missing value must fail at
boot rather than silently emitting English at a Spanish-speaking contact.

```jsonc
{
  "messages": {
    "acknowledgement": "Give me one second while I check.",
    "escalation": "Let me put you through to someone on the team.",
  },
}
```

### 2. `prompt.ts` scaffolding becomes English

Operating rules, the security preamble, the format instructions, and the
catalogue labels (`descripcion:` → `description:`, `cursada:` → `schedule:`).
These are internal structure; a contact never sees them.

Escalation reason identifiers (`price_negotiation`, `complaint`) are already
English and stay exactly as they are — they are enum values, not prose.

### 3. The committed demo tenant becomes English

`config/*.example` and `test/fixtures/config/*` describe a fictional
English-speaking academy. These are the first thing a stranger reads, and a
Spanish demo in an English repository reads as an oversight.

### 4. Tests and evals become English

Test names, assertions, and fixture strings. `evals/golden/cases.jsonl` becomes
English cases against the English demo catalogue.

**With one deliberate exception.** The golden set keeps a small non-English
section, run against a non-English tenant fixture, because nothing else proves
the language-independence this spec claims. An all-English suite would let a
hardcoded English string regress in unnoticed — which is precisely the bug being
fixed here. Those cases are labelled, and their Spanish is test data, not
repository prose.

## The exception, scoped precisely

Rossy Nails Academy's real `config/prompt.md`, `config/catalog.json`,
`config/rules.json` and `.env` stay in Rioplatense Spanish. They are gitignored
(Constitution C1) and verified unstageable. The exception needs no discipline to
hold — git enforces it.

## Order of work

1. **Copy out of source** (`guardrails.ts`, `turn.ts`, schema, config examples).
   This is the behavioural change and the only one that can break a running bot,
   so it lands first and alone.
2. **Prompt scaffolding** (`prompt.ts`) — re-run the eval suite after, since
   prompt wording changes model behaviour and that is what the evals exist for.
3. **Demo tenant and fixtures.**
4. **Tests and evals**, including the non-English section.
5. **`mock-provider.ts`** replies, last — it is test infrastructure and changing
   it early would obscure whether step 2 altered real behaviour.

## Verification

- `pnpm eval` passes against the English demo tenant, and the non-English section
  passes against its fixture. Step 2 is the risk: if English scaffolding degrades
  escalation accuracy, the evals are what will show it.
- A CI check greps tracked files for a denylist of Spanish stopwords and flags
  hits outside `evals/golden/` and the tenant-config paths.

  This is a heuristic, not language detection, and it will occasionally be wrong
  in both directions. It exists to catch the obvious regression — a Spanish
  string pasted into a source file — not to be authoritative. Review is the real
  enforcement.

- No file under `config/` other than `*.example` and `README.md` is tracked.
