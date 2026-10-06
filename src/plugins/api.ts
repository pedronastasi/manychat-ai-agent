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

export interface Plugin {
  name: string;
  /** The plugin API it was written against: `PLUGIN_API_VERSION`. */
  apiVersion: number;
  // A tool's parameter types vary by tool, so the list cannot name one.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools?: readonly PluginTool<any>[];
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
