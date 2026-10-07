# Writing a plugin tool

For a tenant project that needs the agent to do something `config/tools.json`
cannot: write to your own CRM, say, or call your booking system. A plugin adds
a tool of your own, which the agent uses exactly as it uses its built-in ones.
You never patch the package, so an upgrade stays a version bump.

The contract this guide follows is
[spec 036](../../specs/036-plugins-extend-through-the-ports.md), and
[spec 039](../../specs/039-plugin-reads-return-declared-data.md) for a tool
that looks something up. Where this guide and the specs disagree, the specs
win. Plugin channels, for a platform
other than ManyChat, are [spec 038](../../specs/038-plugin-channels.md) and
are not available yet.

Throughout, `agent-plugin-example-crm` stands for your plugin and
`crm_log_lead` for its tool.

## What a plugin tool can and cannot do

A plugin tool is a staged action, like `add_tag` or `set_field`:

- The model calls it while it writes the reply. The call only records the
  action. Your code runs after the reply has been sent, and not at all if the
  turn escalates to a person.
- It acts on the contact whose message the agent is answering. You get their
  subscriber ID from the turn; the model can never name another contact.
- Its parameters are choices, numbers and yes/no flags. Free text is only a
  `note`, at most 500 characters, and names, phone numbers, emails and links
  are removed from it before your code sees it.
- Your code gets the subscriber ID, the parameters, a logger and an abort
  signal. It never gets the model, the prompt, the catalog or the database.
- A failure is logged and recorded on the turn, and never retried. After 10
  seconds the agent stops waiting, records a failure and aborts the signal.
- Before the agent has recorded the contact as a prospect, it refuses the
  call, as it refuses its own writes
  ([spec 034](../../specs/034-intent-before-the-sale.md)).

## 1. Create the package

From your tenant project's root:

```sh
pnpm agent plugin new example-crm --write   # a tool that acts after the reply
pnpm agent plugin new example-crm --read    # a tool that looks something up
```

It writes `plugins/agent-plugin-example-crm/` from the agent's own invented
example, with the `apiVersion` your installed agent supports, and makes the
three edits that load it: `plugins/*` in `pnpm-workspace.yaml`,
`"agent-plugin-example-crm": "workspace:*"` in your `package.json`, and the
name in `config/plugins.json`. It makes all of them or none, and it installs
nothing. Run the two commands it prints next:

```sh
pnpm install
pnpm agent config check
```

The tool is named after the plugin, in snake case: `example_crm` here. Rename
it, and replace the invented backend, parameters and description, before the
plugin does anything real. Start from the command rather than a copy of
another deployment's plugin, which brings that deployment's endpoints and field
names with it ([spec 041](../../specs/041-plugin-new-starts-from-the-example.md)).

The package it writes is laid out like this, and you can write one by hand the
same way:

```text
example-tenant/
  config/
    plugins.json
  plugins/
    agent-plugin-example-crm/
      package.json
      index.js
  package.json
  pnpm-workspace.yaml
```

```json
{
  "name": "agent-plugin-example-crm",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": "./index.js",
  "peerDependencies": { "manychat-ai-agent": "*" }
}
```

## 2. Define the plugin

```js
import { definePlugin, defineTool } from 'manychat-ai-agent';

export default definePlugin({
  name: 'example-crm',
  apiVersion: 1,
  tools: [
    defineTool({
      name: 'crm_log_lead',
      description: 'Log the contact as a lead in the CRM once they have named a course.',
      parameters: {
        temperature: { type: 'enum', values: ['warm', 'hot'] },
        seats: { type: 'number', integer: true, min: 1, max: 4, optional: true },
        callback: { type: 'boolean' },
        summary: { type: 'note', maxLength: 120, optional: true },
      },
      async perform({ subscriberId, params, logger, signal }) {
        const response = await fetch('https://crm.example.com/leads', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ subscriberId, ...params }),
          signal,
        });
        if (!response.ok) throw new Error(`CRM answered ${response.status}`);
        logger.info('lead logged', { temperature: params.temperature });
      },
    }),
  ],
});
```

- **`name`** is lowercase snake case and must not be a built-in tool's name
  (`send_flow`, `add_tag`, `remove_tag`, `set_field`, `write_note`,
  `schedule_nudge`, `get_contact`) or another plugin's.
- **`description`** is the only guidance the model gets. Write it as a
  condition: when to call the tool, not what it does inside.
