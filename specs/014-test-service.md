---
status: specified
constitution: [C1, C3, C5, C7, C9]
adr: [0001, 0005]
---

# 014 — Test Service

Defines a private, always-on place to try this repository's code from a
browser: a chat page served by the agent itself behind a flag, running the mock
model on the example tenant, deployed by hand from a GHCR image to a host that
already exists. It deliberately leaves out real and open models, deferred
(outbox) delivery to the page, multi-user features, and every detail of the
host it runs on.

## The obvious demo is a separate frontend calling a model, and it tests code that does not ship

The reflexive shape for "a UI to test the agent" is a small single-page app —
Vite, a chat widget — that calls the model, or at best `TurnHandler`, through
an endpoint of its own. It is quick to build and it is the wrong thing to
build, because of what it skips.

A reply reaches a WhatsApp contact through exactly one path:
`POST /v1/channels/manychat/message`, behind `createSharedSecretGuard`, parsed
against `ManyChatInbound`, rate-limited per subscriber, raced against
`RACE_DEADLINE_MS` in `TurnHandler` (ADR-0001, C7), and rendered by the
adapter into a Dynamic Block. A page that enters anywhere below the route
tests a subset of that, and a green result on it says nothing about the rest.

So the rule is:

> **The test page drives the production route, in-process, and nothing else.**

The page posts to a demo route. The demo route builds a `ManyChatInbound` body
and hands it to `app.inject()` against `/v1/channels/manychat/message`, with
the bearer token attached. Fastify runs the real preHandler, the real schema,
the real rate limiter and the real handler; the demo route only unwraps the
Dynamic Block for display. It adds no second implementation of a turn, and
there is no loopback HTTP hop to configure.

A separate frontend package is rejected on the same grounds as ADR-0005 rejects
a second channel: a second app with its own build, its own dependencies and its
own deploy, maintained for a tool whose only job is to watch the first one.

## The shared secret stays on the server

Calling the ManyChat route from the browser would need `MANYCHAT_SHARED_SECRET`
in the page, and a secret served to a browser is a published secret. The page
therefore never holds it: `app.inject()` attaches it server-side, and the page
talks only to the demo route, which requires no secret.

| Route           | Method | Serves                                         |
| --------------- | ------ | ---------------------------------------------- |
| `/demo`         | GET    | One static HTML page, inline script and styles |
| `/demo/message` | POST   | `{ session, text }` → the rendered reply texts |

`/demo/message` validates its body with Zod like every other boundary (C3):
`session` is a client-generated identifier, `text` is bounded by the same
limit `ManyChatInbound` applies. The route prefixes `session` with `demo-` to
form the `subscriber_id`, so demo conversations are recognisable in the
database and each browser session gets its own rate-limit key.

Neither route logs the message text. Both log through the same pino instance,
so the redaction paths in `server.ts` apply without opt-in (C5).

## The page is off unless a flag enables it, and refuses to start on a real model

`DEMO_UI` defaults to `false`. When it is `false`, neither route is registered:
`GET /demo` is a 404, not an empty page, so a production deployment has no
surface to probe.

When it is `true`, `loadEnv()` fails at startup unless `AGENT_MODEL` starts with
`mock:`. This is not a default that can be overridden; there is no second flag.

The reason is cost, and it is the constraint this service was specified under:
it must cost nothing to run, forever, including on the day somebody leaves it
up and a URL gets shared. The mock model makes that true by construction
(`007 § The repository already costs nothing to run`). A real key behind a
page anyone with the password can type into makes it false, silently, and the
first signal is an invoice.

The same check closes the other failure: `DEMO_UI=true` copied into a
production `.env` stops that deployment from booting, instead of putting a
chat page in front of a live tenant's paid model.

The cost is accepted plainly: this service can never be used to try a real
model. That is what `pnpm simulate` and spec 007 are for, on a machine whose
owner is watching the bill.

## The page shows inline replies only

The mock answers in about a millisecond against an 8-second race, so every
demo turn resolves inline and the page shows the reply the route returned.

If a turn is ever deferred, the page shows the acknowledgement and nothing
after it. The deferred reply goes to the outbox, and the worker tries to
deliver it through the ManyChat client, which on this service has no
`MANYCHAT_API_TOKEN` and fails loudly by design (`server.ts`). Polling the
outbox from the page would be a second delivery path that production does not
have, so it is not built. A deferred turn on the test service is a finding to
investigate, not a gap to paper over.

## It runs on the example tenant, never on tenant config

The service's `config/` directory on the host holds copies of the committed
`*.example` files, produced by `pnpm bootstrap`'s `scripts/setup.mjs`, and
nothing else (C1). A real tenant's persona or catalog behind a shared password
is tenant data outside the tenant's control, whatever the host.

