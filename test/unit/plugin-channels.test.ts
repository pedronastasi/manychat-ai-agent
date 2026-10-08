import { describe, it, expect, afterEach, vi } from 'vitest';
import { cpSync } from 'node:fs';
import { loadPlugins, PluginError } from '../../src/plugins/loader.ts';
import { Plugins, type HostLogger } from '../../src/plugins/plugins.ts';
import {
  CHANNEL_PUSH_TIMEOUT_MS,
  ChannelInputError,
  PluginChannelAdapter,
  channelAdapters,
} from '../../src/channels/plugin/adapter.ts';
import type { PluginChannel } from '../../src/plugins/api.ts';
import {
  CHANNEL_API_VERSION,
  defineChannel,
  SUPPORTED_CHANNEL_API_VERSIONS,
} from '../../src/index.ts';
import { GenerateTextRunner } from '../../src/agent/runner.ts';
import { loadTenantConfig } from '../../src/config/loader.ts';
import { run } from '../../src/cli/run.ts';
import { mockModel } from '../helpers/model.ts';
import {
  channelPluginSource,
  EXAMPLE_CHANNEL_PLUGIN,
  EXAMPLE_PLUGIN,
  tenantProject,
} from '../helpers/plugins.ts';

/**
 * specs/038-plugin-channels.md § Verification, and the rules its sections set
 * that the integration tests do not reach: what the loader refuses, what the
 * adapter decides in the plugin's place, and that a channel's turn is offered
 * no `tools.json` tool. Every value is invented (C1).
 */

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

const one = (source: string) => project(['invented-channel'], { 'invented-channel': source });

async function refused(configDir: string, message: RegExp) {
  const loading = loadPlugins(configDir);
  await expect(loading).rejects.toThrow(PluginError);
  await expect(loading).rejects.toThrow(message);
}

const silent: HostLogger = { info: () => {}, warn: () => {}, error: () => {} };

describe('the channel API is versioned apart, and provisional (specs/038 § Channel API version)', () => {
  it('exports the channel API version 0 and defineChannel from the bare entry point', () => {
    expect(CHANNEL_API_VERSION).toBe(0);
    expect(SUPPORTED_CHANNEL_API_VERSIONS).toEqual([0]);
    const channel = { name: 'invented' } as unknown as PluginChannel;
    expect(defineChannel(channel)).toBe(channel);
  });
});

describe('a plugin channel is loaded from the tenant project (specs/038 V1)', () => {
  it('loads the invented channel beside another plugin, and reports it', async () => {
    const { configDir } = project([EXAMPLE_CHANNEL_PLUGIN, EXAMPLE_PLUGIN], {
      [EXAMPLE_CHANNEL_PLUGIN]: EXAMPLE_CHANNEL_PLUGIN,
      [EXAMPLE_PLUGIN]: EXAMPLE_PLUGIN,
    });
    const plugins = await loadPlugins(configDir);

    expect(plugins.channels.map(entry => [entry.plugin, entry.channel.name])).toEqual([
      ['example-widget', 'example-widget'],
    ]);
    expect(plugins.summary()).toEqual([
      { plugin: 'example-widget', writes: [], reads: [], channels: ['example-widget'] },
      { plugin: 'example-crm', writes: ['crm_log_lead'], reads: [], channels: [] },
    ]);
    const adapters = channelAdapters(plugins, silent);
    expect([...adapters.values()].map(adapter => adapter.route)).toEqual([
      '/v1/channels/example-widget/message',
    ]);
  });

  it('names the channel in `agent config check`', async () => {
    const { configDir } = project([EXAMPLE_CHANNEL_PLUGIN], {
      [EXAMPLE_CHANNEL_PLUGIN]: EXAMPLE_CHANNEL_PLUGIN,
    });
    cpSync('test/fixtures/config', configDir, { recursive: true });
    // The values ci.yml sets, so only the plugins can be what is wrong.
    vi.stubEnv('AGENT_MODEL', 'mock:demo');
    vi.stubEnv('PUBLIC_BASE_URL', 'https://ci.example.com');
    vi.stubEnv('MANYCHAT_SHARED_SECRET', 'ci-secret-ci-secret-ci-secret-xx');
    vi.stubEnv('DATABASE_URL', 'pglite');
    vi.stubEnv('CONFIG_DIR', configDir);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await run(['node', 'agent', 'config', 'check'])).toBe(0);
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining(
          'example-widget (writes: none; reads: none; channels: example-widget)',
        ),
      );
    } finally {
      vi.unstubAllEnvs();
      log.mockRestore();
    }
  });

  it('mounts none without a channel', () => {
    expect(Plugins.NONE.channels).toEqual([]);
    expect(channelAdapters(Plugins.NONE, silent).size).toBe(0);
  });
});