- **`parameters`** each have a `type` of `enum` (with `values`), `number`
  (optionally `integer`, `min`, `max`), `boolean` or `note` (with a
  `maxLength` up to 500). Any may add a `description` and `optional: true`. A
  `string` is refused: use a `note`.
- **`perform`** throws to report a failure. Pass `signal` to anything that
  waits, so the work stops when the agent stops waiting.

In TypeScript, `defineTool` types `params` from the declaration: above,
`params.temperature` is `'warm' | 'hot'` and `params.seats` is
`number | undefined`.

## A tool that looks something up

A write tool runs after the reply, so the model never sees what it did. When
the agent needs your data to answer (seats left, an order's status, an FAQ in
your own system), declare a read tool instead. The model calls it while it
writes the reply, and is shown what it returns.

```js
import { definePlugin, defineReadTool } from 'manychat-ai-agent';

export default definePlugin({
  name: 'example-schedule',
  apiVersion: 2,
  tools: [
    defineReadTool({
      name: 'class_availability',
      description:
        'Look up the seats left on a course when the contact asks whether there is room.',
      parameters: {
        course: { type: 'enum', values: ['foundation', 'advanced'] },
        query: { type: 'query', maxLength: 120, optional: true },
      },
      result: {
        seatsLeft: { type: 'number', integer: true, min: 0 },
        summary: { type: 'text', maxLength: 300, optional: true },
      },
      async read({ params, signal }) {
        const response = await fetch(`https://timetable.example.com/${params.course}`, { signal });
        if (!response.ok) throw new Error(`timetable answered ${response.status}`);
        return response.json();
      },
    }),
  ],
});
```

- **`read`** in place of `perform`. A tool declares one or the other, and a
  read tool needs `apiVersion: 2`.
- **`parameters`** are a write tool's, less the `note`. The one free text is a
  `query`, at most 200 characters. URLs, emails, phone numbers and long
  numbers are removed from it before `read` sees it; a name is not, so the
  agent tells the model never to put one there.
- **`result`** declares what `read` may return: `enum`, `number`, `boolean`,
  `text` (up to 1000 characters) and `list` (up to 5 strings). The agent drops
  a key you did not declare and cuts text to its bound. Anything else that does
  not fit, or a result over 2000 characters, reaches the model as
  `{ available: false }`. Text comes back fenced, as data the model never
  obeys.
- **A turn makes at most two reads**, `get_contact` included, and each has 1.5
  seconds. A read that throws or runs longer reaches the model as
  `{ available: false }`, and the agent answers from the catalog or hands the
  contact to a person.
- **Only a turn that may read the contact's history reads**: one that carries
  their token, or any turn while `CONTACT_TOKENS_ENFORCED` is `false`. On any
  other, the tool is not offered.
- The turn records which tool read, whether data came back and how long it
  took. It never stores the query or what you returned.

## 3. List it

```json
{ "plugins": ["agent-plugin-example-crm"] }
```

in `config/plugins.json`, which `agent plugin new` has already written. List
package names, never paths.

## 4. Check it, then restart

```sh
pnpm agent config check
```

loads every listed plugin exactly as the server does, reports each one's write
and read tools, and fails on one that is not installed, names an `apiVersion`
this agent does not support, clashes with another tool or declares a parameter
it refuses. The server refuses to start on
the same errors, rather than starting with a tool missing.

Plugins load once, at boot. `kill -HUP` reloads your configuration but not your
plugin's code, so a plugin change is a restart.

## Running it in the image

The published image runs from `/app`, with your `config/` mounted at
`/app/config`, so it looks for plugins in `/app/node_modules`. Build your own
image on top of the agent's and copy the plugin in:

```dockerfile
FROM ghcr.io/<owner>/manychat-ai-agent:<version>
COPY --chown=node:node plugins/agent-plugin-example-crm /app/node_modules/agent-plugin-example-crm
```

The image links `manychat-ai-agent` into its own `node_modules`, so the
plugin's import resolves to the agent it runs in. Nothing else of yours is in
that `node_modules`: a plugin that needs another package bundles it, or uses
what Node ships, as the `fetch` above does. Point the `image:` of your
`docker-compose.yml` at your image, and keep its tag moving with the agent's.

## Upgrading

A change to the plugin API is a breaking release of the agent
([spec 033](../../specs/033-tenant-projects-not-forks.md)), so it never
arrives in a patch. If an upgrade moves `apiVersion`, `agent config check`
says so before you deploy.
