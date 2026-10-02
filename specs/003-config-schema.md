---
status: implemented
implemented: 2026-09-14
pr: 1
constitution: [C1, C2]
adr: [0018]
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
  tools.json       optional agent actions    (gitignored)
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

`paymentOptions` is optional: one entry per way to pay the tenant offers
(instalments, a deposit, a private-class rate), each an `id`, unique, and a
tenant-language `description`. It defaults to empty. An option listed here is a
catalog fact the agent may present; a payment arrangement it does not cover
still escalates as `price_negotiation` (`023`).

The catalog is interpolated into the system prompt at boot. A price change is a
JSON edit and a restart — no prompt editing, no deploy.

## `rules.json`

- `messages.acknowledgement` — sent when the reply is deferred to the outbox
- `messages.escalation` — sent on every handoff
- `messages.mediaFallback` — sent when media cannot be read; optional, falls back to `escalation` (`020`)
- `messages.closer` — sent in place of a reply that repeats an earlier one; optional, without it the repetition is sent (`013`)
- `confidence_threshold` — below this, force escalation
- `max_turns_per_conversation` — after which every turn escalates, counted since
  the contact's last gap of `idleResetHours` (`018`)
- `escalation_keywords` — immediate handoff, checked before the model runs
- `budget` — daily token and cost caps per tenant
- `rate_limit` — per-subscriber turns per window
- `historyDays` — how far back the model's history reaches, default 30
- `idleResetHours` — hours of silence after which the turn cap resets, default 24 (`018`)

## `tools.json`

Optional. The flows, tags and field values the agent may act with (`012`). Absent,
the agent is offered no tools and behaves as it did before `012`.

- `flows[]` — `id`, `flowNs`, `description`, optional `repeatable` and
  `role: "payment_link"` (`023`)
- `tags[]` — `id`, `tag`, `description`
- `fields[]` — `id`, `field`, `values` (at least one, unique), `description`,
  optional `funnel` (`023`)

Every list defaults to empty, and an empty list offers no tool. An `id` is
lowercase letters, digits, `_` and `-`, unique within its list, because it
becomes an enum value in a tool's parameter schema. The model sees `id` and
`description` only. `flowNs`, `tag` and `field` name objects in the tenant's
ManyChat account and stay server-side.

At most one flow may have `role: "payment_link"`, and at most one field may be
marked `funnel`. A `funnel` field's `values` must be the stages of `023` in
order: `new`, `qualifying`, `nurturing`, `offered`, `link_sent`.

Loading also refuses a flow whose `flowNs` is `MANYCHAT_REPLY_FLOW_NS`, and a
field whose `field` is `MANYCHAT_REPLY_FIELD` or `MANYCHAT_TOKEN_FIELD`. Firing the
reply flow or writing either field as an action would resend a stale reply,
overwrite one in flight, or replace the contact's token. Like any other invalid
config, this fails the boot, and a reload that introduces it is refused.

## `.env`

| Variable                  | Purpose                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| `AGENT_MODEL`             | `provider:model`, e.g. `anthropic:claude-haiku-4-5`                |
| `ANTHROPIC_API_KEY` etc.  | Only the active provider's key is required                         |
| `MANYCHAT_SHARED_SECRET`  | Validates inbound Dynamic Block requests                           |
| `MANYCHAT_API_TOKEN`      | Deferred delivery, for both calls in `002`                         |
| `MANYCHAT_REPLY_FIELD`    | Custom field the reply text is written to                          |
| `MANYCHAT_REPLY_FLOW_NS`  | Flow triggered to render that field                                |
| `PUBLIC_BASE_URL`         | HTTPS base for `external_message_callback`; boot refuses `http://` |
| `MANYCHAT_TOKEN_FIELD`    | Contact field holding the token (`019`)                            |
| `CONTACT_TOKENS_ENFORCED` | Rollout flag for contact tokens (`019`); default `true`            |
| `TRANSCRIPTION_MODEL`     | `provider:model` for voice notes and video soundtracks (`020`)     |
| `TRUST_PROXY`             | Proxies whose `X-Forwarded-For` is believed (`017`)                |
| `DATABASE_URL`            | Postgres                                                           |
| `CHANNEL`                 | Capability profile, e.g. `whatsapp`                                |

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
