import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  CatalogSchema,
  EnvSchema,
  NO_TOOLS,
  RulesSchema,
  ToolsSchema,
} from '../contracts/config.ts';
import type { Catalog, Env, Rules, Tools } from '../contracts/config.ts';

export interface TenantConfig {
  persona: string;
  catalog: Catalog;
  rules: Rules;
  /** What the agent may act with (specs/012). Empty or absent: no tools are offered. */
  tools?: Tools;
}

/**
 * ManyChat objects this service already writes or fires for its own delivery.
 * A tool aimed at one would resend a stale reply, overwrite a reply in flight,
 * or replace the contact's token (specs/012 § The flow set may not include the
 * reply flow or field).
 */
export interface ReservedNames {
  replyFlowNs?: string | undefined;
  replyField?: string | undefined;
  tokenField?: string | undefined;
}

export function reservedNames(env: Env): ReservedNames {
  return {
    replyFlowNs: env.MANYCHAT_REPLY_FLOW_NS,
    replyField: env.MANYCHAT_REPLY_FIELD,
    tokenField: env.MANYCHAT_TOKEN_FIELD,
  };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Validates the environment.
 *
 * Failing here takes the process down at boot, which is the point: a malformed
 * AGENT_MODEL or a missing secret should fail the deploy, not the first customer
 * message (specs/003).
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map(issue => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`Invalid environment:\n${detail}\n\nSee .env.example.`);
  }
  return parsed.data;
}

function readJson(path: string, label: string): unknown {
  if (!existsSync(path)) {
    throw new ConfigError(
      `Missing ${label} at ${path}. Copy the matching .example file and fill it in.`,
    );
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw new ConfigError(`${label} at ${path} is not valid JSON: ${String(cause)}`);
  }
}

/**
 * A note is free text, so it may write only a field nothing else writes: not
 * the reply or token field, not an enum field, and not another note's
 * (specs/024 § Three free-text notes, declared and bounded).
 */
function noteCollisions(tools: Tools, reserved: ReservedNames): string[] {
  const enumFields = new Set(tools.fields.map(field => field.field));
  return tools.notes.flatMap((note, index) => [
    ...(note.field === reserved.replyField ? [`note '${note.id}' is MANYCHAT_REPLY_FIELD`] : []),
    ...(note.field === reserved.tokenField ? [`note '${note.id}' is MANYCHAT_TOKEN_FIELD`] : []),
    ...(enumFields.has(note.field) ? [`note '${note.id}' writes an enum field's field`] : []),
    ...tools.notes
      .slice(0, index)
      .filter(earlier => earlier.field === note.field)
      .map(earlier => `note '${note.id}' writes the field of note '${earlier.id}'`),
  ]);
}

/**
 * `tools.json` is optional: a deployment without it is offered no tools and
 * behaves exactly as before specs/012.
 */
function loadTools(dir: string, reserved: ReservedNames): Tools {
  const path = join(dir, 'tools.json');
  if (!existsSync(path)) return NO_TOOLS;

  const tools = ToolsSchema.safeParse(readJson(path, 'tools'));
  if (!tools.success) {
    throw new ConfigError(
      `Invalid tools.json:\n` +
        tools.error.issues.map(issue => `  ${issue.path.join('.')}: ${issue.message}`).join('\n'),
    );
  }

  const collisions = [
    ...tools.data.flows
      .filter(flow => flow.flowNs === reserved.replyFlowNs)
      .map(flow => `flow '${flow.id}' is MANYCHAT_REPLY_FLOW_NS`),
    ...tools.data.fields
      .filter(field => field.field === reserved.replyField)
      .map(field => `field '${field.id}' is MANYCHAT_REPLY_FIELD`),
    ...tools.data.fields
      .filter(field => field.field === reserved.tokenField)
      .map(field => `field '${field.id}' is MANYCHAT_TOKEN_FIELD`),
    ...noteCollisions(tools.data, reserved),
  ];
  if (collisions.length > 0) {
    throw new ConfigError(
      `Invalid tools.json: it names objects this service uses for delivery:\n` +
        collisions.map(collision => `  ${collision}`).join('\n'),
    );
  }
  return tools.data;
}

export function loadTenantConfig(dir = 'config', reserved: ReservedNames = {}): TenantConfig {
  const personaPath = join(dir, 'prompt.md');
  if (!existsSync(personaPath)) {
    throw new ConfigError(`Missing persona at ${personaPath}. Copy prompt.md.example.`);
  }

  const catalog = CatalogSchema.safeParse(readJson(join(dir, 'catalog.json'), 'catalog'));
  if (!catalog.success) {
    throw new ConfigError(
      `Invalid catalog.json:\n` +
        catalog.error.issues.map(issue => `  ${issue.path.join('.')}: ${issue.message}`).join('\n'),
    );
  }

  const rules = RulesSchema.safeParse(readJson(join(dir, 'rules.json'), 'rules'));
  if (!rules.success) {
    throw new ConfigError(
      `Invalid rules.json:\n` +
        rules.error.issues.map(issue => `  ${issue.path.join('.')}: ${issue.message}`).join('\n'),
    );
  }

  return {
    persona: readFileSync(personaPath, 'utf8'),
    catalog: catalog.data,
    rules: rules.data,
    tools: loadTools(dir, reserved),
  };
}

/**
 * Holds the active tenant config and swaps it atomically on reload.
 *
 * Reload is wired to SIGHUP because the first weeks of a deployment are almost
 * entirely prompt edits; a full restart per wording tweak is the kind of
 * friction that ends with people editing prompts in production by hand.
 *
 * A failed reload keeps the previous config: bad config must never be able to
 * take down a running bot.
 */
export class ConfigStore {
  private current: TenantConfig;
  private readonly dir: string;
  private readonly reserved: ReservedNames;

  constructor(dir = 'config', reserved: ReservedNames = {}) {
    this.dir = dir;
    this.reserved = reserved;
    this.current = loadTenantConfig(dir, reserved);
  }

  get(): TenantConfig {
    return this.current;
  }

  reload(): { ok: true } | { ok: false; error: string } {
    try {
      this.current = loadTenantConfig(this.dir, this.reserved);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
