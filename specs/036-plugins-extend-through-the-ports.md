---
status: specified
constitution: [C2, C4, C5, C6, C7]
adr: [0021, 0005, 0010, 0017]
---

# 036 — Plugins Extend the Agent Through the Ports, and Cannot Reach the Race

Defines how a tenant project adds a tool or a channel the agent does not ship:
the `definePlugin` API, how plugins are listed and loaded, and what a plugin is
and is not given. It leaves out the tenant project and the package, which are
`033`, and the built-in tools, which stay in `012`.

## Patching the package is the reflexive extension, and it does not survive an upgrade

A tenant who needs one more action, a write to their own CRM say, reaches for
the quickest route `033` leaves open: `pnpm patch`. That works until the next
release, when pnpm refuses the stale patch and the tenant re-applies it by hand,
every release, for a change upstream never asked for. ADR-0021 treats more than
one live patch in a tenant as the sign that this design has failed.

So the rule is:

> **A tenant extends the agent with a plugin that plugs into the existing ports,
> and the plugin gets no more power than a built-in tool has.**

## Plugins extend the agent through the ports, and cannot reach the race

A tenant who needs a tool `012` does not ship, or a channel other than
ManyChat, writes a plugin rather than patching the package. This amends
`012 § The mechanism is built here; only the choices are the tenant's`: a
deployment may now implement a tool, but only through the mechanism `012`
specifies, never beside it.

A plugin is an npm package whose default export is `definePlugin({ name,
apiVersion, tools?, channels? })`, imported from the bare `manychat-ai-agent`
entry point that this spec adds to `033`'s `exports` map, with the plugin types.
`config/plugins.json` lists the packages to load, and joins `033`'s contract
table as an optional tenant file:

```json
{ "plugins": ["agent-plugin-example-crm"] }
```

They are resolved from the tenant project's `node_modules` and loaded once, at
boot. `SIGHUP` reloads configuration, not code, so a plugin change is a
restart.

## A plugin tool is a staged action

It declares a name, a description, a parameter schema and a `perform` function,
and the server treats it exactly as it treats `012`'s six:

- the model's call stages the action, and `perform` runs after the reply and
  after the guardrails (ADR-0010, `012 § Guardrails run before any action is
performed`);
- the subscriber is never a parameter; `perform` receives it from the turn
  (`012 § The subscriber is never a parameter`);
- the parameter schema may hold enums, numbers and booleans, and a free-text
  string only as a declared note field under ADR-0017's limits (`012 § Free-text
field values are refused`);
- it counts towards `MAX_ACTIONS_PER_TURN`, and it runs inside the four-step
  loop and the race (`012 § The whole loop runs inside the race`);
- a failed `perform` is logged and never retried (`012 § A failed action is
logged, never retried`);
- a plugin tool may not take a built-in tool's name.

## A plugin channel implements `ChannelAdapter`, at `apiVersion: 0`

It is mounted at `/channels/<name>` and gets the same auth, the same budget and
the same race as the ManyChat route. ADR-0005 warns that a port validated by one
adapter is a guess at the right seam, so the channel half of the plugin API is
published as `apiVersion: 0`. It may break in any minor release until a second
adapter has been built against it, and its documentation says so.

## What a plugin is never given

A model, a provider client or the registry (C2); the system prompt or the
catalog (C4); the database connection; a logger other than the redacting one
(C5); a way to skip the guardrails or extend the deadline (C7). It receives the
turn's subscriber ID, its validated parameters and that logger.

## A plugin that does not load stops the server

A missing package, an `apiVersion` the installed agent does not support, a tool
name that clashes, or a schema that fails the checks above is a startup error,
and `agent config check` reports it the same way. Starting with a tool silently
missing would leave the prompt promising an action nothing performs (C6).

## A plugin API change is a breaking change

This adds a third kind to
`033 § A release is a version bump, and a breaking config change ships its migration`:
a change to `definePlugin`, to what a tool or channel receives, or to the
`apiVersion` values the agent accepts is breaking, except for the channel half
while it is at `apiVersion: 0`.

## A plugin is written for one codebase

When the Python service of ADR-0018 takes over, a tenant's plugins are ported,
and the Python service defines its own `definePlugin` against the same rules.
`033`'s contract survives the cutover; a plugin does not.

## Verification

- Plugin tests use an invented plugin under `test/fixtures/`: its tool is staged
  and performed after the reply; it receives the subscriber from the turn, not
  from the model; a string parameter outside a note field, a clashing name, and
  an unsupported `apiVersion` each stop startup; and the context it receives
  holds no model, database or prompt.
- A test asserts `package.json`'s `exports` map gains the bare entry point, and
  that it exports `definePlugin`.
- A test asserts `agent config check` fails on a `config/plugins.json` naming a
  package that is not installed.

**What this does not catch.** A plugin's `perform` is the tenant's code, and
nothing here can stop it from doing harm with the subscriber ID and its own
network access. The rules above bound what the agent hands it, not what it does
with that.
