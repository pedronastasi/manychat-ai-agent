import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The invented plugin every specs/036 test loads. */
export const EXAMPLE_PLUGIN = 'agent-plugin-example-crm';

/** The invented read plugin the specs/039 tests load. */
export const EXAMPLE_READ_PLUGIN = 'agent-plugin-example-schedule';

/** The invented channel plugin the specs/038 tests load. */
export const EXAMPLE_CHANNEL_PLUGIN = 'agent-plugin-example-widget';

/** The fixtures copied rather than written: a package given as its own name. */
const FIXTURES = new Set([EXAMPLE_PLUGIN, EXAMPLE_READ_PLUGIN, EXAMPLE_CHANNEL_PLUGIN]);

/**
 * A stand-in tenant project: `config/plugins.json` listing `listed`, and a
 * `node_modules` holding the agent and each plugin in `packages`. The agent
 * entry re-exports this repository's source, so a plugin imports
 * `manychat-ai-agent` as a real one does. A package given as source is
 * written as its `index.js`; a fixture's own name copies that fixture.
 */
export function tenantProject(
  listed: readonly string[] | undefined,
  packages: Record<string, string> = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'agent-plugins-'));
  mkdirSync(join(root, 'config'));
  if (listed) {
    writeFileSync(join(root, 'config', 'plugins.json'), JSON.stringify({ plugins: listed }));
  }
  const agent = join(root, 'node_modules', 'manychat-ai-agent');
  mkdirSync(agent, { recursive: true });
  writeFileSync(
    join(agent, 'package.json'),
    JSON.stringify({ name: 'manychat-ai-agent', type: 'module', exports: './index.js' }),
  );
  writeFileSync(
    join(agent, 'index.js'),
    `export * from ${JSON.stringify(pathToFileURL(resolve('src/index.ts')).href)};\n`,
  );
  // A channel's schema is the plugin's own Zod (specs/038), installed beside it.
  symlinkSync(resolve('node_modules/zod'), join(root, 'node_modules', 'zod'), 'dir');
  for (const [name, source] of Object.entries(packages)) {
    const dir = join(root, 'node_modules', name);
    if (FIXTURES.has(source)) {
      cpSync(join('test/fixtures/plugins', source), dir, { recursive: true });
      continue;
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, type: 'module' }));
    writeFileSync(join(dir, 'index.js'), source);
  }
  return {
    root,
    configDir: join(root, 'config'),
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * A read plugin package's source (specs/039): its one tool's parameters and
 * result given as source, with any extra keys. An empty `result` leaves it out.
 */
export function readPluginSource(
  fields: { name?: string; apiVersion?: unknown } = {},
  tool: { name?: string; parameters?: string; result?: string; extra?: string } = {},
): string {
  return `export default {
  name: ${JSON.stringify(fields.name ?? 'invented-reads')},
  apiVersion: ${JSON.stringify(fields.apiVersion ?? 2)},
  tools: [{
    name: ${JSON.stringify(tool.name ?? 'invented_read')},
    description: 'An invented read.',
    parameters: ${tool.parameters ?? '{}'},
    ${tool.result === undefined ? "result: { ready: { type: 'boolean' } }," : tool.result}
    ${tool.extra ?? ''}
    read() { return { ready: true }; },
  }],
};
`;
}

/** A plugin package's source, its one tool's parameters and perform given. */
export function pluginSource(
  fields: { name?: string; apiVersion?: unknown; extra?: string } = {},
  tool: { name?: string; parameters?: string } = {},
): string {
  return `export default {
  name: ${JSON.stringify(fields.name ?? 'invented')},
  apiVersion: ${JSON.stringify(fields.apiVersion ?? 1)},
  ${fields.extra ?? ''}
  tools: [{
    name: ${JSON.stringify(tool.name ?? 'invented_tool')},
    description: 'An invented tool.',
    parameters: ${tool.parameters ?? '{}'},
    perform() {},
  }],
};
`;
}

/**
 * A stand-in tenant project `agent plugin new` accepts (specs/041): the
 * project of `tenantProject`, with a `package.json` that depends on the
 * agent and no `pnpm-workspace.yaml`, as a `create` project has none.
 */
export function scaffoldProject(listed?: readonly string[], packages: Record<string, string> = {}) {
  const project = tenantProject(listed, packages);
  const manifest = {
    name: 'invented-tenant',
    private: true,
    type: 'module',
    dependencies: { 'manychat-ai-agent': '^0.19.0' },
  };
  writeFileSync(join(project.root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return project;
}

/**
 * A channel plugin package's source (specs/038): one channel with the given
 * fields as source. Its schema is a hand-written `safeParse`, which the
 * loader accepts as it accepts a Zod schema.
 */
export function channelPluginSource(
  channel: {
    name?: string;
    apiVersion?: unknown;
    extra?: string;
    inbound?: string;
    parse?: string;
    render?: string;
    push?: string;
  } = {},
  plugin: { name?: string } = {},
): string {
  return `export default {
  name: ${JSON.stringify(plugin.name ?? 'invented-channel')},
  apiVersion: 1,
  channels: [{
    name: ${JSON.stringify(channel.name ?? 'invented')},
    apiVersion: ${JSON.stringify(channel.apiVersion === undefined ? 0 : channel.apiVersion)},
    inbound: ${
      channel.inbound ??
      `{
      safeParse: raw =>
        raw && typeof raw.id === 'string' && typeof raw.text === 'string'
          ? { success: true, data: raw }
          : { success: false, error: new Error('invalid') },
    }`
    },
    parse: ${channel.parse ?? 'request => ({ subscriberId: request.id, text: request.text })'},
    render: ${channel.render ?? 'reply => ({ out: reply.messages })'},
    push: ${channel.push ?? '() => {}'},
    ${channel.extra ?? ''}
  }],
};
`;
}
