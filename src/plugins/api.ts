/**
 * The plugin API: what a tenant project's plugin package exports, imported
 * from the bare `manychat-ai-agent` entry point (specs/036).
 *
 * A plugin adds tools. A write tool is staged when the model calls it and
 * performed after the reply, exactly as the built-in tools of specs/012 are.
 * A read tool is performed when called, as `get_contact` is, and the model is
 * shown only the result it declares (specs/039). Neither gets more power than
 * a built-in tool has.
 */

/** The newest plugin API this agent implements: `2` adds read tools (specs/039). */
export const PLUGIN_API_VERSION = 2;

/** Every `apiVersion` this agent loads. A plugin naming another is refused at startup. */
export const SUPPORTED_PLUGIN_API_VERSIONS: readonly number[] = [1, 2];

/** The longest query a read tool may take. Chosen, not measured (specs/039). */
export const MAX_QUERY_LENGTH = 200;

/** The longest `text` field, or `list` entry, a read result may declare. Chosen, not measured. */
export const MAX_RESULT_TEXT_LENGTH = 1000;

/** The most entries a `list` field may declare. Chosen, not measured. */
export const MAX_RESULT_ITEMS = 5;

/** The longest a read result may be once serialised. Chosen, not measured. */
export const MAX_RESULT_LENGTH = 2000;

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

/**
 * One parameter of a read tool: a write tool's, less the `note`, plus at most
 * one `query`, the read's one free text (specs/039 § Its query is the one free
 * text, bounded and cleaned).
 */
export type ReadParameter =
  | Exclude<PluginParameter, { type: 'note' }>
  | {
      type: 'query';
      /** At most `MAX_QUERY_LENGTH` (200). */
      maxLength: number;
      description?: string;
      optional?: boolean;
    };

export type ReadParameters = Readonly<Record<string, ReadParameter>>;

/** One field of what a read returns (specs/039 § Its result is declared, validated and fenced). */
export type ResultField =
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
      type: 'text';
      /** At most `MAX_RESULT_TEXT_LENGTH` (1000). */
      maxLength: number;
      description?: string;
      optional?: boolean;
    }
  | {
      type: 'list';
      /** At most `MAX_RESULT_ITEMS` (5). */
      maxItems: number;
      /** Each entry's, at most `MAX_RESULT_TEXT_LENGTH` (1000). */
      maxLength: number;
      description?: string;
      optional?: boolean;
    };

export type ResultFields = Readonly<Record<string, ResultField>>;

type ValueOf<P extends PluginParameter | ReadParameter> = P extends {
  type: 'enum';
  values: readonly (infer V)[];
}
  ? V
  : P extends { type: 'number' }
    ? number
    : P extends { type: 'boolean' }
      ? boolean
      : string;

/** The validated values `perform` or `read` receives, typed from the declared parameters. */
export type ParamsOf<S extends PluginParameters | ReadParameters> = {
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
 * Everything `perform` or `read` is given: the turn's subscriber, never one the model
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

type FieldValue<F extends ResultField> = F extends { type: 'enum'; values: readonly (infer V)[] }
  ? V
  : F extends { type: 'number' }
    ? number
    : F extends { type: 'boolean' }
      ? boolean
      : F extends { type: 'list' }
        ? string[]
        : string;

/** What `read` returns, typed from the declared result. */
export type ResultOf<R extends ResultFields> = {
  [K in keyof R as R[K] extends { optional: true } ? never : K]: FieldValue<R[K]>;
} & {
  [K in keyof R as R[K] extends { optional: true } ? K : never]?: FieldValue<R[K]>;
};

/**
 * A tool the model calls to look something up (specs/039). `read` runs inside
 * the model's step, within the turn's read budget, and the model is shown only
 * what `result` declares, validated, bounded and fenced by the agent.
 */
export interface PluginReadTool<
  S extends ReadParameters = ReadParameters,
  R extends ResultFields = ResultFields,
> {
  /** Lowercase snake case, unique, and not a built-in tool's name. */
  name: string;
  /** What the model reads to decide when to call it. */
  description: string;
  parameters: S;
  result: R;
  /**
   * Runs when the model calls the tool. Throwing, or taking longer than the
   * read timeout, gives the model `{ available: false }` (specs/039 § A failed
   * read is not an escalation, and an ungrounded answer is).
   */
  read(call: PluginCall<ParamsOf<S>>): Promise<ResultOf<R>> | ResultOf<R>;
}

export interface Plugin {
  name: string;
  /** The plugin API it was written against; a read tool needs `2`. */
  apiVersion: number;
  // A tool's parameter types vary by tool, so the list cannot name one.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools?: readonly (PluginTool<any> | PluginReadTool<any, any>)[];
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

/** Types a read tool's `read` from its parameters and result. Returns the tool unchanged. */
export function defineReadTool<const S extends ReadParameters, const R extends ResultFields>(
  tool: PluginReadTool<S, R>,
): PluginReadTool<S, R> {
  return tool;
}