The page's own labels — an input placeholder, a send button, a session reset —
are English developer UI, in the same category as `pnpm simulate`'s console
output. The page contains no sentence the agent sends; every reply shown comes
from the mock and the example config (C9, `005`).

## The image is a test artefact, not a release

`010 § Deliberately not in scope` excludes container images from a release, and
this does not change that. The test-service image is tagged by **commit SHA**,
never by version, is never attached to a GitHub Release, and carries no promise
to anyone but the person deploying it. `010` is amended to say so.

It is built by `.github/workflows/test-service.yml`, separate from `ci.yml` and
`release.yml`:

| Property    | Value                                                            |
| ----------- | ---------------------------------------------------------------- |
| Build on    | push to `main`, after the commit is merged                       |
| Pushes      | `ghcr.io/pedronastasi/manychat-ai-agent:<sha>` — never `:latest` |
| Permissions | `contents: read`, `packages: write` — nothing else               |
| Guard       | `if: github.repository == 'pedronastasi/manychat-ai-agent'`      |
| Dockerfile  | the existing one, unchanged                                      |

The guard is the one `release.yml` already carries, for the same reason:
workflow files are mirrored into a downstream deployment repository, and
without it the job runs there too and pushes an image under the wrong owner.

`packages: write` is the only write grant, so `010`'s test that no workflow
besides `release.yml` requests `contents: write` holds unchanged.

## Deploying is a manual dispatch that pins a SHA

The same workflow has a `workflow_dispatch` trigger taking one input, `sha`. It
connects to the host over SSH and brings up a Compose project of its own —
the agent and a Postgres container — with `AGENT_IMAGE_TAG` set to that SHA.
It pulls; it never builds on the host, so the code running is the code CI
built.

The image's runtime cannot use `DATABASE_URL=pglite`: PGlite is a
`devDependency` and the production install drops it. The project therefore
includes its own Postgres rather than moving PGlite into the runtime image,
which would change every production image to serve a test.

Nothing deploys automatically. The service is for trying a specific commit on
purpose; an auto-deploy would replace the build under test mid-session.

| Secret                 | Holds                                     |
| ---------------------- | ----------------------------------------- |
| `TEST_SERVICE_HOST`    | Host address                              |
| `TEST_SERVICE_PORT`    | SSH port                                  |
| `TEST_SERVICE_USER`    | SSH user                                  |
| `TEST_SERVICE_SSH_KEY` | Private key, authorised for that user     |
| `TEST_SERVICE_DIR`     | Directory holding the project on the host |

## The repository knows nothing about the host

The Compose overlay for the test service is committed, and it contains no
hostname, domain, network name or credential. The external network the
reverse proxy listens on is read from `${EDGE_NETWORK}`; the database password
from `${POSTGRES_PASSWORD}`; both live in the host's `.env`, which is
gitignored.

Everything else about the host stays off this repository: the domain, the
reverse-proxy site block, and the basic-auth credentials that gate it. Basic
auth is enforced by the proxy, not the app, so the flag-gated routes carry no
authentication code of their own and the app cannot be misconfigured into
serving the page unauthenticated by a change here.

This is C1 applied to infrastructure. The host this runs on also serves a real
tenant, and its domain names identify that tenant as surely as a price list
would.

## Verification

- A unit test asserts `GET /demo` and `POST /demo/message` return 404 when
  `DEMO_UI` is unset.
- A unit test asserts `loadEnv()` throws when `DEMO_UI=true` and `AGENT_MODEL`
  is not `mock:*`, and succeeds for `mock:demo`.
- An integration test against PGlite posts to `/demo/message` and asserts a
  turn was persisted for subscriber `demo-<session>` — evidence the request went
  through the ManyChat route and `TurnHandler`, not around them.
- A test asserts the HTML served at `/demo` does not contain any value of
  `MANYCHAT_SHARED_SECRET`.
- A test asserts `test-service.yml` carries the repository guard and requests
  no permission besides `contents: read` and `packages: write`. `010`'s
  existing `contents: write` check covers it without change.
- A test asserts the committed overlay contains no literal network name, i.e.
  that its external network is `${EDGE_NETWORK}`.

**What this misses.** Basic auth, the proxy block, the host's `config/` and the
deploy itself are outside the repository, and are checked by hand after each
dispatch: the page answers behind the password, and refuses without it. Nothing
here can detect a tenant's real config copied onto the host in place of the
examples; the refusal to boot on a real model narrows the damage — no spend —
but review of the host is the only enforcement. The `app.inject()` test proves
the route is reached, not that a future refactor keeps it that way; a demo
route that grows its own call to `TurnHandler` would pass every test above
until someone reads it.
