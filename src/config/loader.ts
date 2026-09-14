import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CatalogSchema, EnvSchema, RulesSchema } from '../contracts/config.ts';
import type { Catalog, Env, Rules } from '../contracts/config.ts';

export interface TenantConfig {
  persona: string;
  catalog: Catalog;
  rules: Rules;
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
      .map(i => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
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

export function loadTenantConfig(dir = 'config'): TenantConfig {
  const personaPath = join(dir, 'prompt.md');
  if (!existsSync(personaPath)) {
    throw new ConfigError(`Missing persona at ${personaPath}. Copy prompt.md.example.`);
  }

  const catalog = CatalogSchema.safeParse(readJson(join(dir, 'catalog.json'), 'catalog'));
  if (!catalog.success) {
    throw new ConfigError(
      `Invalid catalog.json:\n` +
        catalog.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n'),
    );
  }

  const rules = RulesSchema.safeParse(readJson(join(dir, 'rules.json'), 'rules'));
  if (!rules.success) {
    throw new ConfigError(
      `Invalid rules.json:\n` +
        rules.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n'),
    );
  }

  return {
    persona: readFileSync(personaPath, 'utf8'),
    catalog: catalog.data,
    rules: rules.data,
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

  constructor(dir = 'config') {
    this.dir = dir;
    this.current = loadTenantConfig(dir);
  }

  get(): TenantConfig {
    return this.current;
  }

  reload(): { ok: true } | { ok: false; error: string } {
    try {
      this.current = loadTenantConfig(this.dir);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
