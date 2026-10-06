import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The invented plugin every specs/036 test loads. */
export const EXAMPLE_PLUGIN = 'agent-plugin-example-crm';

/**
 * A stand-in tenant project: `config/plugins.json` listing `listed`, and a
 * `node_modules` holding the agent and each plugin in `packages`. The agent
 * entry re-exports this repository's source, so a plugin imports
 * `manychat-ai-agent` as a real one does. A package given as source is
 * written as its `index.js`; `EXAMPLE_PLUGIN` is copied from the fixture.
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
  for (const [name, source] of Object.entries(packages)) {
    const dir = join(root, 'node_modules', name);
    if (source === EXAMPLE_PLUGIN) {
      cpSync(join('test/fixtures/plugins', EXAMPLE_PLUGIN), dir, { recursive: true });
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
