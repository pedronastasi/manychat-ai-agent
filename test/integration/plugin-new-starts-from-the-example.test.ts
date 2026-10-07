import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ToolSet } from 'ai';
import { EXAMPLE_PLUGIN, pluginSource, scaffoldProject } from '../helpers/plugins.ts';
import { run } from '../../src/cli/run.ts';
import { ActionStage } from '../../src/agent/tools.ts';
import { UNAVAILABLE } from '../../src/agent/contact.ts';
import { PLUGIN_API_VERSION, SUPPORTED_PLUGIN_API_VERSIONS } from '../../src/plugins/api.ts';
import { loadPlugins } from '../../src/plugins/loader.ts';
import { PluginReads } from '../../src/plugins/reads.ts';
import type { HostLogger } from '../../src/plugins/plugins.ts';
import {
  ScaffoldError,
  TEMPLATES_DIR,
  TEMPLATE_FILES,
  pluginNames,
  scaffoldPlugin,
  withWorkspaceGlob,
} from '../../src/plugins/scaffold.ts';
import type { PerformableAction } from '../../src/contracts/agent.ts';

/**
 * specs/041-plugin-new-starts-from-the-example.md § Verification: `agent
 * plugin new` run in a stand-in tenant project, its output loaded with this
 * commit's loader. The backend the templates call does not exist, so `fetch`
 * stands in for it.
 */

const quiet: HostLogger = { info: () => {}, warn: () => {}, error: () => {} };
/** Calls a tool as the model would, through the AI SDK's `execute`. */
const call = (tools: ToolSet, name: string, input: Record<string, unknown>): Promise<unknown> =>
  Promise.resolve(
    tools[name]!.execute!(input as never, { toolCallId: 'call-1', messages: [], context: {} }),
  );

let project: ReturnType<typeof scaffoldProject>;
afterEach(() => {
  project?.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Links a workspace plugin into `node_modules`, as `pnpm install` would. */
function install(root: string, packageName: string) {
  symlinkSync(join(root, 'plugins', packageName), join(root, 'node_modules', packageName), 'dir');
}

/** Every file under `root`, path to bytes: the project as the command found it. */
function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else files[relative(root, path)] = readFileSync(path).toString('base64');
    }
  };
  walk(root);
  return files;
}

const json = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

