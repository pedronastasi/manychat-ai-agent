# Running it locally

Everything here runs from a clone of this repository, for trying the agent and
working on it. To deploy one for your own business, follow
[Starting a new agent](getting-started.md) instead.

## Development

```bash
pnpm bootstrap         # local config + .env from the committed examples
pnpm dev           # offline by default: mock model, embedded Postgres
pnpm simulate "…"  # send a Dynamic Block request as ManyChat would
pnpm test          # unit + integration
pnpm eval:mock     # golden set, offline and free
pnpm lint && pnpm typecheck
```

Integration tests run against **PGlite** — real Postgres compiled to WASM, in
process — so `FOR UPDATE SKIP LOCKED`, upserts and constraints behave as in
production with no container to start in CI.

## A local model

Run a real model locally via [Ollama](https://ollama.com) — free, no API key,
useful for testing the model boundary (schema adherence, latency, judgment)
without incurring API costs.

```bash
docker compose --profile local-model up        # starts Ollama alongside Postgres
AGENT_MODEL=ollama:llama3.1:8b pnpm simulate "hello"
```

The first run pulls ~4.7 GB of weights; they persist in a named Docker volume so
subsequent starts are instant. Any Ollama-supported model works — just use the
tag from `ollama list`:

```bash
AGENT_MODEL=ollama:gemma3:4b pnpm simulate "how much does the course cost?"
```

Inside Compose the agent reaches Ollama at `http://ollama:11434/v1`. Running
locally (outside Docker), it defaults to `http://localhost:11434/v1`; override
with `OLLAMA_BASE_URL` if needed.

Ollama models price at zero, so the daily dollar cap never fires. The token cap
still applies and guards against runaway loops. The 8 s race deadline means the
deferred path (acknowledge now, push the real answer later) becomes the default
for slower local models — that is by design.

## Running the full stack with Docker

Everything below uses the **mock model** (free, deterministic, no API key). To
use a real cloud model, set `AGENT_MODEL` and the matching API key in `.env`
before step 3.

### 1. Clone and bootstrap

```bash
git clone https://github.com/pedronastasi/manychat-ai-agent.git
cd manychat-ai-agent
pnpm install && pnpm bootstrap
```

`pnpm bootstrap` copies the example configs and `.env`. Everything in `config/`
is gitignored, so tenant data never reaches version control.

### 2. Set a shared secret

Open `.env` and replace the placeholder `MANYCHAT_SHARED_SECRET` with a real
value — any string of at least 16 characters. This is the bearer token you will
use in curl:

```bash
# generate one if you like
openssl rand -hex 32
```

### 3. Start the containers

```bash
docker compose up --build
```

This starts Postgres 18 and the agent. Wait for the log line:

```
{"level":30,"msg":"Server listening at http://0.0.0.0:3000"}
```

### 4. Chat with the agent

The agent exposes one endpoint: `POST /v1/channels/manychat/message`. It expects
a ManyChat Dynamic Block payload — a JSON body with at least `subscriber_id` and
`text` — and an `Authorization: Bearer <secret>` header.

**Ask about course prices:**

```bash
curl -s http://localhost:3000/v1/channels/manychat/message \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <your-secret-from-.env>' \
  -d '{"subscriber_id": "test-001", "text": "how much is the foundation course?"}' \
  | jq .
```

The response is a [Dynamic Block v2](https://manychat.github.io/dynamic_block_docs/)
object. The agent's reply is in `.content.messages[].text`:

```json
{
  "version": "v2",
  "content": {
    "messages": [
      { "type": "text", "text": "The Foundation Course is $450.00." },
      { "type": "text", "text": "It runs 24 hours total. Want the enrolment link?" }
    ],
    "external_message_callback": {
      "url": "https://agent.example.com/v1/channels/manychat/message",
      "method": "post",
      "headers": { "Authorization": "Bearer ..." },
      "payload": {
        "text": "{{last_input_text}}",
        "subscriber_id": "{{contact.id}}",
        "ai_token": "{{ai_token}}"
      },
      "timeout": 86400
    }
  }
}
```

The `external_message_callback` is what keeps the conversation alive: ManyChat
sends the contact's next message back here, rather than falling through to its
own flow, with their token filled in from their custom field.

**Continue the conversation** (same `subscriber_id`):

```bash
curl -s http://localhost:3000/v1/channels/manychat/message \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <your-secret-from-.env>' \
  -d '{"subscriber_id": "test-001", "text": "yes, send it"}' \
  | jq .content.messages
```

This remembers the first question because `pnpm bootstrap` sets
`CONTACT_TOKENS_ENFORCED=false`. Locally there is no ManyChat field to hold the
contact's token, so curl has none to send. With it `true`, as in production, a
request without the token is answered from its own message alone.

**Trigger an escalation:**

```bash
curl -s http://localhost:3000/v1/channels/manychat/message \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <your-secret-from-.env>' \
  -d '{"subscriber_id": "test-001", "text": "I want to speak to a human"}' \
  | jq .content.messages
```

**Healthcheck:**

```bash
curl http://localhost:3000/health
curl http://localhost:3000/ready
```

### 5. (Optional) Use a local model

To test with a real model for free, add Ollama:

```bash
docker compose --profile local-model up --build
```

Then set `AGENT_MODEL=ollama:llama3.1:8b` in `.env` and restart the agent
container (`docker compose up --build agent`). The first run pulls ~4.7 GB;
subsequent starts are instant.

With a local model, responses typically take 9–120 s, so the **deferred path**
fires on most turns: the agent sends an acknowledgement within 8 s, and the full
reply arrives later via the outbox worker.

### Using `pnpm simulate` instead of curl

If you prefer running outside Docker (`pnpm dev`), the simulator wraps the same
request and formats the output:

```bash
pnpm simulate "how much is the foundation course?"
pnpm simulate --subscriber 42 "can you give me a discount?"
```
