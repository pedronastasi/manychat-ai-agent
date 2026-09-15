import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTenantConfig, loadEnv, ConfigStore, ConfigError } from '../../src/config/loader.ts';

/**
 * specs/004-testing.md P1.
 *
 * Invalid config must fail at boot rather than at the first customer message,
 * and a failed RELOAD must keep the previous config serving — specs/003 promises
 * that a typo cannot take down a running bot.
 */

let dir: string;

const FIXTURES = 'test/fixtures/config';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-config-'));
  for (const f of ['prompt.md', 'catalog.json', 'rules.json']) {
    copyFileSync(join(FIXTURES, f), join(dir, f));
  }
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('loadTenantConfig', () => {
  it('loads a valid tenant', () => {
    const cfg = loadTenantConfig(dir);
    expect(cfg.persona.length).toBeGreaterThan(0);
    expect(cfg.catalog.courses.length).toBeGreaterThan(0);
    expect(cfg.rules.confidenceThreshold).toBeGreaterThan(0);
  });

  it('names the missing file rather than throwing something opaque', () => {
    rmSync(join(dir, 'prompt.md'));
    expect(() => loadTenantConfig(dir)).toThrow(ConfigError);
    expect(() => loadTenantConfig(dir)).toThrow(/prompt\.md/);
  });

  it('reports a missing catalog', () => {
    rmSync(join(dir, 'catalog.json'));
    expect(() => loadTenantConfig(dir)).toThrow(/catalog/i);
  });

  it('reports a missing rules file', () => {
    rmSync(join(dir, 'rules.json'));
    expect(() => loadTenantConfig(dir)).toThrow(/rules/i);
  });

  it('reports malformed JSON as such, not as a schema error', () => {
    writeFileSync(join(dir, 'catalog.json'), '{ "courses": [ ');
    expect(() => loadTenantConfig(dir)).toThrow(/not valid JSON/i);
  });

  it('rejects a catalog that violates the schema, naming the field', () => {
    writeFileSync(
      join(dir, 'catalog.json'),
      JSON.stringify({ businessName: 'X', currency: 'ARS', courses: [] }),
    );
    expect(() => loadTenantConfig(dir)).toThrow(/courses/);
  });

  it('rejects a price that is not an integer in minor units', () => {
    // Floats are how currency rounding bugs get in; specs/003 requires cents.
    const bad = {
      businessName: 'X',
      currency: 'ARS',
      courses: [
        {
          id: 'c',
          name: 'C',
          description: '',
          price: { amount: 450.5, currency: 'ARS' },
          durationHours: null,
          schedule: null,
          enrollmentUrl: null,
        },
      ],
      faq: [],
    };
    writeFileSync(join(dir, 'catalog.json'), JSON.stringify(bad));
    expect(() => loadTenantConfig(dir)).toThrow(/amount/);
  });

  it('rejects an out-of-range confidence threshold', () => {
    writeFileSync(
      join(dir, 'rules.json'),
      JSON.stringify({
        messages: { acknowledgement: 'One moment.', escalation: 'Passing you over.' },
        confidenceThreshold: 1.7,
        budget: {},
        rateLimit: {},
      }),
    );
    expect(() => loadTenantConfig(dir)).toThrow(/confidenceThreshold/);
  });

  it('applies documented defaults for omitted rules', () => {
    writeFileSync(
      join(dir, 'rules.json'),
      JSON.stringify({
        messages: { acknowledgement: 'One moment.', escalation: 'Passing you over.' },
        budget: {},
        rateLimit: {},
      }),
    );
    const cfg = loadTenantConfig(dir);
    expect(cfg.rules.confidenceThreshold).toBe(0.6);
    expect(cfg.rules.maxTurnsPerConversation).toBe(25);
    expect(cfg.rules.escalationKeywords).toEqual([]);
  });
});

