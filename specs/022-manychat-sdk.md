---
status: specified
constitution: [C5, C7]
adr: [0001, 0008, 0012]
---

# 022 — ManyChat API Through manychat-sdk

Defines how the agent's calls to the ManyChat API move onto the
[`manychat-sdk`](https://github.com/pedronastasi/manychat-sdk) package, and
which of its defaults the agent overrides to keep delivery behaving as `002`
and `019` describe. It leaves out inbound media downloads (`020`, which fetch
from ManyChat's storage, not its API), the Dynamic Block response (`002`), and
what `012`'s actions do: only how they are sent.

## Swapping the client for the SDK with its defaults would change delivery

The reflexive migration replaces the body of `ManyChatHttpClient` with SDK
calls and accepts whatever the SDK does by default. Every call site compiles,
and delivery changes in four places nobody chose:

| Behaviour                  | `client.ts` today                           | SDK default                               |
| -------------------------- | ------------------------------------------- | ----------------------------------------- |
| Timeout on a reply send    | None: a hung call stalls the worker forever | 10 s, then a retryable error              |
| Burst before rate limiting | 5 requests                                  | Equal to the rate: 10                     |
| Body of a 2xx response     | Never read                                  | Parsed; an error in it, or no JSON, fails |
| Limiters in one process    | Two: the server's and the worker's          | One per instance, however many are built  |

None of these is wrong in itself, and two are improvements. The point is that
each is a delivery decision, and a dependency's default is not where delivery
decisions get made. So the rule is:

> **Adopting the SDK changes no delivery behaviour this spec does not name.**
> Every SDK option the agent relies on is set explicitly, and every behaviour
> that does change is stated here with its reason.

## The SDK sits behind the ManyChatClient port, and only client.ts imports it

`ManyChatClient` stays the port (ADR-0008), and `ManyChatHttpClient` stays its
implementation. The SDK becomes the transport inside it. The adapter, the
outbox worker, the turn handler and the backfill keep depending on the port and
never see an SDK type.

Only `src/channels/manychat/client.ts` imports `manychat-sdk`, as only
`registry.ts` imports a provider (C2). It matters here for a reason C2 does
not have: the SDK exposes `page.setBotField` beside
`subscriber.setCustomFieldByName`, with near-identical parameters. The first
writes a value every contact sees, and the second writes only the given
contact's value. The choice between them decides whether one contact's reply
can reach another (`002 § The reply field is per-subscriber, never a bot
field`), and it stays in one file where a reviewer can see it.

The port's behaviour does not change:

- `sendText` writes the field, then sends the flow, per message, sequentially
  (`002 § The two calls are one delivery`).
- `writeToken` writes the contact's own field
  (`019 § Each contact's token lives in ManyChat, never in a response`).
- `performAction`, when `012` lands, is one SDK call per action: `sendFlow`,
  `addTagByName`, `removeTagByName` or `setCustomFieldByName`. Whichever of
  `012` and this spec is implemented second moves those calls onto the SDK.

## One instance per process, at 10 requests a second in bursts of 5

The rate limit is a property of the process, not of each call site. `main.ts`
builds one SDK instance, wrapped in one `ManyChatHttpClient`, and gives it to
both the server and the outbox worker. Today each builds its own client with
its own limiter, so the process can send twice the rate its configuration
states. A single instance makes the configured rate the real one.

The instance is configured explicitly:

| Option      | Value                                 | Source                                  |
| ----------- | ------------------------------------- | --------------------------------------- |
| `rateLimit` | `{ requestsPerSecond: 10, burst: 5 }` | `client.ts` today; chosen, not measured |
| `timeoutMs` | `10_000`                              | See the next section                    |
| `baseUrl`   | `MANYCHAT_API_BASE`                   | Unchanged                               |

Ten a second stays well under ManyChat's documented ceiling of about 25. The
rate and the burst were chosen rather than measured. Change them when a
measurement shows a need, and record its date here.

`pnpm tokens:backfill` is a separate process and builds its own instance with
the same options.

Without `MANYCHAT_API_TOKEN`, no SDK instance is built: the SDK refuses an
empty key when constructed, and the server must still boot for local
development. The existing stand-in, which fails each deferred send and token
write when it is called, serves the server and the worker alike.

## Every call is abandoned after 10 seconds, and a timed-out send is retried

Today a reply send has no timeout. A connection ManyChat accepts and never
answers holds the worker's batch indefinitely, and every reply queued behind it
waits. With the SDK, every call gives up after 10 s, including the rate
limiter's wait, and fails as retryable. The outbox reschedules it with its
existing backoff.

The cost is stated rather than hidden: a send that ManyChat carried out but
answered too slowly is sent again, and the contact receives that reply twice.
It is accepted because the alternative is worse. A reply that is never sent
leaves a contact waiting for an answer, while a duplicate is visible and
harmless. The SDK makes this the caller's call, never retrying on its own
([its ADR-0004](https://github.com/pedronastasi/manychat-sdk/blob/main/docs/adr/0004-no-automatic-retries.md)).

Ten seconds is the bound token writes already use. It sits well inside the
60 s before a failed token write is retried (`TOKEN_RETRY_DELAY_MS`), so a hung
write cannot land after the worker has replaced the token it carries (`019`).

## No SDK call is awaited inside an inbound request

C7's budget is for the response ManyChat is waiting on. The only ManyChat call
started during an inbound request is the contact's token write, which is
started and not awaited (`019`). `012`'s inline actions run after the response
has been sent. Nothing this spec changes may put an SDK call between an inbound
request and its response. A 10 s timeout inside a 10 s budget is not a bound.

## Retries follow the SDK's retryable, not instanceof

The worker decides whether to retry a row from `ManyChatError.retryable`:

| Failure                                                      | Retried | Today     |
| ------------------------------------------------------------ | ------- | --------- |
| ManyChat answered 429 or 5xx                                 | Yes     | Same      |
| Timeout, or no connection                                    | Yes     | Same      |
| ManyChat answered another 4xx                                | No      | Same      |
| ManyChat answered 2xx with `"status": "error"`               | No      | Delivered |
| ManyChat answered 2xx with a body that is not JSON           | No      | Delivered |
| An error that is not a `ManyChatError`, such as the database | Yes     | Same      |

The two changed rows exist because today's client never reads a 2xx body.

An error reported with a 2xx is a request ManyChat refused, and today it is
counted as delivered: the contact never gets the reply, and nothing says so.
It is now dead-lettered like any other refusal, which is a fix.

A 2xx body that is not JSON is not retried, because ManyChat may already have
acted on the request, as in the timeout case. This can lose a reply: if the
field write in `sendText` is the call that returns such a body, its flow is
never sent and the row is dead-lettered. ManyChat has not been seen to answer
that way. If it does, the dead-letter log at `error` is the signal, and it is
the signal already in use.

## Error text stays within what C5 and 019 allow

The SDK's error messages carry the endpoint, the status and ManyChat's own
message, and never the API key or the parameters sent. ManyChat's message can
still quote a value it was sent, so the existing limits stay in force:

- A failed token write's outbox row records the status and nothing else
  (`019`).
- The turn handler logs a failed token write by the error's name and status,
  plus the `reason` of a connection failure (`timeout`, `aborted`, `network`).
  It does not log the message.
- A failed reply's outbox row records the error's message, as it does today.
  The field value in that request is the reply, which the outbox already holds.

## A 0.x release of the SDK is a major, and gets its own pull request

`011` batches minor updates into one pull request, on the grounds that a minor
is additive by contract. Before 1.0, `manychat-sdk` breaks that contract on
purpose: its breaking changes ship as minors. So `renovate.json` gains a rule
for `manychat-sdk` that gives each update its own pull request and never
auto-merges a minor. Patches follow `011` unchanged. The dependency is declared
as `^0.x.y`, which admits patches only.

The package being maintained by the same person as this repository earns it no
exemption. `011 § Auto-merge is a claim about CI, and CI does not check for
malice` applies to it as to any other dependency.

## Tests fake fetch, and the fake returns what ManyChat returns

The SDK takes a `fetch` option, so tests keep faking only the ManyChat HTTP
boundary (`004 § What a test here looks like`). A fake now has to honour more
of the contract, because the SDK reads what the old client ignored. It answers
with a real `Response`, and a success carries ManyChat's `{"status":"success"}`
body. The fake in `test/helpers/manychat.ts` that answers with a plain object
is replaced.

## Verification

1. A unit test asserts that no file under `src/` other than
   `src/channels/manychat/client.ts` imports `manychat-sdk`.
2. The existing tests of `sendText` and `writeToken` pass without changes to
   what they assert: the same endpoints, bodies and order. Those tests are the
   evidence that the port's behaviour survived the swap.
3. With fake timers, a test sends six requests through the instance the server
   and worker share, and asserts that five go at once and the sixth waits for
   the refill.
4. A test drives a reply send against a fake that never answers. It asserts the
   call fails within 10 s and the row is rescheduled, not dead-lettered.
5. A test drives each row of `§ Retries follow the SDK's retryable` and asserts
   retried or dead-lettered.
6. A test asserts that a failed token write's outbox row and log line hold no
   text from ManyChat's error body.
7. The server boots with `MANYCHAT_API_TOKEN` unset, and a deferred send fails
   loudly when called.
8. A test asserts `renovate.json` has a rule for `manychat-sdk` that does not
   auto-merge minors, alongside the config validator that CI already runs.

What this misses: every test fakes ManyChat, so none shows that the SDK's
response schemas accept what the live API returns. The SDK derives them from
ManyChat's published spec and invented fixtures, not recorded responses. A
production send that fails as an unreadable response is where that would first
show. Nothing detects a duplicate reply either: the cost accepted in
`§ Every call is abandoned after 10 seconds` is known, not measured.
