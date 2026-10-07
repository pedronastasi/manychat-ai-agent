import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  CHANNEL_API_VERSION,
  defineChannel,
  definePlugin,
  PLUGIN_API_VERSION,
} from '../../src/index.ts';
import type { PluginChannel } from '../../src/plugins/api.ts';
import { loadPlugins, PluginError } from '../../src/plugins/loader.ts';
import { PLUGIN_PERFORM_TIMEOUT_MS } from '../../src/plugins/plugins.ts';
import { channelRoute, PluginChannelAdapter } from '../../src/channels/plugin.ts';
import { foldMessages } from '../../src/channels/port.ts';
import { capabilitiesFor } from '../../src/contracts/config.ts';
import type { AgentReply } from '../../src/contracts/agent.ts';
import { EXAMPLE_CHANNEL_PLUGIN, tenantProject } from '../helpers/plugins.ts';

/**
 * specs/038-plugin-channels.md § Verification, and the decisions it records:
 * the channel API's own version, and what the loader refuses at startup. Every
 * value here is invented (C1).
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

/** One channel plugin as source; `channel` is spliced into its channel object. */
function source(
  fields: { plugin?: string; channelApiVersion?: string; name?: string; channels?: string } = {},
  channel = '',
): string {
  const channels =
    fields.channels ??
    `[{
    name: ${fields.name ?? "'invented-chat'"},
    inbound: { safeParse: value => ({ success: true, data: value }) },
    maxMessages: 1,
    parse: body => ({ subscriberId: body.id, text: body.text }),
    render: reply => reply,
    async push() {},
    ${channel}
  }]`;
  return `export default {
  name: ${JSON.stringify(fields.plugin ?? 'invented')},
  apiVersion: 1,
  ${fields.channelApiVersion === undefined ? 'channelApiVersion: 0,' : fields.channelApiVersion}
  channels: ${channels},
};
`;
}

const refused = async (packages: Record<string, string>, message: RegExp) => {
  const { configDir } = project(Object.keys(packages), packages);
  const error = await loadPlugins(configDir).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(PluginError);
  expect((error as Error).message).toMatch(message);
};

const reply = (messages: string[]): AgentReply => ({
  messages,
  escalate: false,
  escalation_reason: null,
  confidence: 0.9,
  closing_question: null,
});

/** A channel kept in memory: what its push and writeToken were given. */
function recordingChannel(over: Partial<PluginChannel> = {}) {
  const pushed: unknown[] = [];
  const channel: PluginChannel<{ id: string; text: string }, { out: readonly string[] }> = {
    name: 'invented-chat',
    inbound: {
      safeParse: value => ({ success: true, data: value as { id: string; text: string } }),
    },
    maxMessages: 2,
    parse: body => ({ subscriberId: body.id, text: body.text }),
    render: rendered => ({ out: rendered.messages }),
    push: call => {
      pushed.push({ subscriberId: call.subscriberId, messages: call.reply.messages });
      return Promise.resolve();
    },
    ...over,
  } as PluginChannel<{ id: string; text: string }, { out: readonly string[] }>;
  return { adapter: new PluginChannelAdapter('invented', channel), pushed };
}

const parseContext = { tenantId: 'demo', channel: 'whatsapp' };

describe('the bare entry point exports the provisional channel API (specs/038)', () => {
  it('exports defineChannel and a channel API version of its own, 0, beside the tool API', () => {
    expect(CHANNEL_API_VERSION).toBe(0);
    expect(PLUGIN_API_VERSION).toBe(1);
    const channel = recordingChannel().adapter;
    expect(defineChannel).toBeTypeOf('function');
    const declared = { name: 'x' } as unknown as PluginChannel;
    expect(defineChannel(declared)).toBe(declared);
    expect(definePlugin({ name: 'p', apiVersion: 1, channelApiVersion: 0, channels: [] })).toEqual({
      name: 'p',
      apiVersion: 1,
      channelApiVersion: 0,
      channels: [],
    });
    expect(channel.route).toBe(channelRoute('invented-chat'));
  });
});

