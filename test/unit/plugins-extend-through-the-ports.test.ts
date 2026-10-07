import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ToolExecutionOptions, ToolSet } from 'ai';
import { definePlugin, defineTool, PLUGIN_API_VERSION } from '../../src/index.ts';
import { loadPlugins, PluginError } from '../../src/plugins/loader.ts';
import { Plugins, PLUGIN_PERFORM_TIMEOUT_MS } from '../../src/plugins/plugins.ts';
import type { HostLogger } from '../../src/plugins/plugins.ts';
import type { PluginTool } from '../../src/plugins/api.ts';
import { ActionStage, buildTools, MAX_ACTIONS_PER_TURN } from '../../src/agent/tools.ts';
import { buildSystemPrompt } from '../../src/agent/prompt.ts';
import { performActions } from '../../src/conversation/actions.ts';
import { loadTenantConfig } from '../../src/config/loader.ts';
import { NO_TOOLS } from '../../src/contracts/config.ts';
import type { StagedAction } from '../../src/contracts/agent.ts';
import { run } from '../../src/cli/run.ts';
import { FakeActions } from '../helpers/manychat.ts';
import { EXAMPLE_PLUGIN, pluginSource, tenantProject } from '../helpers/plugins.ts';

/**
 * specs/036-plugins-extend-through-the-ports.md § Verification. The plugin
 * under test/fixtures/plugins is invented, as is every value here (C1).
 */

const tenant = loadTenantConfig('test/fixtures/config');

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const remove of cleanup) remove();
  cleanup = [];
  vi.useRealTimers();
});

function project(...args: Parameters<typeof tenantProject>) {
  const made = tenantProject(...args);
  cleanup.push(made.remove);
  return made;
}

function hostLogger() {
  const lines: { level: string; fields: Record<string, unknown>; message: string }[] = [];
  const at = (level: string) => (fields: object, message: string) => {
    lines.push({ level, fields: fields as Record<string, unknown>, message });
  };
  const logger: HostLogger = { info: at('info'), warn: at('warn'), error: at('error') };
  return { logger, lines };
}

/** One tool, kept in memory: what it was given, and how it ends. */
function recordingTool(over: Partial<PluginTool> & { ends?: 'ok' | 'throws' | 'hangs' } = {}): {
  tool: PluginTool;
  calls: Parameters<PluginTool['perform']>[0][];
} {
  const calls: Parameters<PluginTool['perform']>[0][] = [];
  const tool: PluginTool = {
    name: 'crm_log_lead',
    description: 'Log an invented lead.',
    parameters: {
      temperature: { type: 'enum', values: ['warm', 'hot'] },
      summary: { type: 'note', maxLength: 60, optional: true },
    },
    perform: call => {
      calls.push(call);
      if (over.ends === 'throws') {
        throw new Error(`CRM refused ${call.subscriberId}: ${String(call.params.summary)}`);
      }
      if (over.ends === 'hangs') return new Promise<void>(() => {});
    },
    ...over,
  };
  return { tool, calls };
}

const plugins = (tool: PluginTool) =>
  new Plugins([{ plugin: 'example-crm', tool }], ['example-crm']);

/** Runs a tool's `execute` as the SDK does after validating the input against its schema. */
async function call(tools: ToolSet, name: string, input: unknown): Promise<unknown> {
  const declared = tools[name]!;
  const parsed = (declared.inputSchema as { parse: (value: unknown) => unknown }).parse(input);
  return declared.execute!(
    parsed as never,
    {
      toolCallId: 'call-1',
      messages: [],
    } as unknown as ToolExecutionOptions<never>,
  );
}

/* -------------------------------------------------------------------------- */
/* The bare entry point                                                        */
/* -------------------------------------------------------------------------- */

