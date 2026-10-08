---
status: implemented
implemented: 2026-10-08
constitution: [C3, C5, C6, C7]
adr: [0021, 0005, 0022]
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

A plugin declares its channels beside its tools, under `channels`. Each
implements the `ChannelAdapter` port (`src/channels/port.ts`): it parses the
platform's inbound request into a turn and renders the agent's reply into the
platform's response. It is mounted at `/v1/channels/<name>/message`, beside
ManyChat's route, and gets the same auth, the same budget, the same race, the
same per-contact order (`037`) and the same outbox as the ManyChat route. Its
inbound request is validated by a Zod schema it declares, before anything reads
it (C3). A request that fails it is refused with a 400 that does not say why,
and only after authentication, so a caller without the secret learns nothing
about the schema (`017`).

A channel declares `name`, `apiVersion`, `inbound` (the schema), `parse`,
`render` and `push`, and nothing else. Its name is lowercase letters, digits
and dashes, because it is the route's path segment. It may not be `manychat`
or another plugin's channel. A channel that fails any of these checks is a
startup error, as a tool that fails `036`'s checks is.

What `036 § What a plugin is never given` withholds from a tool, it withholds
from a channel too. `push` receives exactly four things: the contact's platform
ID, the reply's messages and whether it hands off, the agent's redacting logger
that names the plugin, and an abort signal.

### The adapter translates, and decides nothing

`parse` returns the contact's platform ID, their text, and optionally their name
and locale. That return is an external boundary too and is checked with a Zod
schema (C3). Everything else is decided by the agent, the same way for every
plugin channel:

- the tenant, and the channel, which is the channel's name;
- the contact's ID, which is the platform's ID prefixed with `<name>:`. A
  contact on one channel never shares a conversation, an order or an outbox lane
  with a ManyChat contact, or a contact on another channel, whose platform uses
  the same ID;
- that the request carries no contact token and no offering, and no media.

`render` and `push` are given the reply's messages and whether it escalates,
not its confidence or reason. A response rendered while the contact's previous
reply is still queued carries no messages. The reply follows through `push`
(`037`).

A `parse` that throws after the schema passed hands the contact to a person.
The channel's own `render` sends the handoff, as ManyChat's route does
(`017 § An error on the message route is a handoff, not a 500`).

### A plugin channel carries no contact token

`019`'s token is written to a ManyChat custom field and comes back in
ManyChat's callback. A plugin channel has neither. Its contacts are bound by
the channel's own auth, the shared secret: every turn on it is bound, reads
history, and counts towards the turn cap. No token is issued, and no token
write is ever queued. `CONTACT_TOKENS_ENFORCED` does not apply to it.

### Outbound delivery is the adapter's `push`

The port already has an outbound method, `push`, and a plugin channel
implements it. Each reply queued in the outbox records the plugin channel it
belongs to, and the worker delivers that reply through the channel's `push`,
never through `ManyChatClient`. A `push` that throws is retried with the
outbox's backoff and dead-lettered after its attempts, as a ManyChat send is.
One still running after 10 seconds counts as failed, and its signal aborts. A
reply queued for a channel that no plugin adds any more, because the process
restarted without it, is dead-lettered at once and never sent to ManyChat.

`012`'s flows, tags and fields, `024`'s contact read and `025`'s nudges act on
a ManyChat contact. So a plugin channel's turn is offered none of
`tools.json`'s tools, and its prompt carries none of their lines. Plugin tools
(`036`, `039`) are still offered, and a write tool's `perform` receives the
prefixed contact ID. This is the case ADR-0022 named for revisiting, and its
decision stands. The built-in tools are withheld from a channel that cannot
use them, not re-expressed as plugins.

## The channel API is provisional until a second adapter exists

ADR-0005 warns that a port validated by one adapter is a guess at the right
seam, and `ChannelAdapter` has one: ManyChat. So the channel half of the plugin
API is published as provisional. It may break in any minor release until a
second adapter has been built against it, and its documentation says so. It is
the one exception to `036 § A plugin API change is a breaking change`.

### Each channel names its own API version

One plugin may hold tools and channels, so the channel API is versioned apart
from the tool API. Each channel declares `apiVersion: 0` itself. The plugin's
top-level `apiVersion` stays the tool API's (`1` or `2`), and a plugin that
adds only channels still declares one. The agent exports `CHANNEL_API_VERSION`
and `SUPPORTED_CHANNEL_API_VERSIONS` beside the tool API's, and `defineChannel`,
which types `parse` from the schema and returns the channel unchanged. A
channel API `1`, once a second adapter has settled the seam, needs no new
plugin-level key.

## Verification

1. A test loads an invented channel plugin from `test/fixtures/plugins/` and
   asserts that it is mounted at `/v1/channels/<name>/message` behind the same
   auth as the ManyChat route.
2. An integration test sends a turn through the plugin channel and asserts that
   it runs the race, is ordered with the contact's other turns, and that a lost
   race is delivered through the plugin's outbound port.
3. A test asserts that a request failing the channel's schema is refused before
   the model is called.

Beside these, unit tests assert the loader's refusals (an unsupported or missing
channel `apiVersion`, a name that is not a path segment, `manychat`, a name
another plugin mounts, an unknown key, an `inbound` that is not a schema, a
missing `parse`, `render` or `push`). They also assert what the adapter decides
in the plugin's place, the 10-second bound on `push`, and that a plugin
channel's turn is offered no `tools.json` tool.

**What this does not catch.** A plugin channel's `push` and `render` are the
tenant's code. Nothing here stops `push` from sending the reply somewhere other
than the contact. The shared secret binds a channel's contacts only as far as
the platform behind it keeps the secret and sends the platform's real IDs. A
platform that lets one contact choose the ID another is answered on breaks
that, and no check here can see it.
