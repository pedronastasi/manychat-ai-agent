# Writing a plugin tool

For a tenant project that needs the agent to do something `config/tools.json`
cannot: write to your own CRM, say, or call your booking system. A plugin adds
a tool of your own, which the agent uses exactly as it uses its built-in ones.
You never patch the package, so an upgrade stays a version bump.

The contract this guide follows is
[spec 036](../../specs/036-plugins-extend-through-the-ports.md). Where this
guide and the spec disagree, the spec wins. Plugin channels, for a platform
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

A plugin is an npm package. It can live in your tenant project's workspace, so
it is versioned with your configuration:

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
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": "./index.js",
  "peerDependencies": { "manychat-ai-agent": "*" }
}
```

Add `plugins/*` to `pnpm-workspace.yaml`, and the plugin to your project's
`package.json` as `"agent-plugin-example-crm": "workspace:*"`, then run
`pnpm install`. The agent resolves it from your project's `node_modules`.

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

## 3. List it

```json
{ "plugins": ["agent-plugin-example-crm"] }
```

in `config/plugins.json`. List package names, never paths.

## 4. Check it, then restart

```sh
pnpm agent config check
```

loads every listed plugin exactly as the server does, and fails on one that is
not installed, names an `apiVersion` this agent does not support, clashes with
another tool or declares a parameter it refuses. The server refuses to start on
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
