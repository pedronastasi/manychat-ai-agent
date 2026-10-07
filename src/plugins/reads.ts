import { z } from 'zod';
import type { ReadRecord } from '../contracts/agent.ts';
import {
  cleanNote,
  cutAtWord,
  READ_TIMEOUT_MS,
  ReadBudget,
  UNAVAILABLE,
} from '../agent/contact.ts';
import { fenceUserText } from '../agent/fence.ts';
import { MAX_RESULT_LENGTH } from './api.ts';
import type { PluginReadTool, ReadParameter, ResultField, ResultFields } from './api.ts';
import { pluginLogger, type HostLogger } from './plugins.ts';

/** A read tool and the plugin that declared it. */
export interface LoadedReadTool {
  plugin: string;
  tool: PluginReadTool;
}

/**
 * What the model is shown of a read: the bounded fields as they are, and every
 * `text` and `list` value inside the contact fence, as `get_contact`'s notes
 * are (specs/039 § Its result is declared, validated and fenced, C4).
 */
export interface ReadResult {
  fields: Record<string, string | number | boolean>;
  text?: string;
}

/** A parameter's model-facing schema. A query is any string: it is cleaned and cut, not refused. */
export function readParameterSchema(parameter: ReadParameter): z.ZodType {
  let schema: z.ZodType;
  switch (parameter.type) {
    case 'enum':
      schema = z.enum(parameter.values as [string, ...string[]]);
      break;
    case 'number': {
      let number = parameter.integer ? z.number().int() : z.number();
      if (parameter.min !== undefined) number = number.min(parameter.min);
      if (parameter.max !== undefined) number = number.max(parameter.max);
      schema = number;
      break;
    }
    case 'boolean':
      schema = z.boolean();
      break;
    case 'query':
      schema = z.string();
      break;
  }
  if (parameter.description !== undefined) schema = schema.describe(parameter.description);
  return parameter.optional ? schema.optional() : schema;
}

/**
 * The schema a result is held to, built from the declaration and never taken
 * from the plugin (C3). Text over its bound is cut, and a list over its
 * `maxItems` keeps its first entries; anything else that does not fit fails.
 */
function fieldSchema(field: ResultField): z.ZodType {
  let schema: z.ZodType;
  switch (field.type) {
    case 'enum':
      schema = z.enum(field.values as [string, ...string[]]);
      break;
    case 'number': {
      let number = field.integer ? z.number().int() : z.number();
      if (field.min !== undefined) number = number.min(field.min);
      if (field.max !== undefined) number = number.max(field.max);
      schema = number;
      break;
    }
    case 'boolean':
      schema = z.boolean();
      break;
    case 'text':
      schema = z.string().transform(text => cutAtWord(text, field.maxLength));
      break;
    case 'list':
      schema = z
        .array(z.string())
        .transform(items =>
          items.slice(0, field.maxItems).map(item => cutAtWord(item, field.maxLength)),
        );
      break;
  }
  return field.optional ? schema.optional() : schema;
}

/**
 * The declared result of `raw`, or `undefined` when it does not fit. An
 * undeclared key is dropped; a wrong type, a missing required key or a result
 * over `MAX_RESULT_LENGTH` once cut fails the whole result, which is never
 * passed on in part.
 */
export function validateResult(
  declared: ResultFields,
  raw: unknown,
): Record<string, string | number | boolean | string[]> | undefined {
  const schema = z.object(
    Object.fromEntries(Object.entries(declared).map(([key, field]) => [key, fieldSchema(field)])),
  );
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return undefined;
  const result = parsed.data as Record<string, string | number | boolean | string[]>;
  return JSON.stringify(result).length > MAX_RESULT_LENGTH ? undefined : result;
}

/** The validated result as the model reads it: text fenced, bounded values outside the fence. */
export function readResult(
  declared: ResultFields,
  result: Record<string, string | number | boolean | string[]>,
): ReadResult {
  const fields: ReadResult['fields'] = {};
  const text: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(result)) {
    const type = declared[key]?.type;
    if (type === 'text' || type === 'list') text[key] = value as string | string[];
    else fields[key] = value as string | number | boolean;
  }
  return Object.keys(text).length > 0
    ? { fields, text: fenceUserText(JSON.stringify(text)) }
    : { fields };
}