describe('the generated plugins load, and their tools work (specs/041 V1)', () => {
  beforeEach(async () => {
    project = scaffoldProject();
    await scaffoldPlugin({ root: project.root, name: 'class-dates', kind: 'read' });
    await scaffoldPlugin({ root: project.root, name: 'call-backs', kind: 'write' });
    install(project.root, 'agent-plugin-class-dates');
    install(project.root, 'agent-plugin-call-backs');
  });

  it('loads both with the loader the server runs, each tool as its kind', async () => {
    const plugins = await loadPlugins(project.configDir);
    expect(plugins.summary()).toEqual([
      { plugin: 'class-dates', writes: [], reads: ['class_dates'] },
      { plugin: 'call-backs', writes: ['call_backs'], reads: [] },
    ]);
  });

  it('declares the installed agent’s API versions: the newest to read, the lowest to write', async () => {
    const versionOf = async (name: string) =>
      (
        (await import(pathToFileURL(join(project.root, 'plugins', name, 'index.js')).href)) as {
          default: { apiVersion: number };
        }
      ).default.apiVersion;
    expect(await versionOf('agent-plugin-class-dates')).toBe(PLUGIN_API_VERSION);
    expect(await versionOf('agent-plugin-call-backs')).toBe(
      Math.min(...SUPPORTED_PLUGIN_API_VERSIONS),
    );
  });

  it('offers the read tool, and returns a result that validates', async () => {
    const backend = vi.fn((_url: URL) =>
      Promise.resolve(
        Response.json({
          seatsLeft: 3,
          nextStart: 'next_month',
          waitlist: false,
          summary: 'An invented intake on weekday evenings.',
        }),
      ),
    );
    vi.stubGlobal('fetch', backend);
    const tools: ToolSet = {};
    (await loadPlugins(project.configDir)).addReadTools(
      tools,
      new PluginReads({ subscriberId: 's1', logger: quiet }),
    );
    const result: unknown = await call(tools, 'class_dates', { course: 'foundation' });
    expect(result).toMatchObject({
      fields: { seatsLeft: 3, nextStart: 'next_month', waitlist: false },
    });
    expect(String(backend.mock.calls[0]![0])).toContain('course=foundation');
  });

  it('answers unavailable while the invented backend is still in place (C6)', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('getaddrinfo ENOTFOUND')));
    const tools: ToolSet = {};
    (await loadPlugins(project.configDir)).addReadTools(
      tools,
      new PluginReads({ subscriberId: 's1', logger: quiet }),
    );
    expect(await call(tools, 'class_dates', { course: 'foundation' })).toEqual(UNAVAILABLE);
  });

  it('stages the write tool, and performs it after the reply with the turn’s subscriber', async () => {
    const backend = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    vi.stubGlobal('fetch', backend);
    const plugins = await loadPlugins(project.configDir);
    const tools: ToolSet = {};
    const stage = new ActionStage();
    plugins.addTools(
      tools,
      stage,
      () => false,
      description => description,
    );
    const params = { course: 'advanced', urgent: true };
    expect(await call(tools, 'call_backs', params)).toEqual({ staged: true });
    expect(backend).not.toHaveBeenCalled();
    expect(stage.staged).toEqual([
      { tool: 'plugin', id: 'call_backs', plugin: 'call-backs', params },
    ]);

    const inner = { performAction: () => Promise.resolve() };
    await plugins.performer(inner, quiet).performAction('s1', stage.staged[0] as PerformableAction);
    expect(JSON.parse(backend.mock.calls[0]![1].body as string)).toEqual({
      subscriberId: 's1',
      ...params,
    });
  });
});

describe('it makes the four edits (specs/041 V2)', () => {
  it('writes the package and creates pnpm-workspace.yaml and plugins.json when absent', async () => {
    project = scaffoldProject();
    await scaffoldPlugin({ root: project.root, name: 'class-dates', kind: 'read' });
    const dir = join(project.root, 'plugins', 'agent-plugin-class-dates');
    expect(readdirSync(dir).sort()).toEqual(['index.js', 'package.json']);
    expect(json(join(dir, 'package.json'))).toMatchObject({
      name: 'agent-plugin-class-dates',
      type: 'module',
      exports: './index.js',
      peerDependencies: { 'manychat-ai-agent': '*' },
    });
    expect(readFileSync(join(project.root, 'pnpm-workspace.yaml'), 'utf8')).toBe(
      'packages:\n  - plugins/*\n',
    );
    expect(json(join(project.root, 'package.json'))).toMatchObject({
      dependencies: {
        'agent-plugin-class-dates': 'workspace:*',
        'manychat-ai-agent': '^0.19.0',
      },
    });
    expect(json(join(project.configDir, 'plugins.json'))).toEqual({
      plugins: ['agent-plugin-class-dates'],
    });
  });

  it('adds to an existing workspace and plugins.json, keeping what they hold', async () => {
    project = scaffoldProject([EXAMPLE_PLUGIN], { [EXAMPLE_PLUGIN]: EXAMPLE_PLUGIN });
    const workspace =
      '# invented settings\npackages:\n  - tools/*\nonlyBuiltDependencies:\n  - esbuild\n';
    writeFileSync(join(project.root, 'pnpm-workspace.yaml'), workspace);
    await scaffoldPlugin({ root: project.root, name: 'class-dates', kind: 'read' });
    await scaffoldPlugin({ root: project.root, name: 'call-backs', kind: 'write' });
    expect(readFileSync(join(project.root, 'pnpm-workspace.yaml'), 'utf8')).toBe(
      '# invented settings\npackages:\n  - plugins/*\n  - tools/*\nonlyBuiltDependencies:\n  - esbuild\n',
    );
    expect(json(join(project.configDir, 'plugins.json'))).toEqual({
      plugins: [EXAMPLE_PLUGIN, 'agent-plugin-class-dates', 'agent-plugin-call-backs'],
    });
  });

  it('adds the glob to a workspace file that lists no packages, in its own indent', () => {
    expect(withWorkspaceGlob('onlyBuiltDependencies:\n  - esbuild')).toBe(
      'onlyBuiltDependencies:\n  - esbuild\npackages:\n  - plugins/*\n',
    );
    expect(withWorkspaceGlob('packages:\n- tools/*\n')).toBe('packages:\n- plugins/*\n- tools/*\n');
    expect(withWorkspaceGlob("packages:\n  - 'plugins/*'\n")).toBeUndefined();
  });
});

