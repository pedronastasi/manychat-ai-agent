import { z } from 'zod';
import { InboundMedia } from '../contracts/agent.ts';
import type { AgentReply, InboundMessage } from '../contracts/agent.ts';
import type { ContactTokenWriter } from '../conversation/tokens.ts';
import type { PluginChannel } from '../plugins/api.ts';
import { bounded } from '../plugins/plugins.ts';
import { foldMessages } from './port.ts';
import type { ChannelAdapter, ParseContext, RenderContext } from './port.ts';

/** Where a channel's requests arrive, beside ManyChat's (specs/038). */
export const channelRoute = (name: string) => `/v1/channels/${name}/message`;

/**
 * What a channel's `parse` returns, checked before the turn reads it (C3): a
 * plugin's bug stops here, as a handoff, rather than inside the turn.
 */
const ChannelInbound = z
  .object({
    subscriberId: z.string().min(1).max(200),
    // ManyChat's own bound on a message (specs/002).
    text: z.string().max(4096),
    contactName: z.string().nullish(),
    locale: z.string().nullish(),
    contactToken: z.string().nullish(),
    media: InboundMedia.optional(),
  })
  .strict();

/**
 * A plugin's channel as the server runs it: a `ChannelAdapter` the server
 * owns around the plugin's translation (specs/038). The tenant, the channel's
 * name and the arrival time are set here, never by the plugin, and the
 * contact is kept as `<channel>:<id>`, so no channel's contact is ever
 * another's: their history, order, rate limit and outbox rows stay apart.
 */
export class PluginChannelAdapter implements ChannelAdapter<unknown, unknown> {
  readonly name: string;
  /** The plugin that declared it. */
  readonly plugin: string;
  readonly route: string;
  private readonly channel: PluginChannel;

  constructor(plugin: string, channel: PluginChannel) {
    this.plugin = plugin;
    this.channel = channel;
    this.name = channel.name;
    this.route = channelRoute(channel.name);
  }

  /** Whether the channel stores contact tokens (specs/019). */
  get writesTokens(): boolean {
    return this.channel.writeToken !== undefined;
  }

  /** The request body against the channel's own schema, before anything reads it (C3). */
  check(body: unknown): { ok: true; data: unknown } | { ok: false } {
    const result = this.channel.inbound.safeParse(body);
    return result.success ? { ok: true, data: result.data } : { ok: false };
  }

  /** The contact as the agent keeps them. */
  contactId(platformId: string): string {
    return `${this.name}:${platformId}`;
  }

  /** The contact as the platform knows them. */
  private platformId(subscriberId: string): string {
    const prefix = `${this.name}:`;
    if (!subscriberId.startsWith(prefix)) {
      throw new Error(`subscriber is not a ${this.name} contact`);
    }
    return subscriberId.slice(prefix.length);
  }

  /** `raw` is the body `check` accepted. */
  parse(raw: unknown, ctx: ParseContext): InboundMessage {
    const read = ChannelInbound.parse(this.channel.parse(raw));
    return {
      tenantId: ctx.tenantId,
      subscriberId: this.contactId(read.subscriberId),
      text: read.text,
      channel: this.name,
      contactName: read.contactName ?? null,
      locale: read.locale ?? null,
      contactToken: read.contactToken ?? null,
      ...(read.media ? { media: read.media } : {}),
      receivedAt: new Date(),
    };
  }

  /** A silent response renders no message: the reply follows from the outbox. */
  render(reply: AgentReply, ctx: RenderContext): unknown {
    return this.channel.render({
      messages: ctx.silent ? [] : foldMessages(reply.messages, this.channel.maxMessages),
    });
  }

  async push(to: { subscriberId: string }, reply: AgentReply): Promise<void> {
    await this.sendText(to.subscriberId, reply.messages);
  }

  /** The outbox's delivery of a deferred reply, as `ManyChatClient.sendText` is ManyChat's. */
  async sendText(subscriberId: string, messages: readonly string[]): Promise<void> {
    const platformId = this.platformId(subscriberId);
    const reply = { messages: foldMessages(messages, this.channel.maxMessages) };
    await bounded(`channel ${this.name} push`, signal =>
      this.channel.push({ subscriberId: platformId, reply, signal }),
    );
  }

  async writeToken(subscriberId: string, token: string): Promise<void> {
    const write = this.channel.writeToken?.bind(this.channel);
    if (!write) throw new Error(`channel ${this.name} does not store contact tokens`);
    const platformId = this.platformId(subscriberId);
    await bounded(`channel ${this.name} token write`, signal =>
      write({ subscriberId: platformId, token, signal }),
    );
  }

  /** Where the turn writes an issued token; none when the channel stores none. */
  get tokenWriter(): ContactTokenWriter | undefined {
    return this.writesTokens ? this : undefined;
  }
}
