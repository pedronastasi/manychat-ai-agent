import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PLUGIN_API_VERSION, SUPPORTED_PLUGIN_API_VERSIONS } from './api.ts';
import {
  BUILT_IN_TOOLS,
  PLUGINS_FILE,
  TOOL_NAME,
  checkPlugin,
  entryOf,
  listedPlugins,
  packageDir,
} from './loader.ts';
import { ConfigError } from '../config/loader.ts';

/**
 * `agent plugin new`: a plugin package started from the agent's own invented
 * example, and the three edits that make the project load it (specs/041).
 */

export type PluginKind = 'read' | 'write';

/** The prefix every scaffolded package name carries. */
export const PLUGIN_PREFIX = 'agent-plugin-';

/**
 * The templates, read from the installed agent and never from the project.
 * The path holds from `src/plugins/` and from `dist/plugins/` alike, and
 * `package.json` ships the directory (specs/041 § Verification 5).
 */
export const TEMPLATES_DIR = fileURLToPath(
  new URL('../../src/plugins/templates/', import.meta.url),
);

export const TEMPLATE_FILES: Record<PluginKind, string> = {
  read: 'read.js.tmpl',
  write: 'write.js.tmpl',
};

/** The globs `pnpm-workspace.yaml` must list for `plugins/<name>` to be a workspace package. */
const WORKSPACE_FILE = 'pnpm-workspace.yaml';
const WORKSPACE_GLOB = 'plugins/*';

/** An npm package name in lowercase kebab case, unscoped. */
const PACKAGE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_PACKAGE_NAME = 214;

/** A refusal: the project is left as it was found, and the command exits 1. */
export class ScaffoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScaffoldError';
  }
}

export interface PluginNames {
  /** The package name: `agent-plugin-<name>`. */
  packageName: string;
  /** The plugin's `name`: the part after the prefix. */
  pluginName: string;
  /** Its one tool's name: that part in snake case. */
  toolName: string;
}

