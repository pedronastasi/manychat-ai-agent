import { ChannelMessage, type AgentReply, type InboundMessage } from '../../contracts/agent.ts';
import type { ChannelReply, PluginChannel } from '../../plugins/api.ts';
import { pluginLogger, type HostLogger, type Plugins } from '../../plugins/plugins.ts';
import type { ChannelAdapter, ParseContext } from '../port.ts';

/**
 * How long the outbox waits for a channel's `push`. Past it the signal aborts
 * and the delivery is retried, as a ManyChat send that timed out is. The same
 * bound as a plugin's `perform` (specs/036); chosen, not measured.
 */
export const CHANNEL_PUSH_TIMEOUT_MS = 10_000;

/** A request that fails the channel's own schema: refused with a 400 before any turn (specs/038). */
export class ChannelInputError extends Error {
  constructor(channel: string) {
    super(`request does not match channel ${channel}'s schema`);
    this.name = 'ChannelInputError';
  }
}

/** The route a channel is mounted at, beside ManyChat's (specs/038). */
export const channelRoute = (name: string) => `/v1/channels/${name}/message`;

/**
 * A plugin's channel behind the `ChannelAdapter` port (specs/038, ADR-0005).
 * The plugin translates; everything it does not translate is decided here,
 * the same way for every plugin channel: the tenant, the channel, and that
 * the request carries no contact token and no offering.
 *
 * The contact's ID is prefixed with the channel's name, so a contact on one
 * channel never shares a conversation, an order or an outbox lane with one on
 * another whose platform happens to use the same ID.
 */
export class PluginChannelAdapter implements ChannelAdapter<unknown, unknown> {
  readonly name: string;
  readonly plugin: string;
  readonly route: string;

  private readonly channel: PluginChannel;
  private readonly logger: HostLogger;
  private readonly prefix: string;

  constructor(plugin: string, channel: PluginChannel, logger: HostLogger) {
    this.plugin = plugin;
    this.channel = channel;
    this.logger = logger;
    this.name = channel.name;
    this.route = channelRoute(channel.name);
    this.prefix = `${channel.name}:`;
  }

  /** Whether the request passes the channel's schema; checked before anything reads it (C3). */
  accepts(raw: unknown): boolean {
    return this.channel.inbound.safeParse(raw).success;
  }

  parse(raw: unknown, ctx: ParseContext): InboundMessage {
    const checked = this.channel.inbound.safeParse(raw);
    if (!checked.success) throw new ChannelInputError(this.name);
    // What the plugin returns is an external boundary too (C3).
    const message = ChannelMessage.parse(this.channel.parse(checked.data));
    return {
      tenantId: ctx.tenantId,
      subscriberId: `${this.prefix}${message.subscriberId}`,
      text: message.text,
      channel: this.name,
      contactName: message.contactName ?? null,
      locale: message.locale ?? null,
      // The channel's own auth binds its contacts: there is no token to
      // present, and none is issued (specs/038 § A plugin channel carries no
      // contact token).
      contactToken: null,
      offering: null,
      receivedAt: new Date(),
    };
  }

  render(reply: AgentReply): unknown {
    return this.channel.render({ messages: reply.messages, escalate: reply.escalate });
  }

  /** Delivers a lost race's reply (specs/038 § Outbound delivery is the adapter's `push`). */
  async push(to: { subscriberId: string }, reply: AgentReply): Promise<void> {
    await this.deliver(to.subscriberId, { messages: reply.messages, escalate: reply.escalate });
  }

  /** What `push` sends, from what the outbox keeps of a reply. */
  async deliver(to: string, reply: ChannelReply): Promise<void> {
    const subscriberId = to.startsWith(this.prefix) ? to.slice(this.prefix.length) : to;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new Error(`channel ${this.name} push timed out after ${CHANNEL_PUSH_TIMEOUT_MS} ms`),
        );
      }, CHANNEL_PUSH_TIMEOUT_MS);
    });
    try {
      await Promise.race([
        Promise.resolve().then(() =>
          this.channel.push({
            subscriberId,
            reply,
            logger: pluginLogger(this.logger, this.plugin, subscriberId),
            signal: controller.signal,
          }),
        ),
        timedOut,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** An adapter for each channel the plugins add, by name, logging through `logger`. */
export function channelAdapters(
  plugins: Plugins,
  logger: HostLogger,
): ReadonlyMap<string, PluginChannelAdapter> {
  return new Map(
    plugins.channels.map(({ plugin, channel }) => [
      channel.name,
      new PluginChannelAdapter(plugin, channel, logger),
    ]),
  );
}
