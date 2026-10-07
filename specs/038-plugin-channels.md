---
status: implemented
implemented: 2026-10-07
constitution: [C3, C5, C6, C7]
adr: [0021, 0005]
---

# 038 — A Plugin Channel Implements `ChannelAdapter`, and Its API Is Provisional

Defines how a plugin adds a channel other than ManyChat: what it implements,
where it is mounted, and why its half of the plugin API may still change. The
plugin itself, `definePlugin`, `config/plugins.json` and loading are `036`.

## A second channel is the case a tool plugin does not cover

`036` lets a tenant add a tool without patching the package. A tenant whose
contacts write somewhere other than ManyChat has the same problem one layer
out, and the same reflexive answer: a patch, carried by hand through every
release. This spec gives that tenant the plugin route too. Until it is
implemented, `036` refuses a plugin with a `channels` key at startup, because a
channel that silently never mounts is a contact nobody answers (C6).

So the rule is:

> **A plugin channel is a `ChannelAdapter` the server mounts and runs exactly
> as it runs ManyChat's; the adapter translates, and decides nothing.**

## A plugin channel implements `ChannelAdapter`

A plugin declares its channels beside its tools. Each is mounted as a
`ChannelAdapter` (`src/channels/port.ts`): it parses the platform's inbound
request into a turn and renders the agent's reply into the platform's
response. It is mounted at `/v1/channels/<name>/message`, beside ManyChat's
route. It gets the same auth, the same budget, the same race, the same
per-contact order (`037`) and the same outbox as the ManyChat route. Its inbound
request is validated by a Zod schema it declares, before anything reads it
(C3).

What `036 § What a plugin is never given` withholds from a tool, it withholds
from a channel too.

## The server owns the adapter, and the plugin only translates

The plugin does not implement `ChannelAdapter` itself. It gives the
translation, and `PluginChannelAdapter` (`src/channels/plugin.ts`) wraps it in
the port:

- **`inbound`:** the body's schema. Anything with a Zod-shaped `safeParse`
  passes. A body that fails it is answered `400` before anything reads it.
- **`parse(body)`:** returns who wrote and what: `subscriberId`, `text`, and
  optionally `contactName`, `locale`, `contactToken` and `media`. The agent
  checks that result against a schema of its own (C3). A throw, or a result
  that fails, is answered with the escalation message, as any error on a
  message route is (C6, `017`).
- **`render({ messages })`:** builds the platform's response body. The messages
  are already fitted to the channel's `maxMessages`, overflow joined into the
  last one as `002` does for ManyChat. They are empty when the response must
  say nothing (`037`).
- **`push({ subscriberId, reply, signal })`:** delivers a reply outside the
  request.
- **`writeToken({ subscriberId, token, signal })`:** optional; see the token
  section below.

The tenant, the channel's name and the arrival time are the server's, never
the plugin's. `push` and `writeToken` are bounded as a plugin tool's `perform`
is: after `PLUGIN_PERFORM_TIMEOUT_MS` the signal aborts and the call fails.

## A contact belongs to one channel

The agent keeps a plugin channel's contact as `<channel>:<id>`. Conversations,
the per-contact order of `037`, the rate limit and the outbox are all keyed by
the subscriber, so none of them can mix a plugin channel's contact with a
ManyChat contact of the same id. The plugin's `push` and `writeToken` receive
the platform's own id. A plugin tool called on a plugin channel's turn
receives the `<channel>:<id>` form, which tells it where the contact is.

## The channel API is provisional until a second adapter exists

ADR-0005 warns that a port validated by one adapter is a guess at the right
seam, and `ChannelAdapter` has one: ManyChat. So the channel half of the plugin
API is published as provisional. It may break in any minor release until a
second adapter has been built against it, and its documentation says so. It is
the one exception to `036 § A plugin API change is a breaking change`.

## The channel API has a version of its own

A plugin may hold tools and channels at once, so one version cannot describe
both. The channel half is versioned by a second top-level field,
`channelApiVersion`, which this release accepts only as `0`. It is required
exactly when the plugin has `channels`. A plugin with channels and no
`channelApiVersion`, or another value, is refused at startup. So is a
`channelApiVersion` with no channels. The tool API stays `apiVersion: 1`, and a
break in the channel half moves only `channelApiVersion`.

## A lost race goes out through the channel's `push`

`ChannelAdapter` already declares `push` for the deferred path, so a channel
needs no second outbound port. Each outbox row records the adapter that
delivers it in a `channel` column. Existing rows, and every row ManyChat
delivers, read `manychat`. The worker sends a reply row, and retries a token
write, through that row's adapter. A failed `push` is retried as a failed
ManyChat send is. A row for a channel the process has not loaded, because its
plugin was dropped since the row was queued, is dead-lettered at once, since no
retry would find it.

## What only ManyChat can do is off on a plugin channel

`012`'s flows, tags, fields and notes, `025`'s nudges and `024`'s
`get_contact` all act on a ManyChat contact. On a plugin channel's turn none of
`tools.json` is offered or described in the prompt, and no contact read is
offered. Plugin tools are still offered, since they take only the subscriber.
Media is never downloaded: the turn takes `rules.messages.mediaFallback`, as
`020` does when nothing can read it. `031`'s playbook still applies: it holds
selling tactics, not ManyChat actions, and its heading makes every rule above
it win. Refusing to start when `tools.json` has
tools was rejected, because a tenant could then not run ManyChat with tools
and a second channel side by side.

## Tokens go through the channel, or there is no history

`019`'s token proves the contact, and on ManyChat it lives in a custom field. A
plugin channel may store it through an optional `writeToken`, and return it
from `parse` as `contactToken`. A turn then binds exactly as on ManyChat.

A channel without `writeToken` is issued no token, and its every turn is
unbound. While `CONTACT_TOKENS_ENFORCED` is on, no turn on it reads or extends
history, and the server logs a warning at startup saying so. Two alternatives
were rejected:

- **Treating such a channel's turns as bound** would let anyone holding the
  shared secret read any of its contacts' history: the exposure `019` closed.
- **Refusing such a channel** would rule out every platform that cannot echo a
  stored value back.

## Verification

1. A test loads an invented channel plugin from `test/fixtures/plugins/` and
   asserts that it is mounted at `/v1/channels/<name>/message` behind the same
   auth as the ManyChat route.
2. An integration test sends a turn through the plugin channel and asserts that
   it runs the race, is ordered with the contact's other turns, and that a lost
   race is delivered through the plugin's outbound port.
3. A test asserts that a request failing the channel's schema is refused before
   the model is called.

The decisions above are tested too:

- **Startup refusals:** a channel API version other than `0`, or one with no
  channels; a bad, reserved or repeated channel name; a channel with no schema;
  a missing method; an unknown key.
- **What only ManyChat can do:** a plugin channel's model call is offered no
  `tools.json` tool, and its media takes the fallback.
- **Contacts:** a plugin channel's contact and a ManyChat contact with the same
  id are kept apart.
- **Tokens:** a token is written through `writeToken`, and a request carrying
  it reads history. A channel without `writeToken` reads none, and warns.
- **Outbox:** a row for an unloaded channel is dead-lettered without a retry.

**What this does not prove.** Every test uses the invented fixture, and no
real platform has been built against this API. That is why it is provisional
(ADR-0005).
