---
status: implemented
implemented: 2026-09-26
constitution: [C5, C6]
adr: [0012, 0014]
---

# 017 — Inbound Request Trust

Defines what the message endpoint checks before it believes a request: the
shared secret, the caller's address, and the scheme of the callback it hands
back. It also defines what a failure returns and what the logs carry, and names
the test that shows each control firing. Which contact a request speaks for, and
how much history it may read, is `019`. The deploy pipeline, dependency scanning
and transcript retention are left out.

## A control that no test fires does not exist

The reflexive way to secure a service is to list its controls. ADR-0006 named a
per-IP and per-subscriber rate limit as what bounds a leaked secret,
`SECURITY.md` repeated it, and `002` promised it. It never ran.
`@fastify/rate-limit` attaches itself to routes as they are declared, and
`buildServer` declared every route before `registerPlugins` registered the
plugin. Measured 2026-09-26: 320 requests to the message endpoint returned 320
× 401 and no 429. The per-subscriber key could not have worked either, because
it read `req.body` in a hook that runs before the body is parsed.

The list was not the problem. What was missing was a test that made the limiter
say no.

So the rule is: **every control this spec, `SECURITY.md` or an ADR relies on has
a test that makes it fire through the production composition.** That means the
`buildServer` a process gets, not an app assembled inside the test. A control
with no such test is removed from the documents rather than listed. Each clause
below names its test in § Verification.

The composition also changes so the ordering cannot go wrong again:
`buildServer` registers its plugins and then declares its routes, both inside
one async function, which leaves no call for `main.ts` to make in the wrong
order.

## The callback carries back the secret the caller presented

The shared secret authenticates every request, entry and callback alike. The
callback registered on every turn used to carry `MANYCHAT_SHARED_SECRET[0]`
whichever secret the caller presented, so a caller holding a retired secret was
handed its replacement. It now carries the secret the caller presented.

That has a cost during a rotation. A conversation carried on by callbacks keeps
presenting the secret it started with, because each reply registers the next
callback with the secret that came in, and a callback lives up to 24 hours. A
contact who keeps writing within 24 hours never moves to the new secret, and
once the old one is removed their next message gets 401 and no reply. The one
after it enters through the Dynamic Block with the new secret. So a routine
rotation waits at least 24 hours between updating the flow and removing the old
secret (`SECURITY.md`). Moving those conversations across would mean handing the
new secret to whoever presents the old one, which is what this clause removes.

The secret proves the caller, not the contact. The body's `subscriber_id` is
still believed from any holder of the secret until `019` is implemented.

## Authentication runs before the body is read

The guard is an `onRequest` hook. A request with no valid shared secret gets 401
before its body is parsed or validated.

It used to run as a `preHandler`, after validation, so a caller with no
credential got a 400 naming the schema's fields. Measured 2026-09-26: the
response was `Unrecognized key: "evil"`.

## Rate limiting is attached before any route and keyed on an address the proxy vouches for

- **Per address: 300 requests a minute**, as an app-level `onRequest` hook. That
  runs before each route's own hooks, so requests that fail authentication count
  too, and it reaches every route whenever the route is declared. The figure is
  the value `server.ts` has always carried and has never been measured against
  traffic. ManyChat calls from a small set of addresses, so every contact shares
  that budget. Compare it with the peak turns per minute in `turns` before
  relying on it.
- **Requests with and without the shared secret get separate budgets** at each
  address. The key is the address plus whether the request authenticated,
  checked in constant time from the header alone. A flood without the secret
  spends only its own budget, so it cannot lock ManyChat out, even when every
  caller reaches the service from the same proxy address. A holder of the secret
  can still spend the authenticated budget, and can already do worse.
- **The address is `req.ip`**, and `trustProxy` is `TRUST_PROXY`: the proxies
  whose `X-Forwarded-For` is believed, as addresses, CIDR ranges or the presets
  `loopback`, `linklocal` and `uniquelocal`. Empty, the default, trusts none, and
  `req.ip` is the socket peer. It used to be `true`, which believed any
  `X-Forwarded-For`, so a caller who rotated the header got a fresh budget on
  every request (measured 2026-09-26).
- **A list of addresses, not a hop count.** The first draft of this spec named
  `TRUST_PROXY_HOPS`. Fastify 5.12 treats a numeric `trustProxy` as trusting
  nothing, because a hop count cannot check that the immediate peer is a proxy
  at all. An address list can, so a caller reaching the service directly cannot
  forward an address of its choosing.
- **Per contact**, the limit stays `rules.rateLimit.turnsPerSubscriberPerHour`,
  enforced by `BudgetGuard` in the database, where the body is available. The
  in-memory limiter's per-subscriber branch is removed; it could never fire.