/** The names `<name>` derives, or a refusal naming why it cannot be one. */
export function pluginNames(name: string): PluginNames {
  const packageName = name.startsWith(PLUGIN_PREFIX) ? name : `${PLUGIN_PREFIX}${name}`;
  const pluginName = packageName.slice(PLUGIN_PREFIX.length);
  if (
    !PACKAGE_NAME.test(packageName) ||
    pluginName.length === 0 ||
    packageName.length > MAX_PACKAGE_NAME
  ) {
    throw new ScaffoldError(
      `${JSON.stringify(name)} is not a package name in lowercase kebab case, such as slot-finder`,
    );
  }
  const toolName = pluginName.replaceAll('-', '_');
  if (!TOOL_NAME.test(toolName)) {
    throw new ScaffoldError(
      `${packageName} would declare the tool ${toolName}, which the loader refuses: ` +
        'a tool name starts with a letter and is at most 64 characters',
    );
  }
  return { packageName, pluginName, toolName };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A file's text, or undefined when it does not exist. */
function textOf(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

/** The project's `package.json`, refused unless it depends on the agent. */
function projectManifest(root: string): { manifest: Record<string, unknown>; text: string } {
  const notProject = (why: string) =>
    new ScaffoldError(`${root} is not a tenant project: ${why}. Run this from the project's root`);
  const text = textOf(join(root, 'package.json'));
  if (text === undefined) throw notProject('it has no package.json');
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw notProject('its package.json is not JSON');
  }
  if (!isObject(manifest)) throw notProject('its package.json is not an object');
  const depends = [manifest.dependencies, manifest.devDependencies].some(
    deps => isObject(deps) && 'manychat-ai-agent' in deps,
  );
  if (!depends) throw notProject('its package.json does not depend on manychat-ai-agent');
  const config = join(root, 'config');
  if (!existsSync(config) || !statSync(config).isDirectory()) throw notProject('it has no config/');
  return { manifest, text };
}

/**
 * The project's `pnpm-workspace.yaml` with `plugins/*` among its packages, or
 * undefined when it lists them already. Edited as text, so its comments and
 * every other setting survive.
 */
export function withWorkspaceGlob(text: string | undefined): string | undefined {
  if (text === undefined) return `packages:\n  - ${WORKSPACE_GLOB}\n`;
  const lines = text.split('\n');
  const item = /^\s*-\s*(['"]?)plugins\/\*\1\s*(?:#.*)?$/;
  if (lines.some(line => item.test(line))) return undefined;
  const header = lines.findIndex(line => /^packages:\s*(?:#.*)?$/.test(line));
  if (header === -1) {
    if (lines.some(line => line.startsWith('packages:'))) {
      throw new ScaffoldError(
        `${WORKSPACE_FILE}: packages is not a block list, so ${WORKSPACE_GLOB} cannot be added to it; ` +
          'write it as one, an entry per line',
      );
    }
    const base = text.length === 0 || text.endsWith('\n') ? text : `${text}\n`;
    return `${base}packages:\n  - ${WORKSPACE_GLOB}\n`;
  }
  const next = lines.slice(header + 1).find(line => line.trim() !== '' && !/^\s*#/.test(line));
  const indent = next?.match(/^(\s*)-\s/)?.[1] ?? '  ';
  lines.splice(header + 1, 0, `${indent}- ${WORKSPACE_GLOB}`);
  return lines.join('\n');
}

/** The project's `package.json` with the plugin as a workspace dependency, in its own indent. */
function withDependency(manifest: Record<string, unknown>, text: string, name: string): string {
  const indent = text.match(/^\{\r?\n([ \t]+)"/)?.[1] ?? '  ';
  const deps = isObject(manifest.dependencies) ? manifest.dependencies : {};
  const sorted = Object.fromEntries(
    Object.entries({ ...deps, [name]: 'workspace:*' }).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  return `${JSON.stringify({ ...manifest, dependencies: sorted }, null, indent)}\n`;
}

/** Where a listed package's source is: its installed copy, or its workspace directory. */
function sourceOf(root: string, name: string): string | undefined {
  const installed = packageDir(name, root);
  if (installed) return installed;
  const plugins = join(root, 'plugins');
  if (!existsSync(plugins)) return undefined;
  for (const dir of readdirSync(plugins)) {
    const manifest = join(plugins, dir, 'package.json');
    if (!existsSync(manifest)) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
      if (isObject(parsed) && parsed.name === name) return join(plugins, dir);
    } catch {
      // Not this package; `config check` reports a broken one.
    }
  }
  return undefined;
}

/**
 * The tool and plugin names the listed plugins already declare. One that does
 * not load is skipped: it is not this command's to refuse, and `config check`
 * reports it.
 */
async function declaredNames(root: string, listed: readonly string[]) {
  const tools = new Map<string, string>();
  const plugins = new Set<string>();
  for (const name of listed) {
    const dir = sourceOf(root, name);
    if (!dir) continue;
    let plugin: unknown;
    try {
      plugin = ((await import(pathToFileURL(entryOf(dir)).href)) as { default?: unknown }).default;
    } catch {
      continue;
    }
    if (!isObject(plugin)) continue;
    if (typeof plugin.name === 'string') plugins.add(plugin.name);
    if (!Array.isArray(plugin.tools)) continue;
    for (const tool of plugin.tools as unknown[]) {
      if (isObject(tool) && typeof tool.name === 'string') tools.set(tool.name, name);
    }
  }
  return { tools, plugins };
}

/** The template for `kind`, filled with the plugin's names and the installed agent's API version. */
export function renderTemplate(kind: PluginKind, names: PluginNames): string {
  // A read tool needs the newest API; a write tool loads under every
  // supported one, so under an agent one release older too.
  const apiVersion =
    kind === 'read' ? PLUGIN_API_VERSION : Math.min(...SUPPORTED_PLUGIN_API_VERSIONS);
  const source = readFileSync(join(TEMPLATES_DIR, TEMPLATE_FILES[kind]), 'utf8')
    .replaceAll('__PLUGIN_NAME__', names.pluginName)
    .replaceAll('__TOOL_NAME__', names.toolName)
    .replaceAll('__API_VERSION__', String(apiVersion));
  const left = source.match(/__[A-Z_]+__/);
  if (left) throw new ScaffoldError(`the ${kind} template leaves ${left[0]} unfilled`);
  return source;
}

function packageManifest(packageName: string): string {
  const manifest = {
    name: packageName,
    version: '0.1.0',
    private: true,
    type: 'module',
    exports: './index.js',
    peerDependencies: { 'manychat-ai-agent': '*' },
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * The project's files as they were, so a failure part-way puts them back
 * (specs/041 § It makes all four edits, or none).
 */
class Edits {
  private readonly changed: { path: string; before: string | undefined }[] = [];
  private created: string | undefined;
  private readonly write: (path: string, content: string) => void;

  constructor(write: (path: string, content: string) => void) {
    this.write = write;
  }

  mkdir(dir: string): void {
    this.created = mkdirSync(dir, { recursive: true });
  }

  file(path: string, content: string): void {
    // Recorded before the write, so a write that fails half-way is undone too.
    this.changed.push({ path, before: textOf(path) });
    this.write(path, content);
  }

  undo(): void {
    for (const { path, before } of this.changed.reverse()) {
      if (before === undefined) rmSync(path, { force: true });
      else writeFileSync(path, before);
    }
    if (this.created) rmSync(this.created, { recursive: true, force: true });
  }
}

export interface ScaffoldResult extends PluginNames {
  kind: PluginKind;
  /** The plugin's directory, relative to the project. */
  directory: string;
}

/**
 * Writes `plugins/<name>/` and makes the three edits that load it, or refuses
 * and leaves the project as it found it. Installs nothing. `write` is the
 * file write, replaceable so a test can fail one part-way.
 */
export async function scaffoldPlugin(options: {
  root: string;
  name: string;
  kind: PluginKind;
  write?: (path: string, content: string) => void;
}): Promise<ScaffoldResult> {
  const { root, kind } = options;
  const names = pluginNames(options.name);
  const { packageName, pluginName, toolName } = names;
  const { manifest, text: manifestText } = projectManifest(root);

  const directory = join('plugins', packageName);
  if (existsSync(join(root, directory))) throw new ScaffoldError(`${directory} already exists`);

  const configDir = join(root, 'config');
  let listed: string[];
  try {
    listed = listedPlugins(configDir);
  } catch (error) {
    if (error instanceof ConfigError) throw new ScaffoldError(`config/${error.message}`);
    throw error;
  }
  if (listed.includes(packageName)) {
    throw new ScaffoldError(`config/${PLUGINS_FILE} already lists ${packageName}`);
  }

  const declared = await declaredNames(root, listed);
  if (BUILT_IN_TOOLS.has(toolName)) {
    throw new ScaffoldError(`${toolName} is a built-in tool's name; choose another <name>`);
  }
  const owner = declared.tools.get(toolName);
  if (owner !== undefined) {
    throw new ScaffoldError(
      `${owner} already declares the tool ${toolName}; choose another <name>`,
    );
  }
  if (declared.plugins.has(pluginName)) {
    throw new ScaffoldError(
      `a listed plugin is already named ${pluginName}; choose another <name>`,
    );
  }

  // Everything is worked out before the first write, so a refusal writes nothing.
  const source = renderTemplate(kind, names);
  const workspacePath = join(root, WORKSPACE_FILE);
  const workspace = withWorkspaceGlob(textOf(workspacePath));
  const dependency = withDependency(manifest, manifestText, packageName);
  const pluginsFile = `${JSON.stringify({ plugins: [...listed, packageName] }, null, 2)}\n`;

  const edits = new Edits(options.write ?? ((path, content) => writeFileSync(path, content)));
  const pluginDir = join(root, directory);
  try {
    edits.mkdir(pluginDir);
    edits.file(join(pluginDir, 'package.json'), packageManifest(packageName));
    edits.file(join(pluginDir, 'index.js'), source);
    if (workspace !== undefined) edits.file(workspacePath, workspace);
    edits.file(join(root, 'package.json'), dependency);
    edits.file(join(configDir, PLUGINS_FILE), pluginsFile);
    await checkGenerated(packageName, join(pluginDir, 'index.js'), declared.tools);
  } catch (error) {
    edits.undo();
    throw error;
  }
  return { ...names, kind, directory };
}

/**
 * Runs the loader's startup checks on the generated plugin, from its path:
 * it is not in `node_modules` until `pnpm install` (specs/041 § It ends with
 * the check the server will run). A failure is the agent's own bug.
 */
async function checkGenerated(
  packageName: string,
  entry: string,
  taken: ReadonlyMap<string, string>,
): Promise<void> {
  try {
    const module = (await import(pathToFileURL(entry).href)) as { default?: unknown };
    checkPlugin(packageName, module.default, new Map(taken));
  } catch (error) {
    throw new ScaffoldError(
      `the generated plugin does not pass the agent's own checks, which is a bug in the agent: ` +
        (error as Error).message,
    );
  }
}