describe('a channel that does not load stops the server (specs/038, amending specs/036 V3)', () => {
  it.each([
    ['an unsupported channel apiVersion', { apiVersion: 1 }, /apiVersion 1 is not supported/],
    ['a missing channel apiVersion', { apiVersion: null }, /apiVersion null is not supported/],
    ['a name that is not a path segment', { name: 'Not/A Name' }, /must be lowercase letters/],
    ["ManyChat's name", { name: 'manychat' }, /takes a built-in channel's name/],
    ['an unknown key', { extra: 'secret: true,' }, /unknown keys secret/],
  ])('%s', async (_case, channel, message) => {
    await refused(one(channelPluginSource(channel)).configDir, message);
  });

  it('an inbound that is not a schema, and a missing parse, render or push', async () => {
    await refused(
      one(channelPluginSource({ inbound: '{ parse: () => ({}) }' })).configDir,
      /inbound must be a Zod schema/,
    );
    await refused(one(channelPluginSource({ render: '1' })).configDir, /render must be a function/);
    await refused(
      one(channelPluginSource({ push: 'undefined' })).configDir,
      /push must be a function/,
    );
  });

  it('a channel name another plugin already mounts', async () => {
    const { configDir } = project(['first-channel', 'second-channel'], {
      'first-channel': channelPluginSource({}, { name: 'first' }),
      'second-channel': channelPluginSource({}, { name: 'second' }),
    });
    await refused(configDir, /channel invented: plugin first already defines it/);
  });

  it('channels that are not a list, or a channel that is not an object', async () => {
    const source = (channels: string) =>
      `export default { name: 'invented', apiVersion: 1, channels: ${channels} };`;
    await refused(one(source('{}')).configDir, /channels must be an array/);
    await refused(one(source('[1]')).configDir, /a channel is not an object/);
  });
});

/** An invented channel, with its parts replaceable. */
function channel(overrides: Partial<PluginChannel> = {}): PluginChannel {
  return {
    name: 'invented',
    apiVersion: 0,
    inbound: {
      safeParse: (raw: unknown) =>
        typeof raw === 'object' && raw !== null && 'id' in raw
          ? { success: true as const, data: raw }
          : { success: false as const, error: new Error('invalid') },
    },
    parse: request => ({ subscriberId: (request as { id: string }).id, text: 'Hello' }),
    render: reply => reply,
    push: () => {},
    ...overrides,
  };
}

const ctx = { tenantId: 'demo', channel: 'ignored' };

describe('the adapter translates, and the agent decides (specs/038 § A plugin channel implements ChannelAdapter)', () => {
  it("fills in the tenant and the channel, prefixes the contact's ID, and presents no token or offering", () => {
    const adapter = new PluginChannelAdapter('invented-plugin', channel(), silent);
    const inbound = adapter.parse({ id: 'v-7' }, ctx);
    expect(inbound).toMatchObject({
      tenantId: 'demo',
      subscriberId: 'invented:v-7',
      channel: 'invented',
      text: 'Hello',
      contactName: null,
      locale: null,
      contactToken: null,
      offering: null,
    });
  });

  it("refuses a request that fails the channel's schema, before the plugin's parse reads it (C3)", () => {
    const parse = vi.fn();
    const adapter = new PluginChannelAdapter('invented-plugin', channel({ parse }), silent);
    expect(adapter.accepts({ nothing: true })).toBe(false);
    expect(() => adapter.parse({ nothing: true }, ctx)).toThrow(ChannelInputError);
    expect(parse).not.toHaveBeenCalled();
  });

  it('checks what the plugin returns, which is an external boundary too (C3)', () => {
    const smuggled = channel({
      parse: () => ({ subscriberId: 'v-7', text: 'Hello', contactToken: 'forged' }) as never,
    });
    expect(() =>
      new PluginChannelAdapter('invented-plugin', smuggled, silent).parse({ id: 'v-7' }, ctx),
    ).toThrow(/contactToken/);
    const empty = channel({ parse: () => ({ subscriberId: '', text: 'Hello' }) });
    expect(() =>
      new PluginChannelAdapter('invented-plugin', empty, silent).parse({ id: 'v-7' }, ctx),
    ).toThrow();
  });

  it('renders the messages and the handoff, and nothing else of the reply', () => {
    const render = vi.fn((reply: unknown) => reply);
    const adapter = new PluginChannelAdapter('invented-plugin', channel({ render }), silent);
    adapter.render({
      messages: ['The evening course starts next month.'],
      escalate: false,
      escalation_reason: null,
      confidence: 0.9,
      closing_question: null,
    });
    expect(render).toHaveBeenCalledWith({
      messages: ['The evening course starts next month.'],
      escalate: false,
    });
  });

  it("pushes to the platform's own ID, through the redacting logger that names the plugin", async () => {
    const lines: { fields: object; message: string }[] = [];
    const logger: HostLogger = {
      info: (fields, message) => lines.push({ fields, message }),
      warn: () => {},
      error: () => {},
    };
    const push = vi.fn((call: Parameters<PluginChannel['push']>[0]) => {
      call.logger.info(`sent to ${call.subscriberId}`);
    });
    const adapter = new PluginChannelAdapter('invented-plugin', channel({ push }), logger);
    await adapter.push(
      { subscriberId: 'invented:v-7' },
      {
        messages: ['Passing you to a person.'],
        escalate: true,
        escalation_reason: 'explicit_request',
        confidence: 1,
        closing_question: null,
      },
    );
    expect(push.mock.calls[0]![0]).toMatchObject({
      subscriberId: 'v-7',
      reply: { messages: ['Passing you to a person.'], escalate: true },
    });
    expect(lines).toEqual([
      { fields: { plugin: 'invented-plugin' }, message: 'sent to [subscriber]' },
    ]);
  });

  it('stops waiting for a push after 10 seconds and aborts its signal', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const push = (call: Parameters<PluginChannel['push']>[0]) => {
      signal = call.signal;
      return new Promise<void>(() => {});
    };
    const adapter = new PluginChannelAdapter('invented-plugin', channel({ push }), silent);
    const pushing = adapter.deliver('invented:v-7', { messages: ['Hello'], escalate: false });
    const failed = expect(pushing).rejects.toThrow(/timed out after 10000 ms/);
    await vi.advanceTimersByTimeAsync(CHANNEL_PUSH_TIMEOUT_MS);
    await failed;
    expect(signal?.aborted).toBe(true);
  });
});

