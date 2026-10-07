import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { ConfigError } from '../config/loader.ts';
import { MAX_NOTE_LENGTH } from '../contracts/config.ts';
import { ToolName } from '../contracts/agent.ts';
import {
  MAX_QUERY_LENGTH,
  MAX_RESULT_ITEMS,
  MAX_RESULT_TEXT_LENGTH,
  SUPPORTED_PLUGIN_API_VERSIONS,
} from './api.ts';
import type {
  PluginParameter,
  PluginReadTool,
  PluginTool,
  ReadParameter,
  ResultField,
} from './api.ts';
import { Plugins, type LoadedTool } from './plugins.ts';

/** The optional tenant file that lists the plugin packages to load (specs/036). */
export const PLUGINS_FILE = 'plugins.json';

const PluginsFile = z.object({ plugins: z.array(z.string().min(1)) }).strict();

/** Names the model already knows: the six of specs/012 and the read of specs/024. */
const BUILT_IN = new Set<string>([...ToolName.options, 'get_contact']);

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const PLUGIN_KEYS = new Set(['name', 'apiVersion', 'tools']);
const TOOL_KEYS = new Set(['name', 'description', 'parameters', 'perform', 'read', 'result']);
const ENUM_KEYS = new Set(['type', 'values', 'description', 'optional']);
const NUMBER_KEYS = new Set(['type', 'integer', 'min', 'max', 'description', 'optional']);
const BOOLEAN_KEYS = new Set(['type', 'description', 'optional']);
const BOUNDED_KEYS = new Set(['type', 'maxLength', 'description', 'optional']);
const PARAMETER_KEYS: Record<PluginParameter['type'], ReadonlySet<string>> = {
  enum: ENUM_KEYS,
  number: NUMBER_KEYS,
  boolean: BOOLEAN_KEYS,
  note: BOUNDED_KEYS,
};
/** A read tool's parameters: a write's, less the note, plus one query (specs/039). */
const READ_PARAMETER_KEYS: Record<ReadParameter['type'], ReadonlySet<string>> = {
  enum: ENUM_KEYS,
  number: NUMBER_KEYS,
  boolean: BOOLEAN_KEYS,
  query: BOUNDED_KEYS,
};
const RESULT_KEYS: Record<ResultField['type'], ReadonlySet<string>> = {
  enum: ENUM_KEYS,
  number: NUMBER_KEYS,
  boolean: BOOLEAN_KEYS,
  text: BOUNDED_KEYS,
  list: new Set(['type', 'maxItems', 'maxLength', 'description', 'optional']),
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

/** A whole number from 1 to `max`, or a startup error naming the key. */
function checkBound(at: string, key: string, value: unknown, max: number, why: string): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    throw new PluginError(`${at}: ${key} must be a whole number from 1 to ${max} (${why})`);
  }
}

/** The checks every declaration shares: its keys, description, optional, and enum or number bounds. */
function checkDeclaration(
  at: string,
  declaration: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): void {
  const extra = unknownKeys(declaration, allowed);
  if (extra.length > 0) throw new PluginError(`${at}: unknown keys ${extra.join(', ')}`);
  if (declaration.description !== undefined && typeof declaration.description !== 'string') {
    throw new PluginError(`${at}: description must be a string`);
  }
  if (declaration.optional !== undefined && typeof declaration.optional !== 'boolean') {
    throw new PluginError(`${at}: optional must be a boolean`);
  }
  if (declaration.type === 'enum') {
    const values = declaration.values;
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      values.some(value => typeof value !== 'string' || value.length === 0) ||
      new Set(values).size !== values.length
    ) {
      throw new PluginError(`${at}: values must be distinct, non-empty strings`);
    }
  }
  if (declaration.type === 'number') {
    const { min, max, integer } = declaration;
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
}

/**
 * Checks one parameter of a write tool against what a built-in tool may take.
 * A string outside a note is refused, as `tools.json` refuses one (specs/012
 * § Free-text field values are refused).
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
  checkDeclaration(at, parameter, PARAMETER_KEYS[type as PluginParameter['type']]);
  if (type === 'note')
    checkBound(at, 'maxLength', parameter.maxLength, MAX_NOTE_LENGTH, 'ADR-0017');
}

/**
 * Checks one parameter of a read tool. Its one free text is a `query`; a note
 * is a write's field (specs/039 § Its query is the one free text, bounded and
 * cleaned).
 */
function checkReadParameter(where: string, key: string, parameter: unknown): void {
  const at = `${where}, parameter "${key}"`;
  if (!isObject(parameter)) throw new PluginError(`${at}: is not a parameter declaration`);
  const type = parameter.type;
  if (type === 'note') {
    throw new PluginError(
      `${at}: a read tool takes no note; its free text is a "query" (specs/039)`,
    );
  }
  if (type === 'string' || type === 'text') {
    throw new PluginError(
      `${at}: free text is refused; declare it as a "query" with a maxLength (specs/039)`,
    );
  }
  if (typeof type !== 'string' || !(type in READ_PARAMETER_KEYS)) {
    throw new PluginError(`${at}: type must be one of enum, number, boolean, query`);
  }
  checkDeclaration(at, parameter, READ_PARAMETER_KEYS[type as ReadParameter['type']]);
  if (type === 'query') {
    checkBound(at, 'maxLength', parameter.maxLength, MAX_QUERY_LENGTH, 'specs/039');
  }
}

