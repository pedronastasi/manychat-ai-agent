# Security

## Reporting a vulnerability

Please open a private security advisory through GitHub's "Report a vulnerability"
flow rather than a public issue.

## Threat model

This service accepts webhooks from a third-party platform and calls an LLM with
text written by strangers. Three things follow from that.

### 1. Inbound requests cannot be cryptographically verified

ManyChat does **not** sign Dynamic Block requests — no HMAC, no timestamp, no
nonce. Only a static header we configure is available, so we can verify that the
caller knows a secret, not that the caller is ManyChat.

This is accepted, with compensating controls, in
[ADR-0006](docs/adr/0006-manychat-auth-risk-accepted.md):

- Constant-time comparison (`crypto.timingSafeEqual`), never `===`
- TLS required — the only protection against interception and replay
- Two secrets accepted during rotation, so rotating needs no flow downtime
- Per-IP and per-subscriber rate limits bound a leaked secret's blast radius
- Daily token and cost caps bound the worst case to finite spend
- The endpoint returns only a generated reply; there is no conversation history
  to read back, so a forged request cannot exfiltrate data

If ManyChat adds request signing, this decision should be revisited immediately.

### 2. Model input is attacker-controlled

Contact text is fenced with markers that are stripped from the input first, so a
contact cannot close the fence and append instructions. The system prompt states
that fenced content is data. Model output is schema-validated, and replies
containing prompt scaffolding are discarded in favour of a human handoff.

Prompt injection is not considered solved by these measures. It is mitigated,
and the blast radius is deliberately small: the agent has **no tools**, no
database write access derived from model output, and no ability to alter its own
configuration. The worst outcome of a successful injection is a bad message,
which the grounding and escalation checks are designed to catch.

The golden set (`evals/golden/cases.jsonl`) includes injection cases and is run
in CI.

### 3. Conversation content is personal data

Message text routinely contains names and phone numbers. Redaction is configured
at the logger so no individual log statement can opt out, telemetry spans omit
prompts by default, and subscriber IDs are pseudonymized for correlation.

Transcripts are stored in Postgres to provide conversation history. Operators are
responsible for retention and for their own legal obligations.

## Secrets

No credential or tenant data may enter git history (Constitution C1). `config/`
and `.env` are gitignored except for `*.example` scaffolds, and CI runs secret
scanning on every push.

Rotate `MANYCHAT_SHARED_SECRET` by setting both the old and new value
comma-separated, updating the ManyChat flow, then removing the old one.
