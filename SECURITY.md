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

[specs/017](specs/017-inbound-request-trust.md) fixes the last two, and every
control listed below has a test that makes it fire through the server a process
runs. [specs/019](specs/019-contact-tokens.md) specifies the fix for the first:
each contact has a token that ManyChat holds and sends back, and a request
without it reads no history. Until 019 is implemented and
`CONTACT_TOKENS_ENFORCED` is on, a holder of the secret can read any contact's
history. The controls that hold today:

- Constant-time comparison (`crypto.timingSafeEqual`), never `===`, before the
  body is parsed, so an unauthenticated caller learns nothing about the schema
- TLS required — the only protection against interception and replay. The
  process does not boot with an `http://` callback base
- Two secrets accepted during rotation, and each callback carries back the
  secret its caller presented, so rotating needs no flow downtime
- 300 requests a minute per address, counting failed authentication, with
  separate budgets for requests with and without the secret, so a flood that
  cannot authenticate cannot lock ManyChat out. The address is believed from
  `X-Forwarded-For` only when the peer is listed in `TRUST_PROXY`
- Per-subscriber turn limits, enforced in the database
- Daily token and cost caps bound the worst case to finite spend
- An unhandled error on the message route hands the contact to a person, and no
  response carries error text

What a holder of the secret can still do once specs/019 is implemented is
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
prompts by default, and log lines identify a conversation by its random ID,
never by anything derived from the subscriber ID (ADR-0014).

Transcripts are stored in Postgres to provide conversation history. Operators are
responsible for retention and for their own legal obligations.

## Secrets

No credential or tenant data may enter git history (Constitution C1). `config/`
and `.env` are gitignored except for `*.example` scaffolds, and CI runs secret
scanning on every push.

Rotate `MANYCHAT_SHARED_SECRET` in four steps:

1. Set both the old and the new value, comma-separated.
2. Update the ManyChat flow's Dynamic Block header to the new value.
3. Wait at least 24 hours, then remove the old value. Each callback carries back
   the secret its caller presented (specs/017), so a conversation carried on by
   callbacks keeps the old one until the contact is silent for 24 hours, the
   longest a callback lives. A contact still writing when the old value is
   removed loses one reply, and the next message arrives with the new secret.
4. If the old value leaked, skip the wait: remove it at once and accept those
   lost replies. Keeping it only extends the leak.
