---
status: specified
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

A plugin declares its channels beside its tools. Each implements the
`ChannelAdapter` port (`src/channels/port.ts`): it parses the platform's
inbound request into a turn and renders the agent's reply into the platform's
response. It is mounted at `/v1/channels/<name>/message`, beside ManyChat's
route, and gets the same auth, the same budget, the same race, the same
per-contact order (`037`) and the same outbox as the ManyChat route. Its inbound
request is validated by a Zod schema it declares, before anything reads it
(C3).

What `036 § What a plugin is never given` withholds from a tool, it withholds
from a channel too.

## The channel API is provisional until a second adapter exists

ADR-0005 warns that a port validated by one adapter is a guess at the right
seam, and `ChannelAdapter` has one: ManyChat. So the channel half of the plugin
API is published as provisional. It may break in any minor release until a
second adapter has been built against it, and its documentation says so. It is
the one exception to `036 § A plugin API change is a breaking change`.

## Open before implementation

- **How a plugin names the channel API version.** The tool API is
  `apiVersion: 1` (`036`), and a provisional channel API was meant to be `0`.
  One plugin may hold both, so the channel half needs a version of its own,
  and where it is declared is not yet decided.
- **Outbound delivery.** The deferred path and every staged action are sent
  through `ManyChatClient`. A channel plugin needs an outbound port of its own,
  and `012`'s flows, tags and fields have no meaning outside ManyChat.

## Verification

1. A test loads an invented channel plugin from `test/fixtures/plugins/` and
   asserts that it is mounted at `/v1/channels/<name>/message` behind the same
   auth as the ManyChat route.
2. An integration test sends a turn through the plugin channel and asserts that
   it runs the race, is ordered with the contact's other turns, and that a lost
   race is delivered through the plugin's outbound port.
3. A test asserts that a request failing the channel's schema is refused before
   the model is called.