describe("a plugin channel's turn is offered no tools.json tool (specs/038 § Outbound delivery)", () => {
  const ANSWER = {
    messages: ['The evening course starts next month.'],
    escalate: false,
    escalation_reason: null,
    confidence: 0.9,
    closing_question: null,
  };
  // The fixture tenant configures flows, tags and fields: every one writes to ManyChat.
  const tenant = loadTenantConfig('test/fixtures/config');

  it("offers ManyChat's tools on a ManyChat turn and none on a plugin channel's", async () => {
    const { model, calls } = mockModel(ANSWER);
    const runner = new GenerateTextRunner({
      model,
      modelSpec: 'mock:demo',
      config: () => tenant,
      maxOutputTokens: 500,
      temperature: 0,
    });

    await runner.run({ text: 'Hello', history: [] });
    await runner.run({ text: 'Hello', history: [], builtInTools: false });
    await runner.run({ text: 'Hello', history: [], builtInTools: false });

    const offered = (index: number) => (calls[index]?.tools ?? []).map(tool => tool.name);
    expect(offered(0)).toContain('send_flow');
    expect(offered(1)).toEqual([]);
    // Its prompt describes no tool it is not given.
    const system = (index: number) => JSON.stringify(calls[index]?.prompt[0]);
    expect(system(1)).not.toEqual(system(0));
    expect(system(2)).toEqual(system(1));
  });
});