/**
 * One turn's plugin reads (specs/039). Built per turn by the caller, which
 * knows the subscriber, so no read tool takes one from the model. Spends the
 * turn's `ReadBudget` with `get_contact`, and records each call without its
 * query or its result.
 */
export class PluginReads {
  private readonly subscriberId: string;
  private readonly logger: HostLogger;
  private readonly budget: ReadBudget;
  private readonly timeoutMs: number;
  private readonly last = new Map<string, ReadResult>();
  private readonly made: ReadRecord[] = [];

  constructor(opts: {
    subscriberId: string;
    logger: HostLogger;
    /** The turn's reads, shared with `get_contact`. */
    budget?: ReadBudget;
    timeoutMs?: number;
  }) {
    this.subscriberId = opts.subscriberId;
    this.logger = opts.logger;
    this.budget = opts.budget ?? new ReadBudget();
    this.timeoutMs = opts.timeoutMs ?? READ_TIMEOUT_MS;
  }

  /** Every read call this turn, in order: the turn's record of them. */
  get records(): readonly ReadRecord[] {
    return this.made;
  }

  /** Each tool's last successful read, which the reply step is shown. */
  get latest(): readonly { tool: string; result: ReadResult }[] {
    return [...this.last].map(([tool, result]) => ({ tool, result }));
  }

  /**
   * Performs a read, or answers `{ available: false }`: when the turn has no
   * read left, when the query is empty once cleaned, and when `read` throws,
   * outlasts the timeout or returns what its declaration does not allow. A
   * failed read is not an escalation (specs/039 § A failed read is not an
   * escalation, and an ungrounded answer is).
   */
  async read(
    { plugin, tool }: LoadedReadTool,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ReadResult | typeof UNAVAILABLE> {
    const started = Date.now();
    const record = (available: boolean) =>
      this.made.push({ plugin, tool: tool.name, available, durationMs: Date.now() - started });
    if (!this.budget.take()) {
      record(false);
      return UNAVAILABLE;
    }

    const params: Record<string, string | number | boolean> = {};
    for (const [key, parameter] of Object.entries(tool.parameters)) {
      const value = input[key];
      if (value === undefined) continue;
      if (parameter.type !== 'query') {
        params[key] = value as string | number | boolean;
        continue;
      }
      // Cleaned before it leaves the agent: the identifier shapes of a note,
      // never a name (specs/039 § Its query is the one free text).
      const cleaned = cleanNote(value as string, parameter.maxLength);
      if (cleaned.length === 0) {
        record(false);
        return UNAVAILABLE;
      }
      params[key] = cleaned;
    }

    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new Error('plugin read timed out')),
      this.timeoutMs,
    );
    const abandon = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    try {
      // Raced as well as aborted, so a read that ignores its signal is still
      // given up on in time.
      const raw = await Promise.race([
        Promise.resolve().then(() =>
          tool.read({
            subscriberId: this.subscriberId,
            params,
            logger: pluginLogger(this.logger, plugin, this.subscriberId),
            signal: abandon,
          }),
        ),
        new Promise<never>((_resolve, reject) => {
          abandon.addEventListener('abort', () => reject(new Error('plugin read abandoned')), {
            once: true,
          });
        }),
      ]);
      const validated = validateResult(tool.result, raw);
      if (!validated) {
        this.logger.warn(
          { plugin, tool: tool.name, error: 'invalid_result', timedOut: false },
          'plugin read failed',
        );
        record(false);
        return UNAVAILABLE;
      }
      const result = readResult(tool.result, validated);
      this.last.set(tool.name, result);
      record(true);
      return result;
    } catch (error) {
      // The error's name only: a plugin's message can quote the query or the
      // subscriber (C5).
      this.logger.warn(
        {
          plugin,
          tool: tool.name,
          error: error instanceof Error ? error.name : typeof error,
          timedOut: timeout.signal.aborted,
        },
        'plugin read failed',
      );
      record(false);
      return UNAVAILABLE;
    } finally {
      clearTimeout(timer);
    }
  }
}