describe('a channel plugin loads at boot, or stops it (specs/038 V1)', () => {
  it('loads the invented fixture channel', async () => {
    const { configDir } = project([EXAMPLE_CHANNEL_PLUGIN], {
      [EXAMPLE_CHANNEL_PLUGIN]: EXAMPLE_CHANNEL_PLUGIN,
    });
    const plugins = await loadPlugins(configDir);
    expect(plugins.names).toEqual(['example-chat']);
    expect(plugins.channels.map(channel => channel.route)).toEqual([
      '/v1/channels/example-chat/message',
    ]);
    expect(plugins.channels[0]?.writesTokens).toBe(true);
  });

  it('refuses a channel written against another channel API version', async () => {
    await refused(
      { invented: source({ channelApiVersion: 'channelApiVersion: 1,' }) },
      /channelApiVersion 1 is not supported; this agent supports 0, which is provisional/,
    );
  });

  it('refuses a channel API version on a plugin with no channels', async () => {
    await refused(
      {
        invented:
          "export default { name: 'invented', apiVersion: 1, channelApiVersion: 0, tools: [] };\n",
      },
      /channelApiVersion is set but it has no channels/,
    );
  });

  it("refuses a name that is not a path segment, or is ManyChat's", async () => {
    for (const name of ["'Upper'", "'has space'", "'a/b'", "''", '7']) {
      await refused(
        { invented: source({ name }) },
        /must be lowercase letters, digits and hyphens/,
      );
    }
    await refused({ invented: source({ name: "'manychat'" }) }, /the name is the agent's own/);
  });

  it('refuses a channel another plugin already defines', async () => {
    await refused(
      {
        'first-chat': source({ plugin: 'first', name: "'shared-chat'" }),
        'second-chat': source({ plugin: 'second', name: "'shared-chat'" }),
      },
      /plugin second, channel shared-chat: plugin first already defines it/,
    );
  });

  it('refuses a channel without a schema to check its requests (C3)', async () => {
    await refused(
      {
        invented: source({
          channels: `[{ name: 'invented-chat', inbound: {}, maxMessages: 1,
            parse() {}, render() {}, async push() {} }]`,
        }),
      },
      /inbound must be a schema with safeParse/,
    );
  });

  it('refuses a missing method, a bad maxMessages, a writeToken that is not a function, and an unknown key', async () => {
    await refused(
      {
        invented: source({
          channels: `[{ name: 'invented-chat', inbound: { safeParse() {} }, maxMessages: 1,
            parse() {}, render() {} }]`,
        }),
      },
      /push must be a function/,
    );
    for (const maxMessages of ['0', '1.5', "'2'"]) {
      await refused(
        {
          invented: source({
            channels: `[{ name: 'invented-chat', inbound: { safeParse() {} },
              maxMessages: ${maxMessages}, parse() {}, render() {}, async push() {} }]`,
          }),
        },
        /maxMessages must be a whole number of at least 1/,
      );
    }
    await refused({ invented: source({}, "writeToken: 'yes',") }, /writeToken must be a function/);
    await refused({ invented: source({}, 'readContact() {},') }, /unknown keys readContact/);
    await refused({ invented: source({ channels: '{}' }) }, /channels must be an array/);
    await refused({ invented: source({ channels: '[42]' }) }, /a channel is not an object/);
  });
});

describe('the server owns the adapter around the plugin (specs/038)', () => {
  it("sets the tenant, the channel and the time, and keeps the contact as '<channel>:<id>'", () => {
    const { adapter } = recordingChannel();
    const inbound = adapter.parse({ id: 'c1', text: 'hello' }, parseContext);
    expect(inbound).toMatchObject({
      tenantId: 'demo',
      channel: 'invented-chat',
      subscriberId: 'invented-chat:c1',
      text: 'hello',
      contactName: null,
      locale: null,
      contactToken: null,
    });
    expect(inbound.receivedAt).toBeInstanceOf(Date);
  });

  it('refuses what parse returns when it fails the agent’s own schema (C3)', () => {
    for (const parsed of [
      { subscriberId: '', text: 'x' },
      { subscriberId: 'c1' },
      { subscriberId: 'c1', text: 'x'.repeat(4097) },
      { subscriberId: 'c1', text: 'x', tenantId: 'other' },
      { subscriberId: 'c1', text: '', media: { kind: 'audio', url: 'not a url' } },
    ]) {
      const { adapter } = recordingChannel({ parse: () => parsed as never });
      expect(() => adapter.parse({}, parseContext)).toThrow();
    }
  });

  it('checks the body against the channel’s schema', () => {
    const { adapter } = recordingChannel({
      inbound: { safeParse: () => ({ success: false, error: new Error('no') }) },
    });
    expect(adapter.check({})).toEqual({ ok: false });
  });

  it('fits a reply to maxMessages, and renders a silent response with no message', () => {
    const { adapter } = recordingChannel();
    const caps = { capabilities: capabilitiesFor('whatsapp') };
    expect(adapter.render(reply(['one', 'two', 'three']), caps)).toEqual({
      out: ['one', 'two\n\nthree'],
    });
    expect(adapter.render(reply(['one']), { ...caps, silent: true })).toEqual({ out: [] });
    expect(foldMessages(['a', 'b'], 3)).toEqual(['a', 'b']);
  });

  it('pushes to the platform’s own id, folded, and refuses another channel’s contact', async () => {
    const { adapter, pushed } = recordingChannel();
    await adapter.push({ subscriberId: 'invented-chat:c1' }, reply(['one', 'two', 'three']));
    expect(pushed).toEqual([{ subscriberId: 'c1', messages: ['one', 'two\n\nthree'] }]);
    await expect(adapter.sendText('5550001', ['x'])).rejects.toThrow(/not a invented-chat contact/);
  });

  it(`stops waiting for a push after ${PLUGIN_PERFORM_TIMEOUT_MS} ms and aborts its signal`, async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const { adapter } = recordingChannel({
      push: call => {
        signal = call.signal;
        return new Promise<void>(() => {});
      },
    });
    const sent = adapter.sendText('invented-chat:c1', ['x']);
    const outcome = expect(sent).rejects.toThrow(/push timed out/);
    await vi.advanceTimersByTimeAsync(PLUGIN_PERFORM_TIMEOUT_MS);
    await outcome;
    expect(signal?.aborted).toBe(true);
  });

  it('writes a token through the channel only when it stores one', async () => {
    const written: unknown[] = [];
    const storing = recordingChannel({
      writeToken: call => {
        written.push([call.subscriberId, call.token]);
        return Promise.resolve();
      },
    }).adapter;
    expect(storing.tokenWriter).toBe(storing);
    await storing.writeToken('invented-chat:c1', 'tok');
    expect(written).toEqual([['c1', 'tok']]);

    const plain = recordingChannel().adapter;
    expect(plain.writesTokens).toBe(false);
    expect(plain.tokenWriter).toBeUndefined();
    await expect(plain.writeToken('invented-chat:c1', 'tok')).rejects.toThrow(
      /does not store contact tokens/,
    );
  });
});
