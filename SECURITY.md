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

[ADR-0006](docs/adr/0006-manychat-auth-risk-accepted.md) accepted this with
compensating controls. It is superseded by
[ADR-0012](docs/adr/0012-contact-tokens-held-in-manychat.md), because
several of its claims did not hold:

- ADR-0006 said a forged request could not read conversation history. It can: a
  holder of the secret can name any contact's `subscriber_id`, and the model
  receives that contact's recent turns.
- The per-IP rate limit was never applied to any route.
- Every response registers a callback carrying the first configured secret,
  whichever secret the caller presented, so a holder of a retired secret is
  handed its replacement during a rotation.

[specs/017](specs/017-inbound-request-trust.md) specifies the fix: each contact
has a token that ManyChat holds and sends back, a request without it reads no
history, and every control has a test that makes it fire. Until it is
implemented and `CONTACT_TOKENS_ENFORCED` is on, the gaps above are live. The
controls that do hold today:

- Constant-time comparison (`crypto.timingSafeEqual`), never `===`
- TLS required — the only protection against interception and replay
- Two secrets accepted during rotation, so rotating needs no flow downtime
- Per-subscriber turn limits, enforced in the database
- Daily token and cost caps bound the worst case to finite spend

What a holder of the secret can still do once specs/017 is implemented is
listed there, under "What a holder of the shared secret can still do".

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
prompts by default, and subscriber IDs are pseudonymized for correlation. The
current pseudonym is a weak hash; specs/017 replaces it with the conversation's
random ID (ADR-0014).

Transcripts are stored in Postgres to provide conversation history. Operators are
responsible for retention and for their own legal obligations.

## Secrets

No credential or tenant data may enter git history (Constitution C1). `config/`
and `.env` are gitignored except for `*.example` scaffolds, and CI runs secret
scanning on every push.

Rotate `MANYCHAT_SHARED_SECRET` by setting both the old and new value
comma-separated, updating the ManyChat flow, then removing the old one.