The list must name the proxies actually in front of the service, which this
repository cannot know. Left empty behind a reverse proxy, every caller shares
the proxy's address, and so one budget for each of the two kinds of request.
The separate budgets keep that from becoming an outage; setting `TRUST_PROXY` is
what makes the budgets per caller, and puts the caller's address in the logs.

Empty is the default because it is the only value no deployment can be fooled
by. `uniquelocal` would suit a single reverse proxy on a Docker network, but
wherever untrusted callers also sit on a private network, such as a Kubernetes
cluster or an office LAN, it would let them forward any address they liked.

## An error on the message route is a handoff, not a 500

An unhandled error on `POST /v1/channels/manychat/message` from an
authenticated caller returns 200 with the tenant's `messages.escalation`,
rendered as Dynamic Block v2, so the contact reaches a person (C6). It used to
return Fastify's default 500 body, which carries the error message. Measured
2026-09-26: a database failure put the connection error into the response.

- The response body carries no error text. The log line carries the error's
  name and code, and its message passes through `redactText` first (C5).
- The callback is registered as usual and carries the presented secret, which
  does not depend on what failed.
- **Overload is handed off too.** `@fastify/under-pressure` refuses new work
  with a 503 while the event loop lags more than a second, and that 503 passes
  through the same handler. On the message route the contact gets the
  escalation copy rather than a 503 ManyChat shows them nothing for, the model
  is never called, and the log line is `load shed`, not `unhandled error`.
- If the handoff itself cannot be rendered, the answer is
  `{ "error": "internal" }` with no error text, and the failure is logged as
  `handoff failed`.
- Every other route, and an unauthenticated caller, gets
  `{ "error": "internal" }`, or `{ "error": "unavailable" }` when load is shed,
  with the error's status, or 500 when it has none.
- Client errors keep Fastify's answer: a 400 for an invalid body, which only a
  caller holding the secret can reach, and a 429 from the rate limiter.

## Callbacks are HTTPS or the process does not boot

`EnvSchema` requires `PUBLIC_BASE_URL` to start with `https://`. It used to
accept any URL, so `http://` passed boot and then every turn failed when the
response schema refused the callback URL (measured 2026-09-26).

## Logs name the conversation, never the contact

Log lines about a turn carry `conversation`, the row's random UUID. No value
derived from `subscriber_id` is logged, and `pseudonymize` is removed
(ADR-0014). The old pseudonym was a 32-bit FNV-1a hash salted with the public
`TENANT_ID`, and ManyChat IDs are numeric, so enumerating them recovered the ID.

A request that fails before `startTurn` has no conversation, so its log lines
carry no contact identity.

## Verification

Each clause has a test through `buildServer` in
`test/integration/request-trust.test.ts` that cites its heading here.

| Clause                         | The test                                                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Rate limiting                  | The 301st request from one address gets 429, with the first 300 failing authentication. With no proxy trusted, rotating `X-Forwarded-For` does not reset the count             |
| Separate budgets               | After 301 requests without the secret from one address, a request with it from the same address gets 200. 300 requests with it are capped like any others                      |
| Trusted proxy                  | With `TRUST_PROXY` naming the peer, the forwarded address is the key: one exhausted address gets 429 and another does not. An entry that is not an address or range fails boot |
| Authentication before the body | No credential and an invalid body gives 401, not 400                                                                                                                           |
| The callback's secret          | A request with the second secret gets a callback carrying the second secret                                                                                                    |
| Handoff, not 500               | With database writes throwing, the response is 200 with the escalation copy and the callback, and contains no error text. The logged message is redacted                       |
| Overload                       | With the event loop held past the limit, the response is 200 with the escalation copy and no `Retry-After`, the model is not called, and the log says `load shed`              |
| HTTPS                          | `loadEnv` with an `http://` base URL throws `ConfigError`                                                                                                                      |
| Logs                           | The lines for a turn whose model call fails carry the conversation's ID, and no captured line contains the subscriber ID                                                       |

Each was also checked the other way: removing the rate-limit hook fails the
rate-limit tests, keying on the address alone fails the separate-budget test, and removing the error handler fails the handoff
tests.

What these cannot catch:

- **The real proxies.** `TRUST_PROXY` is set by the deployment. A wrong value
  either lets `X-Forwarded-For` through or keys every request to the proxy's
  address, and no test here sees the proxies.
- **Whether 300 a minute is right.** It is unmeasured; see § Rate limiting.
- **An unhandled error on a route other than the message route.** No such route
  can fail today (`/ready` catches its own), so that branch has no test.
- **A handoff that cannot be rendered.** Boot already checks everything the
  render depends on, so nothing reaches that branch today; it has no test.
- **Whether the secret is secret.** These tests prove the service refuses a
  request without it. Keeping it out of other hands is operational.
