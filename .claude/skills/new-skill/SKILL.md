---
name: new-skill
description: Create a new repo-local skill under .claude/skills/ for this repository. Use when the user asks to add a skill or a slash command, or wants a workflow that has now been explained more than once captured as reusable instructions.
---

# Creating a repo-local skill

Skills in `.claude/skills/` are **committed**. They are repository tooling, like
`CONTRIBUTING.md`, and a stranger cloning this repo gets them.

## First decide whether it belongs here

A repo-local skill must encode **something specific to this repository**: a file
path, an exact format, a Constitution clause, a command that only exists here.

> If the skill could be pasted into an unrelated repository unchanged, it is a
> personal skill. It belongs in `~/.claude/skills/`, not in this repo.

`adr` qualifies: it hardcodes `docs/adr/`, the three-section format, the README
index, and C1/C9. "Write good commit messages" would not.

Do not create one for something done once. A skill is the third time.

## Steps

1. **Name it** — kebab-case, a verb or a noun the user would actually type:
   `adr`, `new-skill`. The directory name and the `name:` field must match.
2. **Create** `.claude/skills/<name>/SKILL.md`.
3. **Write the frontmatter** (see below). This is the part that matters most.
4. **Write the body**, following the structure below.
5. **Register it** in the skills table in `CONTRIBUTING.md`, so it is
   discoverable without listing a hidden directory.
6. **Format**: `npx prettier --write .claude/skills/<name>/SKILL.md CONTRIBUTING.md`.
7. **Verify** by invoking it: `/skill-name`.

## Frontmatter

```yaml
---
name: kebab-case-matching-the-directory
description: What it does, then when to use it - including the phrases a user would say.
---
```

`description` is the **only part loaded until the skill is invoked**. It is the
entire routing signal, so it carries the triggers: _"Use when the user says
'record this decision', asks for an ADR, or changes a Constitution clause."_ A
description that only says what the skill does will not be reached.

Write it in the third person. Keep it one or two sentences.

## Body structure

| Section         | Purpose                                                                      |
| --------------- | ---------------------------------------------------------------------------- |
| When it applies | The boundary — and when to use something else instead. Put this first.       |
| Steps           | Numbered, imperative, in order. Deterministic ones (numbering, dates) first. |
| Format          | The literal template to copy, in a fenced block.                             |
| House rules     | The repo constraints that apply — cite the clause (C1, C9, a spec).          |
| Worked example  | A link to a **real file in this repo**, with a sentence on why that one.     |

## Rules that keep a skill useful

- **Point at real files instead of restating them.** `docs/adr/0004` shows the
  format better than a paraphrase, and cannot drift out of date the way a copy
  does.
- **Prefer a command to a description of a command.** `date +%F` beats "use
  today's date"; `ls docs/adr/` beats "find the highest number".
- **Say what not to do, where it is a real trap.** The ADR skill forbids editing
  a superseded ADR's body because the obvious move is wrong.
- **Keep it short.** Aim under 150 lines. A skill that is read fully is worth
  more than a thorough one that gets skimmed.
- **English** (Constitution C9), and **no tenant data** (C1) — including in
  examples.

## Additional files

A skill can ship more than `SKILL.md`. Put helpers in the skill's directory and
reference them by relative path from `SKILL.md`:

```
.claude/skills/<name>/
  SKILL.md
  reference.md      detail too long for the body, read only when needed
  scripts/check.mjs  something better executed than described
```

## Worked example

Read [`.claude/skills/adr/SKILL.md`](../adr/SKILL.md). Note what it does **not**
do: it never reproduces an ADR's prose, it links to `0004` as the example, and
its description lists the phrases that should trigger it rather than describing
architecture decision records in general.
