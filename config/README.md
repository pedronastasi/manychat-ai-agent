# Tenant configuration

Everything in this directory except `*.example` is **gitignored**
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

## `tools.json`: actions the agent can take (optional)

Without `tools.json` the agent only replies. With it, the agent can also act on
the contact in ManyChat while it answers: send one of your flows, tag the
contact, or record a choice they made. The design is in
`specs/012-agent-tools.md` and `docs/adr/0010-bounded-tool-loop-with-staged-actions.md`.

`pnpm bootstrap` does not create this file, because tools are opt-in. To turn
them on:

```bash
cp config/tools.json.example config/tools.json
```

Then edit the file and restart, or send `kill -HUP <pid>`.

### What you configure

| Tool         | What it does in ManyChat                  | Configured by |
| ------------ | ----------------------------------------- | ------------- |
| `send_flow`  | Sends the contact one of your flows       | `flows`       |
| `add_tag`    | Adds one of your tags to the contact      | `tags`        |
| `remove_tag` | Removes one of your tags from the contact | `tags`        |
| `set_field`  | Writes one allowed value to a field       | `fields`      |

A list you leave empty or omit offers no tool for it. Each entry has:

- **`id`**: the name the model uses for the entry. Lowercase letters, digits,
  `_` and `-`, unique within its list. It is also what the turn record and the
  logs show.
- **`flowNs`, `tag` or `field`**: the object's name in your ManyChat account. The
  model never sees it, so renaming the object in ManyChat only needs an edit
  here.
- **`values`** (fields only): the only values the agent may write. The model
  picks one of them and can never write free text.
- **`description`**: what the entry is and when to use it. This is the only
  guidance the model gets, so write it as a condition, for example "Send when
  the contact asks for details, a syllabus or something to read". It may be in
  your contacts' language.

The agent always acts on the contact whose message it is answering. No tool
takes a contact as a parameter.

### Startup checks

`tools.json` is validated like the other config files: a malformed file fails
the boot, and a malformed reload is refused and the previous config is kept. A
file is also refused if it names an object this service already uses for
delivery:

- a flow whose `flowNs` is `MANYCHAT_REPLY_FLOW_NS`;
- a field whose `field` is `MANYCHAT_REPLY_FIELD` or `MANYCHAT_TOKEN_FIELD`.

### What happens on a turn

1. **The model chooses.** It may call tools before writing its reply. A call
   only stages the action. Nothing reaches ManyChat while the model is running.
   A turn stages at most 3 actions, and identical calls count once. A call past
   the limit is dropped.
2. **The model writes the reply.** It is told what was staged and that nothing
   has been sent yet, so it says what it is sending rather than claiming it
   has sent it.
3. **The guardrails decide.** If the turn ends in a handoff for any reason, every
   staged action is discarded. The reasons are: the model escalated,
   confidence was too low, a prompt leak, an invalid reply, a failed model call,
   or `MODEL_ABORT_MS`.
4. **The text goes first, then the actions.** On an inline reply, the actions run
   after the response to ManyChat has been sent. On a deferred reply, the outbox
   worker runs them after it has delivered the text, and if the reply is
   dead-lettered its actions are dropped. Actions run in the order the model
   staged them, one request each, with a 10-second timeout. Each gets one
   attempt: a failure is logged at `warn` as `action failed` and is not retried.
5. **Later turns remember.** History shows the model a line such as
   `[actions performed: send_flow foundation_brochure]` under the reply that
   performed it, so it does not send the same flow again. Only `performed`
   actions are listed. The server writes that line, and the guardrails remove
   it if the model copies it into a reply.

Turns where the model does not run (the scripted opening, escalation keywords,
budget, rate and turn caps) offer no tools and stage nothing.

### Seeing what the agent did

Every agent turn records its actions in the `actions` column of `turns`. It is
`null` when no tool was offered and `[]` when tools were offered and none was
chosen. Otherwise it has one entry per staged action:

```json
[{ "tool": "send_flow", "id": "foundation_brochure", "status": "performed" }]
```

How an action reaches each status. The rounded boxes are the statuses you will
see in the column:

```mermaid
flowchart TD
    call["The model calls a tool"] --> cap{"3 actions already staged this turn?"}
    cap -- yes --> over(["dropped_over_cap"])
    cap -- no --> handoff{"Does the turn end in a handoff?"}
    handoff -- yes --> discarded(["discarded"])
    handoff -- no --> staged(["staged"])
    staged --> deadline{"Reply ready before the 8 s race deadline?"}
    deadline -- yes --> inline["Dynamic Block response sent"]
    deadline -- no --> outbox{"Outbox delivers the reply?"}
    outbox -- "no, dead-lettered" --> dead(["dead_lettered"])
    outbox -- yes --> run
    inline --> run["One request to ManyChat, 10 s timeout"]
    run --> accepted{"ManyChat accepts it?"}
    accepted -- yes --> performed(["performed"])
    accepted -- "no, or timed out" --> failed(["failed"])
```

| `status`           | Meaning                                                    |
| ------------------ | ---------------------------------------------------------- |
| `staged`           | Waiting to be performed, after the response or the outbox  |
| `performed`        | ManyChat accepted the request                              |
| `failed`           | ManyChat refused it or it timed out; `error` says why      |
| `discarded`        | The turn ended in a handoff                                |
| `dropped_over_cap` | Staged past the limit of 3 and never sent                  |
| `dead_lettered`    | Its deferred reply was dead-lettered, so it was never sent |

Entries hold ids and values only, never ManyChat names or contact text. An entry
that stays `staged` means the process stopped before the action ran. That action
is never retried.

```sql
SELECT t.created_at, t.outcome, t.actions
FROM turns t JOIN conversations c ON c.id = t.conversation_id
WHERE c.subscriber_id = '<subscriber id>' AND t.role = 'agent'
ORDER BY t.seq;
```

### Before turning tools on in production

- **Expect slower replies.** A tool turn takes two model calls. In a local run on
  2026-09-28 with `openai:gpt-5-mini` at low reasoning effort, four tool turns
  took 8.4 to 15.5 seconds. All of them missed the 8-second deadline, so each
  contact got the holding message first and the answer through the outbox.
  The same model answered a question with no tools offered in 5.8 seconds.
- **Test the descriptions.** No check can tell whether a `description` leads the
  model to the right flow. Add eval cases that state the expected choice with
  `expect.actions`, as the golden set does:

  ```jsonl
  {"id":"flow-brochure","text":"can you send me something to read about the foundation course?","expect":{"escalate":false,"actions":["send_flow foundation_brochure"]}}
  {"id":"flow-not-for-schedule","text":"when does the weekend intensive run?","expect":{"escalate":false,"actions":[]}}
  ```

  `[]` asserts that tools were offered and none was chosen. Run them with
  `pnpm eval` against the real model.

- **`performed` is ManyChat's answer, not the contact's.** It means ManyChat
  accepted the request. A flow that is unpublished, or points at a missing file,
  can still be accepted. Send each flow to yourself once from ManyChat before
  listing it here.
- **Actions need `MANYCHAT_API_TOKEN`.** Without it every action is recorded as
  `failed`.