describe('the bare entry point exports definePlugin (specs/036 V1)', () => {
  it('exports definePlugin, defineTool and the API version, each returning what it is given', () => {
    const tool = defineTool({
      name: 'invented_tool',
      description: 'An invented tool.',
      parameters: { level: { type: 'enum', values: ['low', 'high'] } },
      perform: () => {},
    });
    const plugin = { name: 'invented', apiVersion: PLUGIN_API_VERSION, tools: [tool] };
    expect(definePlugin(plugin)).toBe(plugin);
    expect(defineTool(tool)).toBe(tool);
    // Amended by specs/039: apiVersion 2 adds read tools, and 1 still loads.
    expect(PLUGIN_API_VERSION).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* Loading                                                                     */
/* -------------------------------------------------------------------------- */

describe('plugins are listed in config/plugins.json and loaded at boot (specs/036 V2)', () => {
  it('loads none when the tenant has no plugins.json', async () => {
    const { configDir } = project(undefined);
    const loaded = await loadPlugins(configDir);
    expect(loaded.hasTools).toBe(false);
    expect(loaded.names).toEqual([]);
  });

  it("resolves a listed package from the tenant project's node_modules", async () => {
    const { configDir } = project([EXAMPLE_PLUGIN], { [EXAMPLE_PLUGIN]: EXAMPLE_PLUGIN });
    const loaded = await loadPlugins(configDir);
    expect(loaded.names).toEqual(['example-crm']);
    expect(loaded.hasTools).toBe(true);
  });

  it('loads a plugin copied into the image, where the agent links itself into node_modules', async () => {
    // The image's layout: the agent at its root, config/ mounted beside
    // node_modules, and the link the Dockerfile makes so a plugin's bare
    // import finds the agent.
    expect(readFileSync('Dockerfile', 'utf8')).toMatch(
      /^RUN ln -s \/app \/app\/node_modules\/manychat-ai-agent$/m,
    );
    const app = mkdtempSync(join(tmpdir(), 'agent-image-'));
    cleanup.push(() => rmSync(app, { recursive: true, force: true }));
    writeFileSync(
      join(app, 'package.json'),
      JSON.stringify({
        name: 'manychat-ai-agent',
        type: 'module',
        exports: { '.': './dist/index.js' },
      }),
    );
    mkdirSync(join(app, 'dist'));
    writeFileSync(
      join(app, 'dist', 'index.js'),
      `export * from ${JSON.stringify(pathToFileURL(resolve('src/index.ts')).href)};\n`,
    );
    mkdirSync(join(app, 'config'));
    writeFileSync(
      join(app, 'config', 'plugins.json'),
      JSON.stringify({ plugins: [EXAMPLE_PLUGIN] }),
    );
    mkdirSync(join(app, 'node_modules'));
    cpSync(
      join('test/fixtures/plugins', EXAMPLE_PLUGIN),
      join(app, 'node_modules', EXAMPLE_PLUGIN),
      {
        recursive: true,
      },
    );
    symlinkSync(app, join(app, 'node_modules', 'manychat-ai-agent'));

    const loaded = await loadPlugins(join(app, 'config'));
    expect(loaded.names).toEqual(['example-crm']);
  });
});

describe('a plugin that does not load stops the server (specs/036 V3)', () => {
  const refused = async (configDir: string, message: RegExp) => {
    const error = await loadPlugins(configDir).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PluginError);
    expect((error as Error).message).toMatch(message);
  };

  it('a missing package', async () => {
    const { configDir } = project([EXAMPLE_PLUGIN]);
    await refused(configDir, /agent-plugin-example-crm is not installed/);
  });

  it('an apiVersion the installed agent does not support', async () => {
    const { configDir } = project(['invented'], { invented: pluginSource({ apiVersion: 3 }) });
    await refused(configDir, /apiVersion 3 is not supported; this agent supports 1 and 2/);
  });

  it('a tool that takes a built-in tool’s name', async () => {
    for (const name of ['set_field', 'send_flow', 'get_contact']) {
      const { configDir } = project(['invented'], { invented: pluginSource({}, { name }) });
      await refused(configDir, /takes the name of a built-in tool/);
    }
  });

  it('a tool another plugin already defines', async () => {
    const { configDir } = project(['first-plugin', 'second-plugin'], {
      'first-plugin': pluginSource({ name: 'first' }),
      'second-plugin': pluginSource({ name: 'second' }),
    });
    await refused(configDir, /plugin first already defines it/);
  });

  it('a free-text string parameter outside a note field', async () => {
    const { configDir } = project(['invented'], {
      invented: pluginSource({}, { parameters: "{ comment: { type: 'string' } }" }),
    });
    await refused(configDir, /parameter "comment": free text is refused/);
  });

  it('a note longer than a tools.json note may be (ADR-0017)', async () => {
    const { configDir } = project(['invented'], {
      invented: pluginSource({}, { parameters: "{ summary: { type: 'note', maxLength: 501 } }" }),
    });
    await refused(configDir, /maxLength must be a whole number from 1 to 500/);
  });

  it('a channel, which this release does not mount (specs/038)', async () => {
    const { configDir } = project(['invented'], {
      invented: pluginSource({ extra: 'channels: [],' }),
    });
    await refused(configDir, /channels are not supported yet/);
  });

  it('an unknown key, a path in place of a package, and a malformed plugins.json', async () => {
    await refused(
      project(['invented'], { invented: pluginSource({ extra: 'tool: [],' }) }).configDir,
      /unknown keys tool/,
    );
    await refused(project(['./local-plugin']).configDir, /a package name, not a path/);
    await refused(project(['invented', 'invented']).configDir, /invented is listed twice/);
  });

  it('a default export that is not a plugin', async () => {
    const { configDir } = project(['invented'], { invented: 'export default 42;\n' });
    await refused(configDir, /default export is not a plugin/);
  });
});

/* -------------------------------------------------------------------------- */
/* A plugin tool is a staged action                                            */
/* -------------------------------------------------------------------------- */

describe('a plugin tool is a staged action (specs/036 V4)', () => {
  it('is offered beside the built-in tools, and a call stages it without performing it', async () => {
    const { tool, calls } = recordingTool();
    const stage = new ActionStage();
    const tools = buildTools(NO_TOOLS, stage, undefined, undefined, { plugins: plugins(tool) })!;
    expect(Object.keys(tools)).toEqual(['crm_log_lead']);
    expect(tools.crm_log_lead!.description).toContain('The action is staged, not performed');

    expect(await call(tools, 'crm_log_lead', { temperature: 'hot' })).toEqual({ staged: true });
    expect(calls).toHaveLength(0);
    expect(stage.staged).toEqual([
      { tool: 'plugin', id: 'crm_log_lead', plugin: 'example-crm', params: { temperature: 'hot' } },
    ]);
    // Recorded by name, never by what it was given.
    expect(stage.records('staged')).toEqual([
      { tool: 'plugin', id: 'crm_log_lead', status: 'staged' },
    ]);
  });

  it('validates the parameters against the declaration, not against the plugin', () => {
    const { tool } = recordingTool();
    const tools = buildTools(NO_TOOLS, new ActionStage(), undefined, undefined, {
      plugins: plugins(tool),
    })!;
    const schema = tools.crm_log_lead!.inputSchema as {
      safeParse: (value: unknown) => { success: boolean };
    };
    expect(schema.safeParse({ temperature: 'cold' }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
    expect(
      schema.safeParse({ temperature: 'warm', summary: 'Asked about evenings.' }).success,
    ).toBe(true);
  });

  it('takes no subscriber from the model: one it names is dropped', async () => {
    const { tool } = recordingTool();
    const stage = new ActionStage();
    const tools = buildTools(NO_TOOLS, stage, undefined, undefined, { plugins: plugins(tool) })!;
    await call(tools, 'crm_log_lead', { temperature: 'warm', subscriberId: '5550000000001' });
    expect(JSON.stringify(stage.staged)).not.toContain('5550000000001');
  });

  it('cleans a note when it is staged, and keeps it apart from the other parameters', async () => {
    const { tool } = recordingTool();
    const stage = new ActionStage();
    const tools = buildTools(NO_TOOLS, stage, undefined, undefined, { plugins: plugins(tool) })!;
    await call(tools, 'crm_log_lead', {
      temperature: 'warm',
      summary: 'Call back on +1 555 010 2030 about the evening course',
    });
    const [staged] = stage.staged as Extract<StagedAction, { tool: 'plugin' }>[];
    expect(staged!.params).toEqual({ temperature: 'warm' });
    expect(staged!.notes!.summary).toContain('[removed]');
    expect(staged!.notes!.summary).not.toContain('555');
    expect(staged!.notes!.summary!.length).toBeLessThanOrEqual(60);
  });

  it('counts towards MAX_ACTIONS_PER_TURN', async () => {
    const { tool } = recordingTool({
      parameters: { seats: { type: 'number', integer: true, min: 1, max: 20 } },
    });
    const stage = new ActionStage();
    const tools = buildTools(NO_TOOLS, stage, undefined, undefined, { plugins: plugins(tool) })!;
    for (let seats = 1; seats <= MAX_ACTIONS_PER_TURN; seats++) {
      expect(await call(tools, 'crm_log_lead', { seats })).toEqual({ staged: true });
    }
    expect(await call(tools, 'crm_log_lead', { seats: 20 })).toEqual({ staged: false });
    expect(stage.dropped).toHaveLength(1);
  });

  it('is refused before the contact is a prospect, as a built-in write is (specs/034)', async () => {
    const { tool } = recordingTool();
    const stage = new ActionStage();
    const tools = buildTools(
      tenant.tools!,
      stage,
      { sentFlows: new Set(), intent: 'not_prospect' },
      undefined,
      { plugins: plugins(tool) },
    )!;
    expect(await call(tools, 'crm_log_lead', { temperature: 'hot' })).toEqual({
      staged: false,
      reason: 'not_prospect',
    });
    expect(stage.staged).toHaveLength(0);
  });

  it('adds a line to the prompt only when a plugin adds a tool', () => {
    const { persona, catalog, rules } = tenant;
    const without = buildSystemPrompt(persona, catalog, rules, NO_TOOLS).staticPrefix;
    const withPlugins = buildSystemPrompt(persona, catalog, rules, NO_TOOLS, {
      pluginTools: true,
    }).staticPrefix;
    expect(without).not.toContain('ACTIONS');
    expect(withPlugins).toContain('ACTIONS');
    expect(withPlugins).toContain('This deployment adds tools of its own.');
  });
});

/* -------------------------------------------------------------------------- */
/* What a plugin is given, and how its perform ends                            */
/* -------------------------------------------------------------------------- */

describe('what a plugin is never given (specs/036 V5)', () => {
  const action: StagedAction = {
    tool: 'plugin',
    id: 'crm_log_lead',
    plugin: 'example-crm',
    params: { temperature: 'hot' },
    notes: { summary: 'Prefers evenings.' },
  };

  it('receives the subscriber from the turn, its parameters, the logger and a signal, and nothing else', async () => {
    const { tool, calls } = recordingTool();
    const inner = new FakeActions();
    const { logger } = hostLogger();
    const performer = plugins(tool).performer(inner, logger);
    const [group] = await performActions(performer, '5550000000002', [action], logger);
    expect(group).toEqual([{ tool: 'plugin', id: 'crm_log_lead', status: 'performed' }]);
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0]!).sort()).toEqual(['logger', 'params', 'signal', 'subscriberId']);
    expect(calls[0]!.subscriberId).toBe('5550000000002');
    expect(calls[0]!.params).toEqual({ temperature: 'hot', summary: 'Prefers evenings.' });
    // A plugin action never reaches ManyChat.
    expect(inner.performed).toHaveLength(0);
  });

  it('leaves every other action to the performer it wraps', async () => {
    const { tool, calls } = recordingTool();
    const inner = new FakeActions();
    const performer = plugins(tool).performer(inner, hostLogger().logger);
    await performer.performAction('s1', { tool: 'add_tag', id: 'warm', tag: 'warm-lead' });
    expect(inner.performed).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  it('logs through the agent’s redacting logger, naming the plugin', async () => {
    const tool: PluginTool = {
      name: 'crm_log_lead',
      description: 'Log an invented lead.',
      parameters: {},
      perform: ({ logger, subscriberId }) => {
        logger.warn(`sync failed for ${subscriberId}, reach them at lead@example.com`, {
          detail: 'or call +1 555 010 2030',
          attempt: 2,
        });
      },
    };
    const { logger, lines } = hostLogger();
    await plugins(tool)
      .performer(new FakeActions(), logger)
      .performAction('5550000000003', { ...action, params: {}, notes: undefined });
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line!.level).toBe('warn');
    expect(line!.fields.plugin).toBe('example-crm');
    expect(line!.fields.attempt).toBe(2);
    const written = JSON.stringify(line);
    for (const leaked of ['5550000000003', 'lead@example.com', '555 010 2030']) {
      expect(written).not.toContain(leaked);
    }
  });

  it('a failed perform is recorded and logged without the note it was given, and never retried', async () => {
    const { tool, calls } = recordingTool({ ends: 'throws' });
    const { logger, lines } = hostLogger();
    const performer = plugins(tool).performer(new FakeActions(), logger);
    const [group] = await performActions(performer, '5550000000004', [action], logger);
    expect(calls).toHaveLength(1);
    expect(group![0]!.status).toBe('failed');
    expect(group![0]!.error).toContain('CRM refused [subscriber]: [note]');
    expect(JSON.stringify(lines)).not.toContain('Prefers evenings.');
    expect(JSON.stringify(lines)).not.toContain('5550000000004');
  });

  it(`stops waiting after ${PLUGIN_PERFORM_TIMEOUT_MS} ms and aborts the signal`, async () => {
    vi.useFakeTimers();
    const { tool, calls } = recordingTool({ ends: 'hangs' });
    const { logger } = hostLogger();
    const performer = plugins(tool).performer(new FakeActions(), logger);
    const outcome = performActions(performer, 's1', [action], logger);
    await vi.advanceTimersByTimeAsync(PLUGIN_PERFORM_TIMEOUT_MS);
    const [group] = await outcome;
    expect(group![0]!.status).toBe('failed');
    expect(group![0]!.error).toContain('timed out');
    expect(calls[0]!.signal.aborted).toBe(true);
  });

  it('a row queued for a plugin that is no longer loaded fails, and is not sent to ManyChat', async () => {
    const inner = new FakeActions();
    const { logger } = hostLogger();
    const [group] = await performActions(
      Plugins.NONE.performer(inner, logger),
      's1',
      [action],
      logger,
    );
    expect(group![0]).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('not loaded'),
    });
    expect(inner.performed).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* agent config check                                                          */
/* -------------------------------------------------------------------------- */

describe('agent config check loads the plugins as agent serve does (specs/036 V7)', () => {
  // The values ci.yml sets, so only the plugins can be what is wrong.
  const ciEnv = {
    AGENT_MODEL: 'mock:demo',
    PUBLIC_BASE_URL: 'https://ci.example.com',
    MANYCHAT_SHARED_SECRET: 'ci-secret-ci-secret-ci-secret-xx',
    DATABASE_URL: 'pglite',
  };
  let stderr: ReturnType<typeof vi.spyOn>;
  let stdout: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    for (const [name, value] of Object.entries(ciEnv)) vi.stubEnv(name, value);
    stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const check = (packages: Parameters<typeof tenantProject>[1]) => {
    const { configDir } = project([EXAMPLE_PLUGIN], packages);
    cpSync('test/fixtures/config', configDir, { recursive: true });
    vi.stubEnv('CONFIG_DIR', configDir);
    return run(['node', 'agent', 'config', 'check']);
  };

  it('fails on a plugins.json naming a package that is not installed', async () => {
    expect(await check({})).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('invalid plugins'));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('is not installed'));
  });

  it('passes, naming the plugins it loaded, when they load', async () => {
    expect(await check({ [EXAMPLE_PLUGIN]: EXAMPLE_PLUGIN })).toBe(0);
    expect(stderr).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('plugins: example-crm'));
  });
});
