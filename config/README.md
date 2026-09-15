# Tenant configuration

Everything in this directory except `*.example` and this README is **gitignored**
and must never be committed (Constitution C1).

```bash
cp config/prompt.md.example   config/prompt.md
cp config/catalog.json.example config/catalog.json
cp config/rules.json.example   config/rules.json
```

`prompt.md` is the persona. `catalog.json` is the only source of factual claims
the agent may make — a price change is an edit here plus `kill -HUP <pid>`, with
no prompt editing and no deploy. `rules.json` holds thresholds, escalation
keywords, and the spend caps.

`rules.json` may also set an `openingTrigger`: a sentinel the channel flow sends
to start a conversation, and the reply it produces verbatim. The model never runs
for it, so the opening is instant and free and cannot be turned into a handoff by
a low confidence score. Unlike `escalationKeywords`, which match substrings, this
matches the whole message — a contact who mentions the phrase must not be able to
replay the opening. See `specs/001-agent-behavior.md`.

Invalid config fails at startup rather than at the first customer message. A
failed **reload** keeps the previous config, so a typo cannot take down a running
bot.