/** Checks one field of a read tool's declared result (specs/039 § Its result is declared, validated and fenced). */
function checkResultField(where: string, key: string, field: unknown): void {
  const at = `${where}, result "${key}"`;
  if (!isObject(field)) throw new PluginError(`${at}: is not a result field declaration`);
  const type = field.type;
  if (typeof type !== 'string' || !(type in RESULT_KEYS)) {
    throw new PluginError(`${at}: type must be one of enum, number, boolean, text, list`);
  }
  checkDeclaration(at, field, RESULT_KEYS[type as ResultField['type']]);
  if (type === 'text' || type === 'list') {
    checkBound(at, 'maxLength', field.maxLength, MAX_RESULT_TEXT_LENGTH, 'specs/039');
  }
  if (type === 'list') checkBound(at, 'maxItems', field.maxItems, MAX_RESULT_ITEMS, 'specs/039');
}

type CheckedTool = PluginTool | PluginReadTool;

function checkTool(
  plugin: string,
  apiVersion: number,
  value: unknown,
  taken: Map<string, string>,
): CheckedTool {
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
  // A tool either writes or reads: one that did both would be performed
  // twice, once in the step and once after the reply (specs/039).
  const reads = 'read' in value;
  if (reads && 'perform' in value) {
    throw new PluginError(`${where}: declares both read and perform; a tool does one (specs/039)`);
  }
  if (!reads) {
    if ('result' in value) {
      throw new PluginError(`${where}: a result is declared only by a read tool (specs/039)`);
    }
    for (const [key, parameter] of Object.entries(value.parameters)) {
      checkParameter(where, key, parameter);
    }
    if (typeof value.perform !== 'function') {
      throw new PluginError(`${where}: perform must be a function, or read for a read tool`);
    }
    taken.set(name, plugin);
    return value as unknown as PluginTool;
  }
  if (apiVersion < 2) {
    throw new PluginError(`${where}: a read tool needs apiVersion 2 (specs/039)`);
  }
  if (typeof value.read !== 'function') throw new PluginError(`${where}: read must be a function`);
  const parameters = Object.entries(value.parameters);
  for (const [key, parameter] of parameters) checkReadParameter(where, key, parameter);
  const queries = parameters.filter(
    ([, parameter]) => isObject(parameter) && parameter.type === 'query',
  );
  if (queries.length > 1) {
    throw new PluginError(`${where}: declares ${queries.length} query parameters; at most one`);
  }
  if (!isObject(value.result) || Object.keys(value.result).length === 0) {
    throw new PluginError(`${where}: a read tool must declare its result (specs/039)`);
  }
  for (const [key, field] of Object.entries(value.result)) checkResultField(where, key, field);
  taken.set(name, plugin);
  return value as unknown as PluginReadTool;
}

/**
 * Checks a plugin's default export. Everything that would leave the prompt
 * promising an action nothing performs fails here, at startup (C6).
 */
function checkPlugin(spec: string, value: unknown, taken: Map<string, string>) {
  if (!isObject(value)) {
    throw new PluginError(`plugin ${spec}: its default export is not a plugin (use definePlugin)`);
  }
  if (typeof value.name !== 'string' || value.name.length === 0) {
    throw new PluginError(`plugin ${spec}: name must be a non-empty string`);
  }
  const name = value.name;
  const apiVersion = value.apiVersion;
  if (typeof apiVersion !== 'number' || !SUPPORTED_PLUGIN_API_VERSIONS.includes(apiVersion)) {
    throw new PluginError(
      `plugin ${name}: apiVersion ${JSON.stringify(apiVersion)} is not supported; ` +
        `this agent supports ${SUPPORTED_PLUGIN_API_VERSIONS.join(' and ')}`,
    );
  }
  // Refused rather than ignored: a channel that silently never mounts is a
  // contact nobody answers (specs/038).
  if ('channels' in value) {
    throw new PluginError(`plugin ${name}: channels are not supported yet (specs/038)`);
  }
  const extra = unknownKeys(value, PLUGIN_KEYS);
  if (extra.length > 0) throw new PluginError(`plugin ${name}: unknown keys ${extra.join(', ')}`);
  if (value.tools !== undefined && !Array.isArray(value.tools)) {
    throw new PluginError(`plugin ${name}: tools must be an array`);
  }
  const tools = ((value.tools as unknown[] | undefined) ?? []).map(tool =>
    checkTool(name, apiVersion, tool, taken),
  );
  return { name, tools };
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
  const names = new Set<string>();
  const loaded: LoadedTool[] = [];
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
    const plugin = checkPlugin(spec, module.default, taken);
    if (names.has(plugin.name)) {
      throw new PluginError(`plugin ${spec}: another plugin is already named ${plugin.name}`);
    }
    names.add(plugin.name);
    loaded.push(...plugin.tools.map(tool => ({ plugin: plugin.name, tool })));
  }
  return new Plugins(loaded, [...names]);
}
