import type { AgentReply, InboundMessage } from '../contracts/agent.ts';
import type { ChannelCapabilities } from '../contracts/config.ts';

export interface RenderContext {
  capabilities: ChannelCapabilities;
  /** When set, the channel is asked to route the contact's next message here. */
  callbackUrl?: string | undefined;
  callbackSecret?: string | undefined;
  callbackTimeoutSeconds?: number | undefined;
  /** The contact field the channel fills into the callback as `ai_token` (specs/019). */
  contactTokenField?: string | undefined;
  /** The contact field the channel fills into the callback as `course` (specs/028). */
  courseField?: string | undefined;
  /**
   * Renders no message, only the callback: a flow sent this turn is still
   * playing and the reply follows it from the outbox (specs/030).
   */
  silent?: boolean | undefined;
}

export interface ParseContext {
  tenantId: string;
  channel: string;
  /** For what parsing notices but cannot reject, such as an unrecognised media URL. */
  logger?: { warn: (fields: object, message: string) => void } | undefined;
}

/**
 * The seam between the agent and any chat platform (ADR-0005).
 *
 * Deliberately narrow: parse an inbound payload, render a reply, and push a
 * reply out-of-band. Anything wider would start encoding one platform's model
 * into the port.
 */
export interface ChannelAdapter<TInbound = unknown, TOutbound = unknown> {
  readonly name: string;
  /** Normalizes a platform payload. Throws on invalid input. */
  parse(raw: unknown, ctx: ParseContext): InboundMessage;
  /** Renders a reply into the platform's response format. */
  render(reply: AgentReply, ctx: RenderContext): TOutbound;
  /** Delivers a reply outside the request/response cycle (the deferred path). */
  push(to: { subscriberId: string }, reply: AgentReply): Promise<void>;
  /** Exposed for tests and the simulator. */
  readonly _inboundType?: TInbound;
}
