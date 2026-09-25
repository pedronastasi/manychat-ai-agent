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
- `max_turns_per_conversation` — after which every turn escalates (counted since
  the last `idleResetHours` gap once `017` is implemented)
- `escalation_keywords` — immediate handoff, checked before the model runs
- `budget` — daily token and cost caps per tenant
- `rate_limit` — per-subscriber turns per window
- `historyDays` — how far back the model's history reaches, default 30
- `idleResetHours` — hours of silence after which the turn cap resets, default 24. Both specified in `017`, not yet implemented

## `.env`

| Variable                  | Purpose                                                     |
| ------------------------- | ----------------------------------------------------------- |
| `AGENT_MODEL`             | `provider:model`, e.g. `anthropic:claude-haiku-4-5`         |
| `ANTHROPIC_API_KEY` etc.  | Only the active provider's key is required                  |
| `MANYCHAT_SHARED_SECRET`  | Validates inbound Dynamic Block requests                    |
| `MANYCHAT_API_TOKEN`      | Deferred delivery, for both calls in `002`                  |
| `MANYCHAT_REPLY_FIELD`    | Custom field the reply text is written to                   |
| `MANYCHAT_REPLY_FLOW_NS`  | Flow triggered to render that field                         |
| `PUBLIC_BASE_URL`         | HTTPS base for `external_message_callback`                  |
| `MANYCHAT_TOKEN_FIELD`    | Contact field holding the token; `017`, not yet implemented |
| `CONTACT_TOKENS_ENFORCED` | Rollout flag for contact tokens; `017`, not yet implemented |
| `TRUST_PROXY_HOPS`        | Proxies in front of the service; `017`, not yet implemented |
| `DATABASE_URL`            | Postgres                                                    |
| `CHANNEL`                 | Capability profile, e.g. `whatsapp`                         |

`AGENT_MODEL` is the whole model-agnosticism story: changing provider is an env
edit and a restart, with no code change (Constitution C2). Model IDs carry no
date suffix.

`MANYCHAT_REPLY_FIELD` and `MANYCHAT_REPLY_FLOW_NS` name objects that live in the
tenant's ManyChat account, not in this repository. They are environment rather
than tenant config because they identify infrastructure, not customer-facing
content: nothing in either value is ever shown to a contact. Renaming the field
or flow in ManyChat without updating these breaks delivery at runtime, and no
test can catch it — see `002-channel-contract.md § Verification`.

## Reload

Config reloads on `SIGHUP` as well as restart. The first two weeks of a deployment
are dominated by prompt edits; requiring a full restart for each one is friction
that leads to editing prompts in production by hand.
