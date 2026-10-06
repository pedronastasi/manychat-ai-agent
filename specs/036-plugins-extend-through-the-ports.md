---
status: implemented
implemented: 2026-10-06
constitution: [C2, C4, C5, C6, C7]
adr: [0021, 0010, 0017]
---

# 036 — Plugins Extend the Agent Through the Ports, and Cannot Reach the Race

Defines how a tenant project adds a tool the agent does not ship: the
`definePlugin` API, how plugins are listed and loaded, and what a plugin is and
is not given. It leaves out the tenant project and the package, which are
`033`, the built-in tools, which stay in `012`, and plugin channels, which are
`038`.

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

A tenant who needs a tool `012` does not ship writes a plugin rather than
patching the package. This amends
`012 § The mechanism is built here; only the choices are the tenant's`: a
deployment may now implement a tool, but only through the mechanism `012`
specifies, never beside it.

A plugin is an npm package whose default export is
`definePlugin({ name, apiVersion: 1, tools })`. `definePlugin`, `defineTool`
(which types a tool's `perform` from its parameters) and the plugin types are
imported from the bare `manychat-ai-agent` entry point, which this spec adds to
`033`'s `exports` map. Both functions return what they are given: the agent
checks a plugin when it loads it, so a plain object passes or fails the same
way.

`config/plugins.json` lists the packages to load, and joins `033`'s contract
table as an optional tenant file:

```json
{ "plugins": ["agent-plugin-example-crm"] }
```

Each entry is a package name, never a path. It is resolved from the
`node_modules` of the tenant project, the directory that holds `config/`, as
Node resolves a package, and loaded once, at boot. `SIGHUP` reloads
configuration, not code, so a plugin change is a restart. The image links the
agent into its own `node_modules`, so a plugin copied there, beside the mounted
`config/`, resolves its bare `manychat-ai-agent` import. A tenant with no
`plugins.json` loads none, and its prompt and tools are exactly what they were.

## A plugin tool is a staged action

It declares a name, a description, its parameters and a `perform` function, and
the server treats it exactly as it treats `012`'s six:

- the model's call stages the action, and `perform` runs after the reply and
  after the guardrails, on the inline and the deferred path alike (ADR-0010,
  `012 § Guardrails run before any action is performed`). A turn that
  escalates performs nothing;
- the subscriber is never a parameter; `perform` receives it from the turn
  (`012 § The subscriber is never a parameter`);
- a parameter is an `enum`, a `number` (optionally an integer, optionally
  bounded) or a `boolean`. Free text is only a `note`, with a `maxLength` of at
  most 500, cleaned when the action is staged exactly as a `tools.json` note is
  (ADR-0017, `012 § Free-text field values are refused`). A parameter of any
  other type is refused. The model-facing schema is built by the agent from
  this declaration, never taken from the plugin;
- it counts towards `MAX_ACTIONS_PER_TURN`, and the call that stages it runs
  inside the four-step loop and the race (`012 § The whole loop runs inside
the race`);
- before the contact is a prospect it is refused, as a built-in write is
  (`034`);
- a failed `perform` is recorded on the turn and logged without its notes, and
  never retried (`012 § A failed action is logged, never retried`). A
  `perform` still running after 10 seconds counts as failed, and the signal it
  was given aborts;
- an action queued for a plugin tool that is no longer loaded, because the
  process restarted without it, fails the same way. It is never sent to
  ManyChat;
- a plugin tool may not take a built-in tool's name, `get_contact` included,
  nor another plugin's.

The prompt gains two lines only when a plugin adds a tool: that the deployment
has tools of its own, and that they are staged like the others. What a tool is
for is its description.

## What a plugin is never given

A model, a provider client or the registry (C2); the system prompt or the
catalog (C4); the database connection; a logger other than the redacting one
(C5); a way to skip the guardrails or extend the deadline (C7). `perform`
receives exactly four things: the turn's subscriber ID, its validated
parameters, the agent's redacting logger, which names the plugin on every line
and removes the subscriber ID from what the plugin writes, and an abort signal.

## A plugin that does not load stops the server

A package that is not installed or does not import, an `apiVersion` the
installed agent does not support, a tool name that clashes, a parameter that
fails the checks above, an unknown key, or a `channels` key, which `038` has
not yet given a meaning, is a startup error. `agent config check` loads the
plugins as `agent serve` does and reports the same error. Starting with a tool
silently missing would leave the prompt promising an action nothing performs
(C6).

## A plugin API change is a breaking change

This adds a third kind to
`033 § A release is a version bump, and a breaking config change ships its migration`:
a change to `definePlugin`, to what a tool receives, or to the `apiVersion`
values the agent accepts is breaking. The tool API starts at `apiVersion: 1`,
not `0`, because it is not provisional: a plugin tool is `012`'s mechanism,
which is already settled. The channel API of `038` is provisional, and says so
itself.

## A plugin is written for one codebase

When the Python service of ADR-0018 takes over, a tenant's plugins are ported,
and the Python service defines its own `definePlugin` against the same rules.
`033`'s contract survives the cutover; a plugin does not.

## Verification

1. A test asserts that `package.json`'s `exports` map gains the bare entry
   point, and that it exports `definePlugin`, `defineTool` and the API version.
2. Plugin tests load an invented plugin from `test/fixtures/plugins/`. With no
   `plugins.json` none is loaded; a listed package is resolved from the tenant
   project's `node_modules`. In the image's layout, a plugin copied into its
   `node_modules` loads, and the Dockerfile makes the link that lets it.
3. Unit tests assert that each of the following stops startup: a missing
   package, an unsupported `apiVersion`, a built-in tool's name, a name another
   plugin defines, a free-text string parameter, a note longer than 500, a
   `channels` key, an unknown key, a path in place of a package name, a
   malformed `plugins.json`, and a default export that is not a plugin.
4. Unit tests assert that a plugin tool is offered beside the built-in tools,
   that a call stages it without performing it, that its parameters are
   checked against the declaration, that a subscriber the model names is
   dropped, that a note is cleaned when staged, that it counts towards
   `MAX_ACTIONS_PER_TURN`, that it is refused before the contact is a
   prospect, and that the prompt changes only when a plugin adds a tool.
5. Unit tests assert that `perform` receives the turn's subscriber, its
   parameters, the logger and a signal and nothing else; that every other
   action goes to the performer it wraps; that the logger redacts and names the
   plugin; that a failure is recorded without its note and not retried; that
   the agent stops waiting after 10 seconds and aborts the signal; and that a
   row for a plugin that is no longer loaded fails without reaching ManyChat.
6. Integration tests assert that a plugin tool is performed after the response
   on the inline path, after the text is delivered on the deferred path, and
   not at all when the turn escalates.
7. A test asserts that `agent config check` fails on a `config/plugins.json`
   naming a package that is not installed, and names the loaded plugins when
   they load.

**What this does not catch.** A plugin's `perform` is the tenant's code, and
nothing here can stop it from doing harm with the subscriber ID and its own
network access. The rules above bound what the agent hands it, not what it does
with that. Nor does the 10-second bound stop work the plugin started: a
`perform` that ignores its signal keeps running after the agent records it as
failed.
