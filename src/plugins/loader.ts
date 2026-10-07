import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { ConfigError } from '../config/loader.ts';
import { MAX_NOTE_LENGTH } from '../contracts/config.ts';
import { ToolName } from '../contracts/agent.ts';
import { CHANNEL_API_VERSION, PLUGIN_API_VERSION } from './api.ts';
import type { PluginChannel, PluginParameter, PluginTool } from './api.ts';
import { PluginChannelAdapter } from '../channels/plugin.ts';
import { Plugins, type LoadedTool } from './plugins.ts';

/** The optional tenant file that lists the plugin packages to load (specs/036). */
export const PLUGINS_FILE = 'plugins.json';

const PluginsFile = z.object({ plugins: z.array(z.string().min(1)) }).strict();

/** Names the model already knows: the six of specs/012 and the read of specs/024. */
const BUILT_IN = new Set<string>([...ToolName.options, 'get_contact']);

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const PLUGIN_KEYS = new Set(['name', 'apiVersion', 'tools', 'channelApiVersion', 'channels']);
const CHANNEL_KEYS = new Set([
  'name',
  'inbound',
  'maxMessages',
  'parse',
  'render',
  'push',
  'writeToken',
]);
/** The route's `<name>`: a path segment, and never ManyChat's own. */
const CHANNEL_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const RESERVED_CHANNELS = new Set(['manychat']);
const TOOL_KEYS = new Set(['name', 'description', 'parameters', 'perform']);
const PARAMETER_KEYS: Record<PluginParameter['type'], ReadonlySet<string>> = {
  enum: new Set(['type', 'values', 'description', 'optional']),
  number: new Set(['type', 'integer', 'min', 'max', 'description', 'optional']),
  boolean: new Set(['type', 'description', 'optional']),
  note: new Set(['type', 'maxLength', 'description', 'optional']),
};