describe('a refused or failed run leaves the project byte for byte (specs/041 V3)', () => {
  const refusals: [string, (root: string) => void, string, RegExp][] = [
    [
      'no package.json',
      root => rmSync(join(root, 'package.json')),
      'class-dates',
      /no package\.json/,
    ],
    [
      'a package.json that does not depend on the agent',
      root => writeFileSync(join(root, 'package.json'), '{ "name": "invented" }\n'),
      'class-dates',
      /does not depend on manychat-ai-agent/,
    ],
    [
      'no config/',
      root => rmSync(join(root, 'config'), { recursive: true }),
      'class-dates',
      /no config\//,
    ],
    [
      'the plugin directory exists',
      root => mkdirSync(join(root, 'plugins', 'agent-plugin-class-dates'), { recursive: true }),
      'class-dates',
      /already exists/,
    ],
    [
      'plugins.json already lists the name',
      root =>
        writeFileSync(
          join(root, 'config', 'plugins.json'),
          '{ "plugins": ["agent-plugin-class-dates"] }\n',
        ),
      'class-dates',
      /already lists agent-plugin-class-dates/,
    ],
    [
      'plugins.json is malformed',
      root => writeFileSync(join(root, 'config', 'plugins.json'), '{ "plugins": '),
      'class-dates',
      /config\/plugins\.json/,
    ],
    ['the tool name is a built-in tool’s', () => {}, 'add-tag', /built-in tool/],
    [
      'a listed plugin already declares the tool',
      root =>
        writeFileSync(
          join(root, 'config', 'plugins.json'),
          JSON.stringify({ plugins: [EXAMPLE_PLUGIN] }),
        ),
      'crm-log-lead',
      /agent-plugin-example-crm already declares the tool crm_log_lead/,
    ],
    [
      'a listed plugin already has the name',
      root => {
        // A package of another name whose plugin is named as this one would be.
        const dir = join(root, 'node_modules', 'invented-dates');
        mkdirSync(dir);
        writeFileSync(
          join(dir, 'package.json'),
          JSON.stringify({ name: 'invented-dates', type: 'module' }),
        );
        writeFileSync(join(dir, 'index.js'), pluginSource({ name: 'class-dates' }));
        writeFileSync(
          join(root, 'config', 'plugins.json'),
          JSON.stringify({ plugins: ['invented-dates'] }),
        );
      },
      'class-dates',
      /already named class-dates/,
    ],
    [
      'the workspace packages are not a block list',
      root => writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages: ['tools/*']\n"),
      'class-dates',
      /not a block list/,
    ],
    ['the derived tool name starts with a digit', () => {}, '2-day', /loader refuses/],
  ];

  it.each(refusals)('refuses when %s', async (_case, arrange, name, reason) => {
    project = scaffoldProject(undefined, { [EXAMPLE_PLUGIN]: EXAMPLE_PLUGIN });
    arrange(project.root);
    const before = snapshot(project.root);
    await expect(scaffoldPlugin({ root: project.root, name, kind: 'read' })).rejects.toThrow(
      reason,
    );
    expect(snapshot(project.root)).toEqual(before);
  });

  it.each([2, 3, 4, 5])('undoes every edit when write %i fails', async failing => {
    project = scaffoldProject([EXAMPLE_PLUGIN], { [EXAMPLE_PLUGIN]: EXAMPLE_PLUGIN });
    writeFileSync(join(project.root, 'pnpm-workspace.yaml'), 'packages:\n  - tools/*\n');
    const before = snapshot(project.root);
    let writes = 0;
    const write = (path: string, content: string) => {
      if (++writes === failing) throw new Error('invented disk failure');
      writeFileSync(path, content);
    };
    await expect(
      scaffoldPlugin({ root: project.root, name: 'class-dates', kind: 'write', write }),
    ).rejects.toThrow('invented disk failure');
    expect(snapshot(project.root)).toEqual(before);
    expect(existsSync(join(project.root, 'plugins'))).toBe(false);
  });

  it('exits 1 naming the reason, from the CLI', async () => {
    project = scaffoldProject();
    rmSync(join(project.root, 'config'), { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(project.root);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await run(['node', 'agent', 'plugin', 'new', 'class-dates', '--read'])).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/^plugin new: .*no config\//));
  });
});

describe('the command line, and the names it derives (specs/041 V4)', () => {
  it.each([
    ['neither flag', ['class-dates']],
    ['both flags', ['class-dates', '--read', '--write']],
    ['no name', ['--read']],
    ['an unknown flag', ['class-dates', '--read', '--force']],
  ])('prints its usage and exits 2 with %s', async (_case, args) => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await run(['node', 'agent', 'plugin', 'new', ...args])).toBe(2);
    expect(stderr).toHaveBeenCalledWith('Usage: agent plugin new <name> --read|--write');
  });

  it('prefixes the package name once, and derives the tool name in snake case', () => {
    const expected = {
      packageName: 'agent-plugin-class-dates',
      pluginName: 'class-dates',
      toolName: 'class_dates',
    };
    expect(pluginNames('class-dates')).toEqual(expected);
    expect(pluginNames('agent-plugin-class-dates')).toEqual(expected);
  });

  it('refuses a name whose tool name starts with a digit or runs past 64 characters', () => {
    expect(() => pluginNames('2-day')).toThrow(ScaffoldError);
    expect(() => pluginNames('x'.repeat(65))).toThrow(/at most 64 characters/);
    expect(pluginNames('x'.repeat(64)).toolName).toHaveLength(64);
  });

  it.each(['Class-Dates', '@invented/dates', 'class_dates', 'agent-plugin-', 'class--dates'])(
    'refuses %s, which is no package name in kebab case',
    name => {
      expect(() => pluginNames(name)).toThrow(/lowercase kebab case/);
    },
  );

  it('ends by printing pnpm install, then the config check, without needing the environment', async () => {
    project = scaffoldProject();
    vi.stubEnv('MANYCHAT_SHARED_SECRET', undefined);
    vi.spyOn(process, 'cwd').mockReturnValue(project.root);
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await run(['node', 'agent', 'plugin', 'new', 'class-dates', '--write'])).toBe(0);
    const printed = stdout.mock.calls.map(call => String(call[0])).join('\n');
    expect(printed).toContain('write tool class_dates');
    expect(printed.indexOf('pnpm install')).toBeGreaterThan(-1);
    expect(printed.indexOf('pnpm agent config check')).toBeGreaterThan(
      printed.indexOf('pnpm install'),
    );
    // It never installs: nothing new in node_modules, and no lockfile.
    expect(existsSync(join(project.root, 'node_modules', 'agent-plugin-class-dates'))).toBe(false);
    expect(existsSync(join(project.root, 'pnpm-lock.yaml'))).toBe(false);
    vi.unstubAllEnvs();
  });
});

describe('the published package ships the templates (specs/041 V5)', () => {
  it('packs every template the command reads', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-pack-templates-'));
    try {
      writeFileSync(join(root, 'package.json'), readFileSync('package.json'));
      cpSync(TEMPLATES_DIR, join(root, 'src', 'plugins', 'templates'), { recursive: true });
      const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const packed = (JSON.parse(raw) as { files: { path: string }[] }[])[0]!.files.map(
        file => file.path,
      );
      for (const file of Object.values(TEMPLATE_FILES)) {
        expect(packed).toContain(`src/plugins/templates/${file}`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
