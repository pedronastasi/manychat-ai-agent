import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { PerformableAction } from '../contracts/agent.ts';
import type { ActionPerformer } from '../channels/manychat/client.ts';
import { cleanNote } from '../agent/contact.ts';
import type { ActionStage } from '../agent/tools.ts';
import { redactText } from '../observability/redact.ts';
import type { PluginLogger, PluginParameter, PluginTool } from './api.ts';

/**
 * How long the agent waits for a plugin's `perform`. Past it the signal
 * aborts and the action is recorded as failed, so a hung plugin cannot hold
 * up the rest of the turn's actions or the outbox (specs/036). Chosen, not
 * measured: the ManyChat client's own request timeout is shorter.
 */
export const PLUGIN_PERFORM_TIMEOUT_MS = 10_000;

/** The parameter values a staged plugin action carries, already validated and cleaned. */
export type PluginParams = Record<string, string | number | boolean>;

/** The logger the agent writes through; the process's redacting pino logger in production. */
export interface HostLogger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

export interface LoadedTool {
  /** The plugin that declared it. */
  plugin: string;
  tool: PluginTool;
}

/** The model-facing schema, built here from the declaration, never taken from the plugin. */
function schemaOf(parameter: PluginParameter): z.ZodType {
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
    case 'note':
      schema = z.string();
      break;
  }
  if (parameter.description !== undefined) schema = schema.describe(parameter.description);
  return parameter.optional ? schema.optional() : schema;
}

const NOTE_RULE =
  'A note parameter is for the people who follow up: never put a name, phone number, email or link in one; they are removed.';

/**
 * A logger that redacts what a plugin writes and names the plugin on every
 * line: the agent's logger, never one the plugin brings (C5).
 */
function pluginLogger(host: HostLogger, plugin: string, subscriberId: string): PluginLogger {
  const clean = (text: string) => redactText(text.split(subscriberId).join('[subscriber]'));
  const write =
    (level: 'info' | 'warn' | 'error') =>
    (message: string, fields: Record<string, unknown> = {}) => {
      const redacted = Object.fromEntries(
        Object.entries(fields).map(([key, value]) => [
          key,
          typeof value === 'string' ? clean(value) : value,
        ]),
      );
      host[level]({ ...redacted, plugin }, clean(message));
    };
  return { info: write('info'), warn: write('warn'), error: write('error') };
}

/**
 * The plugins a process loaded at boot (specs/036). Each tool is offered to
 * the model beside the built-in ones and performed after the reply, as a
 * built-in tool is.
 */
export class Plugins {
  static readonly NONE = new Plugins([]);

  private readonly byName: ReadonlyMap<string, LoadedTool>;
  /** The loaded plugins' names, in the order `plugins.json` lists them. */
  readonly names: readonly string[];

  constructor(tools: readonly LoadedTool[], names: readonly string[] = []) {
    this.byName = new Map(tools.map(entry => [entry.tool.name, entry]));
    this.names = names;
  }

  get hasTools(): boolean {
    return this.byName.size > 0;
  }

  /**
   * Adds each plugin tool to the turn's tools. A call stages the action and
   * nothing else; `closed` refuses it as the built-in writes are refused
   * before a contact is a prospect (specs/034).
   */
  addTools(
    tools: ToolSet,
    stage: ActionStage,
    closed: () => boolean,
    describe: (description: string) => string,
  ): void {
    for (const { plugin, tool: declared } of this.byName.values()) {
      const parameters = Object.entries(declared.parameters);
      const notes = parameters.filter(([, parameter]) => parameter.type === 'note');
      tools[declared.name] = tool({
        description: describe(
          notes.length > 0 ? `${declared.description}\n${NOTE_RULE}` : declared.description,
        ),
        inputSchema: z.object(
          Object.fromEntries(parameters.map(([key, parameter]) => [key, schemaOf(parameter)])),
        ),
        execute: (input: Record<string, unknown>) => {
          if (closed()) return { staged: false, reason: 'not_prospect' };
          const params: PluginParams = {};
          const notes: Record<string, string> = {};
          for (const [key, parameter] of parameters) {
            const value = input[key];
            if (value === undefined) continue;
            if (parameter.type !== 'note') {
              params[key] = value as string | number | boolean;
              continue;
            }
            // Cleaned when staged, as a `tools.json` note is, so the outbox
            // never holds what the plugin will not be given (specs/024).
            const cleaned = cleanNote(value as string, parameter.maxLength);
            if (cleaned.length > 0) notes[key] = cleaned;
            else if (!parameter.optional) return { staged: false };
          }
          return {
            staged: stage.stage({
              tool: 'plugin',
              id: declared.name,
              plugin,
              params,
              ...(Object.keys(notes).length > 0 ? { notes } : {}),
            }),
          };
        },
      });
    }
  }

  /**
   * Wraps the process's performer: a plugin action goes to its plugin, every
   * other action where it went before.
   */
  performer(inner: ActionPerformer, logger: HostLogger): ActionPerformer {
    return {
      performAction: (subscriberId: string, action: PerformableAction) =>
        action.tool === 'plugin'
          ? this.perform(subscriberId, action.id, { ...action.params, ...action.notes }, logger)
          : inner.performAction(subscriberId, action),
    };
  }

  private async perform(
    subscriberId: string,
    name: string,
    params: PluginParams,
    logger: HostLogger,
  ): Promise<void> {
    // A row queued before a restart that dropped the plugin.
    const entry = this.byName.get(name);
    if (!entry) throw new Error(`plugin tool ${name} is not loaded`);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`plugin tool ${name} timed out after ${PLUGIN_PERFORM_TIMEOUT_MS} ms`));
      }, PLUGIN_PERFORM_TIMEOUT_MS);
    });
    try {
      await Promise.race([
        Promise.resolve().then(() =>
          entry.tool.perform({
            subscriberId,
            params,
            logger: pluginLogger(logger, entry.plugin, subscriberId),
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