/** A plugin that cannot be loaded. A `ConfigError`, so every command reports it as one. */
export class PluginError extends ConfigError {
  constructor(message: string) {
    super(message);
    this.name = 'PluginError';
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function unknownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): string[] {
  return Object.keys(value).filter(key => !allowed.has(key));
}

/** The directory of `name` in the first `node_modules` above `from`, as Node finds a package. */
function packageDir(name: string, from: string): string | undefined {
  let dir = resolve(from);
  for (;;) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** The ESM entry an `exports` value points the bare import at. */
function exported(target: unknown): string | undefined {
  if (typeof target === 'string') return target;
  if (Array.isArray(target)) {
    for (const option of target) {
      const found = exported(option);
      if (found) return found;
    }
    return undefined;
  }
  if (!isObject(target)) return undefined;
  if ('.' in target) return exported(target['.']);
  for (const condition of ['import', 'node', 'default']) {
    const found = exported(target[condition]);
    if (found) return found;
  }
  return undefined;
}

function entryOf(dir: string): string {
  const manifest: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const pkg = isObject(manifest) ? manifest : {};
  const target =
    exported(pkg.exports) ?? (typeof pkg.main === 'string' ? pkg.main : undefined) ?? 'index.js';
  return join(dir, target);
}

/**
 * Checks one parameter against what a built-in tool may take. A string outside
 * a note is refused, as `tools.json` refuses one (specs/012 § Free-text field
 * values are refused).
 */
function checkParameter(where: string, key: string, parameter: unknown): void {
  const at = `${where}, parameter "${key}"`;
  if (!isObject(parameter)) throw new PluginError(`${at}: is not a parameter declaration`);
  const type = parameter.type;
  if (type === 'string' || type === 'text') {
    throw new PluginError(
      `${at}: free text is refused; declare it as a "note" with a maxLength (specs/012)`,
    );
  }
  if (typeof type !== 'string' || !(type in PARAMETER_KEYS)) {
    throw new PluginError(`${at}: type must be one of enum, number, boolean, note`);
  }
  const extra = unknownKeys(parameter, PARAMETER_KEYS[type as PluginParameter['type']]);
  if (extra.length > 0) throw new PluginError(`${at}: unknown keys ${extra.join(', ')}`);
  if (parameter.description !== undefined && typeof parameter.description !== 'string') {
    throw new PluginError(`${at}: description must be a string`);
  }
  if (parameter.optional !== undefined && typeof parameter.optional !== 'boolean') {
    throw new PluginError(`${at}: optional must be a boolean`);
  }
  if (type === 'enum') {
    const values = parameter.values;
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      values.some(value => typeof value !== 'string' || value.length === 0) ||
      new Set(values).size !== values.length
    ) {
      throw new PluginError(`${at}: values must be distinct, non-empty strings`);
    }
  }
  if (type === 'number') {
    const { min, max, integer } = parameter;
    for (const [name, bound] of [
      ['min', min],
      ['max', max],
    ] as const) {
      if (bound !== undefined && (typeof bound !== 'number' || !Number.isFinite(bound))) {
        throw new PluginError(`${at}: ${name} must be a finite number`);
      }
    }
    if (typeof min === 'number' && typeof max === 'number' && min > max) {
      throw new PluginError(`${at}: min is greater than max`);
    }
    if (integer !== undefined && typeof integer !== 'boolean') {
      throw new PluginError(`${at}: integer must be a boolean`);
    }
  }
  if (type === 'note') {
    const { maxLength } = parameter;
    if (
      typeof maxLength !== 'number' ||
      !Number.isInteger(maxLength) ||
      maxLength < 1 ||
      maxLength > MAX_NOTE_LENGTH
    ) {
      throw new PluginError(
        `${at}: maxLength must be a whole number from 1 to ${MAX_NOTE_LENGTH} (ADR-0017)`,
      );
    }
  }
}

function checkTool(plugin: string, value: unknown, taken: Map<string, string>): PluginTool {
  if (!isObject(value)) throw new PluginError(`plugin ${plugin}: a tool is not an object`);
  const name = value.name;
  if (typeof name !== 'string' || !TOOL_NAME.test(name)) {
    throw new PluginError(
      `plugin ${plugin}: tool name ${JSON.stringify(name)} must be lowercase snake case`,
    );
  }
  const where = `plugin ${plugin}, tool ${name}`;
  if (BUILT_IN.has(name)) throw new PluginError(`${where}: takes the name of a built-in tool`);
  const owner = taken.get(name);
  if (owner !== undefined) throw new PluginError(`${where}: plugin ${owner} already defines it`);
  const extra = unknownKeys(value, TOOL_KEYS);
  if (extra.length > 0) throw new PluginError(`${where}: unknown keys ${extra.join(', ')}`);
  if (typeof value.description !== 'string' || value.description.trim().length === 0) {
    throw new PluginError(`${where}: description must be a non-empty string`);
  }
  if (!isObject(value.parameters)) throw new PluginError(`${where}: parameters must be an object`);
  for (const [key, parameter] of Object.entries(value.parameters)) {
    checkParameter(where, key, parameter);
  }
  if (typeof value.perform !== 'function') {
    throw new PluginError(`${where}: perform must be a function`);
  }
  taken.set(name, plugin);
  return value as unknown as PluginTool;
}

function checkChannel(plugin: string, value: unknown, taken: Map<string, string>): PluginChannel {
  if (!isObject(value)) throw new PluginError(`plugin ${plugin}: a channel is not an object`);
  const name = value.name;
  if (typeof name !== 'string' || !CHANNEL_NAME.test(name)) {
    throw new PluginError(
      `plugin ${plugin}: channel name ${JSON.stringify(name)} must be lowercase letters, digits and hyphens`,
    );
  }
  const where = `plugin ${plugin}, channel ${name}`;
  if (RESERVED_CHANNELS.has(name)) throw new PluginError(`${where}: the name is the agent's own`);
  const owner = taken.get(name);
  if (owner !== undefined) throw new PluginError(`${where}: plugin ${owner} already defines it`);
  const extra = unknownKeys(value, CHANNEL_KEYS);
  if (extra.length > 0) throw new PluginError(`${where}: unknown keys ${extra.join(', ')}`);
  // A request no schema checks is read unchecked (C3).
  if (!isObject(value.inbound) || typeof value.inbound.safeParse !== 'function') {
    throw new PluginError(
      `${where}: inbound must be a schema with safeParse, such as a Zod object`,
    );
  }
  const { maxMessages } = value;
  if (typeof maxMessages !== 'number' || !Number.isInteger(maxMessages) || maxMessages < 1) {
    throw new PluginError(`${where}: maxMessages must be a whole number of at least 1`);
  }
  for (const method of ['parse', 'render', 'push'] as const) {
    if (typeof value[method] !== 'function') {
      throw new PluginError(`${where}: ${method} must be a function`);
    }
  }
  if (value.writeToken !== undefined && typeof value.writeToken !== 'function') {
    throw new PluginError(`${where}: writeToken must be a function when present`);
  }
  taken.set(name, plugin);
  return value as unknown as PluginChannel;
}

/**
 * Checks a plugin's default export. Everything that would leave the prompt
 * promising an action nothing performs fails here, at startup (C6).
 */
function checkPlugin(
  spec: string,
  value: unknown,
  taken: Map<string, string>,
  channelsTaken: Map<string, string>,
) {
  if (!isObject(value)) {
    throw new PluginError(`plugin ${spec}: its default export is not a plugin (use definePlugin)`);
  }
  if (typeof value.name !== 'string' || value.name.length === 0) {
    throw new PluginError(`plugin ${spec}: name must be a non-empty string`);
  }
  const name = value.name;
  if (value.apiVersion !== PLUGIN_API_VERSION) {
    throw new PluginError(
      `plugin ${name}: apiVersion ${JSON.stringify(value.apiVersion)} is not supported; ` +
        `this agent supports ${PLUGIN_API_VERSION}`,
    );
  }
  const extra = unknownKeys(value, PLUGIN_KEYS);
  if (extra.length > 0) throw new PluginError(`plugin ${name}: unknown keys ${extra.join(', ')}`);
  if (value.tools !== undefined && !Array.isArray(value.tools)) {
    throw new PluginError(`plugin ${name}: tools must be an array`);
  }
  const tools = ((value.tools as unknown[] | undefined) ?? []).map(tool =>
    checkTool(name, tool, taken),
  );
  return { name, tools, channels: checkChannels(name, value, channelsTaken) };
}

/**
 * The channel half has a version of its own, provisional while it is `0`
 * (specs/038). It is required exactly when the plugin has channels: a channel
 * written against another version, or a version naming no channel, is refused
 * rather than guessed at.
 */
function checkChannels(
  name: string,
  value: Record<string, unknown>,
  taken: Map<string, string>,
): PluginChannel[] {
  const hasChannels = value.channels !== undefined;
  if (!hasChannels) {
    if (value.channelApiVersion !== undefined) {
      throw new PluginError(`plugin ${name}: channelApiVersion is set but it has no channels`);
    }
    return [];
  }
  if (value.channelApiVersion !== CHANNEL_API_VERSION) {
    throw new PluginError(
      `plugin ${name}: channelApiVersion ${JSON.stringify(value.channelApiVersion)} is not supported; ` +
        `this agent supports ${CHANNEL_API_VERSION}, which is provisional (specs/038)`,
    );
  }
  if (!Array.isArray(value.channels)) {
    throw new PluginError(`plugin ${name}: channels must be an array`);
  }
  return (value.channels as unknown[]).map(channel => checkChannel(name, channel, taken));
}

/** The packages `plugins.json` lists, or none when the file is absent. */
export function listedPlugins(configDir: string): string[] {
  const path = join(configDir, PLUGINS_FILE);
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new PluginError(`${PLUGINS_FILE}: ${(error as Error).message}`);
  }
  const parsed = PluginsFile.safeParse(raw);
  if (!parsed.success) {
    throw new PluginError(`${PLUGINS_FILE}: ${z.prettifyError(parsed.error)}`);
  }
  const packages = parsed.data.plugins;
  const repeated = packages.find((name, index) => packages.indexOf(name) !== index);
  if (repeated !== undefined) {
    throw new PluginError(`${PLUGINS_FILE}: ${repeated} is listed twice`);
  }
  return packages;
}

