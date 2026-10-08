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
 * An offering the agent cannot quote a price for must not be one it can
 * record or send content for, so the offering field and every flow's
 * `offering` name catalog ids only (specs/028, C6).
 */
function offeringMismatches(tools: Tools, catalog: Catalog): string[] {
  const ids = catalog.offerings.map(offering => offering.id);
  const field = tools.fields.find(entry => entry.offering);
  const sameSet =
    field !== undefined &&
    field.values.length === ids.length &&
    ids.every(id => field.values.includes(id));
  return [
    ...(field && !sameSet
      ? [`field '${field.id}' must list exactly the catalog offering ids: ${ids.join(', ')}`]
      : []),
    ...tools.flows
      .filter(flow => flow.offering !== undefined && !ids.includes(flow.offering))
      .map(
        flow => `flow '${flow.id}' names offering '${flow.offering}', which is not in the catalog`,
      ),
    // Without an offering field no turn ever has an offering, so the flow
    // could never be sent.
    ...(field
      ? []
      : tools.flows
          .filter(flow => flow.offering !== undefined)
          .map(flow => `flow '${flow.id}' has an offering, but no field is marked "offering"`)),
  ];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const entriesOf = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

/**
 * Keys a config written before specs/042 carries. Each is refused by name
 * rather than read through an alias, so the code keeps one shape and the
 * tenant learns the command that rewrites theirs (specs/042 § Existing
 * tenants move with `agent upgrade`).
 */
function legacyKeys(file: string, raw: unknown): string[] {
  if (!isRecord(raw)) return [];
  if (file === 'catalog.json') {
    return [
      ...('courses' in raw ? ['courses'] : []),
      ...(entriesOf(raw.offerings ?? raw.courses).some(entry => 'enrollmentUrl' in entry)
        ? ['enrollmentUrl']
        : []),
    ];
  }
  if (file === 'tools.json') {
    return [
      ...entriesOf(raw.fields)
        .filter(entry => 'course' in entry)
        .map(entry => `fields[${String(entry.id)}].course`),
      ...entriesOf(raw.flows)
        .filter(entry => 'course' in entry)
        .map(entry => `flows[${String(entry.id)}].course`),
    ];
  }
  return isRecord(raw.learning) && 'enrolledTag' in raw.learning ? ['learning.enrolledTag'] : [];
}

function refuseLegacy(file: string, raw: unknown): void {
  const keys = legacyKeys(file, raw);
  if (keys.length === 0) return;
  throw new ConfigError(
    `Invalid ${file}: it is in the shape of an earlier version (${keys.join(', ')}). ` +
      'Run `agent upgrade` to rewrite it.',
  );
}

/**
 * `tools.json` is optional: a deployment without it is offered no tools and
 * behaves exactly as before specs/012.
 */
function loadTools(dir: string, reserved: ReservedNames, catalog: Catalog): Tools {
  const path = join(dir, 'tools.json');
  if (!existsSync(path)) return NO_TOOLS;

  const raw = readJson(path, 'tools');
  refuseLegacy('tools.json', raw);
  const tools = ToolsSchema.safeParse(raw);
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
    ...tools.data.events
      .filter(event => event.flowNs === reserved.replyFlowNs)
      .map(event => `event '${event.id}' is MANYCHAT_REPLY_FLOW_NS`),
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

  const mismatches = offeringMismatches(tools.data, catalog);
  if (mismatches.length > 0) {
    throw new ConfigError(
      `Invalid tools.json: its offerings do not match catalog.json:\n` +
        mismatches.map(mismatch => `  ${mismatch}`).join('\n'),
    );
  }
  return tools.data;
}

export function loadTenantConfig(dir = 'config', reserved: ReservedNames = {}): TenantConfig {
  const personaPath = join(dir, 'prompt.md');
  if (!existsSync(personaPath)) {
    throw new ConfigError(`Missing persona at ${personaPath}. Copy prompt.md.example.`);
  }

  const rawCatalog = readJson(join(dir, 'catalog.json'), 'catalog');
  refuseLegacy('catalog.json', rawCatalog);
  const catalog = CatalogSchema.safeParse(rawCatalog);
  if (!catalog.success) {
    throw new ConfigError(
      `Invalid catalog.json:\n` +
        catalog.error.issues.map(issue => `  ${issue.path.join('.')}: ${issue.message}`).join('\n'),
    );
  }

  const rawRules = readJson(join(dir, 'rules.json'), 'rules');
  refuseLegacy('rules.json', rawRules);
  const rules = RulesSchema.safeParse(rawRules);
  if (!rules.success) {
    throw new ConfigError(
      `Invalid rules.json:\n` +
        rules.error.issues.map(issue => `  ${issue.path.join('.')}: ${issue.message}`).join('\n'),
    );
  }

  const tools = loadTools(dir, reserved, catalog.data);
  // The cohort is contacts the funnel moved to offered: without a funnel
  // field there is none to learn from (specs/031).
  if (rules.data.learning && !tools.fields.some(field => field.funnel)) {
    throw new ConfigError(
      'Invalid rules.json:\n  learning: needs a field marked "funnel" in tools.json',
    );
  }

  return {
    persona: readFileSync(personaPath, 'utf8'),
    catalog: catalog.data,
    rules: rules.data,
    tools,
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
