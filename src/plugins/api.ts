/**
 * The plugin API: what a tenant project's plugin package exports, imported
 * from the bare `manychat-ai-agent` entry point (specs/036).
 *
 * A plugin adds tools. Each is staged when the model calls it and performed
 * after the reply, exactly as the built-in tools of specs/012 are, so a plugin
 * gets no more power than one of them has.
 */

/** The plugin API this agent implements. A plugin naming another is refused at startup. */
export const PLUGIN_API_VERSION = 1;

/**
 * One parameter of a plugin tool. There is no free-text string: text is a
 * `note`, bounded and cleaned as a `tools.json` note is (specs/012 § Free-text
 * field values are refused, ADR-0017).
 */
export type PluginParameter =
  | {
      type: 'enum';
      values: readonly [string, ...string[]];
      description?: string;
      optional?: boolean;
    }
  | {
      type: 'number';
      integer?: boolean;
      min?: number;
      max?: number;
      description?: string;
      optional?: boolean;
    }
  | { type: 'boolean'; description?: string; optional?: boolean }
  | {
      type: 'note';
      /** At most `MAX_NOTE_LENGTH` (500), as a `tools.json` note. */
      maxLength: number;
      description?: string;
      optional?: boolean;
    };

export type PluginParameters = Readonly<Record<string, PluginParameter>>;

type ValueOf<P extends PluginParameter> = P extends { type: 'enum'; values: readonly (infer V)[] }
  ? V
  : P extends { type: 'number' }
    ? number
    : P extends { type: 'boolean' }
      ? boolean
      : string;

/** The validated values `perform` receives, typed from the declared parameters. */
export type ParamsOf<S extends PluginParameters> = {
  [K in keyof S as S[K] extends { optional: true } ? never : K]: ValueOf<S[K]>;
} & {
  [K in keyof S as S[K] extends { optional: true } ? K : never]?: ValueOf<S[K]>;
};

/**
 * The agent's own redacting logger, scoped to the plugin. Message and string
 * fields are redacted before they are written (C5).
 */
export interface PluginLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/**
 * Everything `perform` is given: the turn's subscriber, never one the model
 * named; the validated parameters; the logger; and a signal that aborts when
 * the agent stops waiting. No model, prompt, catalog or database.
 */
export interface PluginCall<P> {
  subscriberId: string;
  params: P;
  logger: PluginLogger;
  signal: AbortSignal;
}

export interface PluginTool<S extends PluginParameters = PluginParameters> {
  /** Lowercase snake case, unique, and not a built-in tool's name. */
  name: string;
  /** What the model reads to decide when to call it. */
  description: string;
  parameters: S;
  /**
   * Runs after the reply is sent, once. A failure is logged and recorded on
   * the turn, never retried (specs/012 § A failed action is logged, never retried).
   */
  perform(call: PluginCall<ParamsOf<S>>): Promise<void> | void;
}

/**
 * The channel API this agent implements (specs/038). Provisional: it may
 * break in any minor release until a second adapter has been built against
 * it, which is why it has a version of its own beside `PLUGIN_API_VERSION`.
 */
export const CHANNEL_API_VERSION = 0;

/**
 * A request body checked before anything reads it (C3). A Zod schema is one;
 * anything with the same `safeParse` passes.
 */
export interface InboundSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: unknown };
}

/**
 * What a channel reads out of a request: who wrote, and what. The tenant, the
 * channel's name and the time are the server's, never the plugin's.
 */
export interface ChannelInbound {
  /** The platform's id for the contact. The agent keeps it as `<channel>:<id>`. */
  subscriberId: string;
  /** What the contact typed. Empty when they sent only media. */
  text: string;
  contactName?: string | null;
  locale?: string | null;
  /**
   * The token `writeToken` stored for the contact, as the platform sends it
   * back (specs/019). Without it the turn is unbound.
   */
  contactToken?: string | null;
  /**
   * Media the contact sent. The agent never downloads it on a plugin channel:
   * the contact is asked to type instead (specs/020 § mediaFallback).
   */
  media?: { kind: 'audio' | 'image' | 'video' | 'unsupported'; url: string };
}

/** A reply as a channel delivers it: messages already fitted to `maxMessages`. */
export interface ChannelReply {
  /** Empty when the response must say nothing: the reply follows from the outbox. */
  messages: readonly string[];
}

/**
 * A channel other than ManyChat (specs/038). The agent mounts it at
 * `/v1/channels/<name>/message` behind the shared secret and runs each turn
 * exactly as it runs ManyChat's: the channel translates, and decides nothing.
 */
export interface PluginChannel<T = unknown, R = unknown> {
  /** Lowercase letters, digits and hyphens; the route's `<name>`. Not `manychat`. */
  name: string;
  /** The request body's schema: a request that fails it is refused with 400. */
  inbound: InboundSchema<T>;
  /** At most this many messages per response; the rest are joined into the last. */
  maxMessages: number;
  /** Reads the validated body. A throw is answered with the escalation message (C6). */
  parse(body: T): ChannelInbound;
  /** The response body the platform expects for a reply. */
  render(reply: ChannelReply): R;
  /**
   * Sends a reply outside the request, for a turn that lost the race. A throw
   * is retried by the outbox, as a failed ManyChat send is.
   */
  push(call: { subscriberId: string; reply: ChannelReply; signal: AbortSignal }): Promise<void>;
  /**
   * Stores the contact's token where the platform sends it back with each
   * request (specs/019). Without it, while tokens are enforced, no turn on
   * this channel reads the contact's history.
   */
  writeToken?(call: { subscriberId: string; token: string; signal: AbortSignal }): Promise<void>;
}

export interface Plugin {
  name: string;
  /** The plugin API it was written against: `PLUGIN_API_VERSION`. */
  apiVersion: number;
  // A tool's parameter types vary by tool, so the list cannot name one.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools?: readonly PluginTool<any>[];
  /** The channel API its channels were written against: `CHANNEL_API_VERSION`. */
  channelApiVersion?: number;
  // A channel's body and response types vary by channel, likewise.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  channels?: readonly PluginChannel<any, any>[];
}

/**
 * A plugin package's default export. Returns the plugin unchanged: the agent
 * checks it when it loads, so a plain object passes or fails the same way.
 */
export function definePlugin<const P extends Plugin>(plugin: P): P {
  return plugin;
}

/** Types a tool's `perform` from its parameters. Returns the tool unchanged. */
export function defineTool<const S extends PluginParameters>(tool: PluginTool<S>): PluginTool<S> {
  return tool;
}

/** Types a channel's `parse` from its schema. Returns the channel unchanged. */
export function defineChannel<T, R>(channel: PluginChannel<T, R>): PluginChannel<T, R> {
  return channel;
}
