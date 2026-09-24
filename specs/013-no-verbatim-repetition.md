---
status: specified
constitution: [C9]
---

# 013 — No Verbatim Repetition

Defines that the agent must not send a response identical to one it
already sent in the same conversation, and what happens instead. Leaves
out multi-session memory, semantic similarity beyond normalized string
comparison, and proactive follow-up messages.

## The model repeats itself even with full history

The agent receives conversation history on every turn. Despite that, it
generates responses identical to a prior turn's output. The most common
trigger is a conversational closer: the contact says "thanks" or "bye"
and the model replays its previous response instead of acknowledging
naturally.

The default assumption — a model with context will not repeat itself —
is wrong. A contact who sends a thank-you after a resolved question
receives a verbatim copy of the agent's last reply. This is not a fringe
failure; it is the most common exit path from a successful conversation,
because every resolved question ends with some form of acknowledgment.

## Prompt instruction is the primary defence

The system prompt explicitly instructs the model:

1. **Do not restate a previous response.** If the information was already
   given, acknowledge briefly rather than repeating it.
2. **Handle conversational closers naturally.** When the contact sends a
   closer — thanks, bye, ok, perfect — respond with a brief natural
   acknowledgment and an offer to help further.

These are prompt-level rules. The model has the conversation history and
the instruction to use it. This is the fix that works for the common
case.

## A server-side guardrail catches what the prompt misses

A prompt instruction is a request, not a guarantee. `applyGuardrails`
adds a deduplication check after the model produces its response:

1. **Normalize** each message: lowercase, strip emoji, collapse
   whitespace, trim.
2. **Compare** the normalized current response (each message in
   `messages[]`) against all prior agent responses in the conversation
   history.
3. If any normalized message matches a prior response exactly, the
   response is a **duplicate**.

The guardrail needs conversation history. Today `applyGuardrails` takes
only the model output and the rules; the deduplication check adds the
prior agent messages as a parameter.

The check runs on the normalized form. Near-duplicates — a word swapped,
punctuation changed — are not caught. If evidence shows near-duplicates
are a problem, the threshold can be tightened with a measured similarity
score; the measurement date must be recorded here.

## A caught duplicate becomes a natural closer, not an escalation

When the guardrail catches a duplicate:

- The model's messages are replaced with the tenant's configured
  `rules.messages.closer` — the same pattern `applyGuardrails` already
  uses for `rules.messages.escalation`.
- `escalate` remains `false`.
- `confidence` is preserved from the model's output.
- `closing_question` is set to `null`, since there is nothing left to
  ask.
- The intervention `"duplicate_replaced"` is recorded.

This is not failure. The contact's question was already answered; the
agent needs to close the conversation, not hand it off. Escalation on a
"thanks" message wastes the operator's time on a resolved conversation.

The `closer` message is tenant configuration, not source (C9). It is
added to `MessagesSchema` alongside `acknowledgement` and `escalation`.

## Verification

1. **Eval cases**: the golden set includes at least two cases where the
   contact sends a conversational closer after a resolved question. The
   expected output is a natural acknowledgment, not a repetition of the
   prior answer.
2. **Guardrail unit test**: a test drives `applyGuardrails` with a
   response identical to a prior turn's message and asserts the output
   is replaced with the configured closer.
3. **Normalization test**: a test asserts that emoji, whitespace, and
   case differences do not bypass the check.
4. **No false positives**: a test asserts that a response containing
   overlapping content — such as repeating a price from the catalog
   that was also in a prior response — is not flagged, because the
   full message differs.

What this misses: the prompt instruction is the primary fix, and no test
can prove a model will always follow it. The eval samples it; real
conversations are the check. The guardrail catches the exact case
(verbatim repetition) but not semantic repetition — saying the same
thing in different words — which remains a prompt-level concern.
