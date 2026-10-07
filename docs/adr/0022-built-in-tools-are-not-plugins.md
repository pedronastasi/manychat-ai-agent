# ADR-0022 — Built-in tools are not plugins

**Status:** accepted · **Date:** 2026-10-07

## Context

`036` gave tenants `definePlugin`, and `039` added read tools to it. The agent's
own seven tools (`send_flow`, `add_tag`, `remove_tag`, `set_field`,
`get_contact`, `write_note`, `schedule_nudge`) are still built from `tools.json`
by `buildTools`, beside the plugins rather than through them. Nobody reading
the repository can see why the plugin that holds them is not there.

The reflexive choice is to dogfood the API: ship the built-ins as a first-party
plugin. The strongest case for it is one extension path. A single loader,
validator and prompt mechanism for every tool cannot drift into two sets of
rules, and a rule added for one kind of tool reaches the other for free.

It does not fit, because the built-ins need exactly what
`036 § What a plugin is never given` withholds: parameter enums built from
`tools.json`, which reloads on `SIGHUP` while a plugin's declaration is fixed at
boot; turn state shared between tools, the prospect gate (`034`), the course
(`028`) and the funnel floor (`023`); a flow sent while the turn is running,
which the reply waits for (`029`, `030`); the `ManyChatClient`; and the nudge
store. Fitting them would mean either giving every tenant plugin those powers,
which undoes `036`'s rule that a plugin gets no more power than a built-in tool,
or a privileged plugin tier, which is a second API under the plugin name.

## Decision

The built-in tools stay in the agent, built by `buildTools`, and are not
re-expressed through `definePlugin`.

## Consequences

- The plugin API stays as narrow as `036` and `039` specify. No tenant plugin
  can reach the client, the database or another tool's turn state because a
  built-in needed to.
- Two tool mechanisms are kept side by side. The built-in names a plugin may not
  take are listed by hand in `src/plugins/loader.ts`, the prompt carries
  separate lines for plugin tools, and `agent config check` reports the two
  apart. A rule changed for one has to be checked against the other by review.
- The plugin API is never exercised by its heaviest user, so a gap in it is
  found by a tenant, not upstream.
- How `buildTools` is organised inside is a separate question, left to the
  change that next needs it, and not settled here.
- Revisit if a channel from `038` needs the ManyChat tools to be optional per
  channel, or if a plugin `apiVersion` gains config-derived enums and in-turn
  sends for its own reasons. Either would let the built-ins fit without
  widening what `036` withholds.
