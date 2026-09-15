---
status: implemented
implemented: 2026-09-14
pr: 1
constitution: [C1, C2]
adr: [0003]
---

# 003 — Tenant Configuration

Everything business-specific is configuration, not code. A new tenant means new
config files, never a new branch (Constitution C1).

## Layout

```
config/
  prompt.md        persona, tone, rules      (gitignored)
  catalog.json     courses, prices, schedule (gitignored)
  rules.json       thresholds, escalation    (gitignored)
  *.example        committed scaffolds for the fictional demo tenant
.env               credentials and model selection (gitignored)
```

Config is loaded once at boot and validated against Zod. **Invalid config is a
startup failure, not a runtime surprise** — a malformed price must not become a
customer-facing error hours later.

## `catalog.json`

Courses with id, name, description, price (amount + currency), duration,
schedule, and an optional enrolment URL. Prices are integers in minor units
(cents) to avoid float drift, with an explicit currency code.

The catalog is interpolated into the system prompt at boot. A price change is a
JSON edit and a restart — no prompt editing, no deploy.

## `rules.json`

- `confidence_threshold` — below this, force escalation
- `max_turns_per_conversation` — after which every turn escalates
- `escalation_keywords` — immediate handoff, checked before the model runs
- `budget` — daily token and cost caps per tenant
- `rate_limit` — per-subscriber turns per window

## `.env`

| Variable                 | Purpose                                             |
| ------------------------ | --------------------------------------------------- |
| `AGENT_MODEL`            | `provider:model`, e.g. `anthropic:claude-haiku-4-5` |
| `ANTHROPIC_API_KEY` etc. | Only the active provider's key is required          |
| `MANYCHAT_SHARED_SECRET` | Validates inbound Dynamic Block requests            |
| `MANYCHAT_API_TOKEN`     | Send API, for the deferred push                     |
| `DATABASE_URL`           | Postgres                                            |
| `CHANNEL`                | Capability profile, e.g. `whatsapp`                 |

`AGENT_MODEL` is the whole model-agnosticism story: changing provider is an env
edit and a restart, with no code change (Constitution C2). Model IDs carry no
date suffix.

## Reload

Config reloads on `SIGHUP` as well as restart. The first two weeks of a deployment
are dominated by prompt edits; requiring a full restart for each one is friction
that leads to editing prompts in production by hand.