/**
 * Loads the plugins `config/plugins.json` lists, once, at boot (specs/036).
 * Each is resolved from the tenant project's `node_modules`: by default the
 * directory that holds `configDir`. Any that does not load is a startup error.
 *
 * `SIGHUP` does not come here: it reloads configuration, not code.
 */
export async function loadPlugins(
  configDir: string,
  options: { from?: string } = {},
): Promise<Plugins> {
  const packages = listedPlugins(configDir);
  if (packages.length === 0) return Plugins.NONE;
  const from = options.from ?? dirname(resolve(configDir));
  const taken = new Map<string, string>();
  const channelsTaken = new Map<string, string>();
  const names = new Set<string>();
  const loaded: LoadedTool[] = [];
  const channels: PluginChannelAdapter[] = [];
  for (const spec of packages) {
    if (spec.startsWith('.') || spec.startsWith('/') || spec.includes('\\')) {
      throw new PluginError(`plugin ${spec}: list a package name, not a path`);
    }
    const dir = packageDir(spec, from);
    if (!dir) {
      throw new PluginError(
        `plugin ${spec} is not installed (no node_modules/${spec} from ${from})`,
      );
    }
    let module: { default?: unknown };
    try {
      module = (await import(pathToFileURL(entryOf(dir)).href)) as { default?: unknown };
    } catch (error) {
      throw new PluginError(`plugin ${spec} failed to load: ${(error as Error).message}`);
    }
    const plugin = checkPlugin(spec, module.default, taken, channelsTaken);
    if (names.has(plugin.name)) {
      throw new PluginError(`plugin ${spec}: another plugin is already named ${plugin.name}`);
    }
    names.add(plugin.name);
    loaded.push(...plugin.tools.map(tool => ({ plugin: plugin.name, tool })));
    channels.push(
      ...plugin.channels.map(channel => new PluginChannelAdapter(plugin.name, channel)),
    );
  }
  return new Plugins(loaded, [...names], channels);
}