describe('ConfigStore reload', () => {
  it('serves the new config after a successful reload', () => {
    const store = new ConfigStore(dir);
    const before = store.get().rules.confidenceThreshold;

    writeFileSync(
      join(dir, 'rules.json'),
      JSON.stringify({
        messages: { acknowledgement: 'One moment.', escalation: 'Passing you over.' },
        confidenceThreshold: 0.95,
        budget: {},
        rateLimit: {},
      }),
    );
    expect(store.reload()).toEqual({ ok: true });
    expect(store.get().rules.confidenceThreshold).toBe(0.95);
    expect(store.get().rules.confidenceThreshold).not.toBe(before);
  });

  it('KEEPS the previous config when a reload fails', () => {
    // specs/003: a typo in a live config file must not take down a running bot.
    const store = new ConfigStore(dir);
    const good = store.get();

    writeFileSync(join(dir, 'catalog.json'), '{ broken');
    const result = store.reload();

    expect(result.ok).toBe(false);
    expect(store.get()).toBe(good);
    expect(store.get().catalog.courses.length).toBeGreaterThan(0);
  });

  it('keeps serving after a file is deleted underneath it', () => {
    const store = new ConfigStore(dir);
    rmSync(join(dir, 'prompt.md'));
    expect(store.reload().ok).toBe(false);
    expect(store.get().persona.length).toBeGreaterThan(0);
  });

  it('recovers once the config is fixed', () => {
    const store = new ConfigStore(dir);
    writeFileSync(join(dir, 'rules.json'), 'nope');
    expect(store.reload().ok).toBe(false);

    writeFileSync(
      join(dir, 'rules.json'),
      JSON.stringify({
        messages: { acknowledgement: 'One moment.', escalation: 'Passing you over.' },
        confidenceThreshold: 0.75,
        budget: {},
        rateLimit: {},
      }),
    );
    expect(store.reload()).toEqual({ ok: true });
    expect(store.get().rules.confidenceThreshold).toBe(0.75);
  });

  it('fails at construction when the config is invalid from the start', () => {
    const empty = mkdtempSync(join(tmpdir(), 'agent-empty-'));
    mkdirSync(empty, { recursive: true });
    expect(() => new ConfigStore(empty)).toThrow(ConfigError);
    rmSync(empty, { recursive: true, force: true });
  });
});

describe('loadEnv', () => {
  const base = {
    AGENT_MODEL: 'mock:demo',
    PUBLIC_BASE_URL: 'https://x.example.com',
    MANYCHAT_SHARED_SECRET: 'a'.repeat(32),
    DATABASE_URL: 'pglite',
  } as NodeJS.ProcessEnv;

  it('lists every invalid field at once rather than one per restart', () => {
    try {
      loadEnv({ ...base, AGENT_MODEL: 'nope', PUBLIC_BASE_URL: 'not-a-url' });
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('AGENT_MODEL');
      expect(message).toContain('PUBLIC_BASE_URL');
      expect(message).toContain('.env.example');
    }
  });

  it('rejects a shared secret that is too short to be meaningful', () => {
    expect(() => loadEnv({ ...base, MANYCHAT_SHARED_SECRET: 'short' })).toThrow(ConfigError);
  });

  it('requires a database url', () => {
    const without: NodeJS.ProcessEnv = { ...base };
    delete without.DATABASE_URL;
    expect(() => loadEnv(without)).toThrow(/DATABASE_URL/);
  });

  it('coerces numeric settings from strings', () => {
    const env = loadEnv({ ...base, PORT: '8080', AGENT_TEMPERATURE: '0.7' });
    expect(env.PORT).toBe(8080);
    expect(env.AGENT_TEMPERATURE).toBe(0.7);
  });

  it('rejects a temperature outside the valid range', () => {
    expect(() => loadEnv({ ...base, AGENT_TEMPERATURE: '9' })).toThrow(/AGENT_TEMPERATURE/);
  });
});
