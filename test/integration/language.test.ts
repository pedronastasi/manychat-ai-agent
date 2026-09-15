import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTestDatabase } from '../helpers/db.ts';
import type { Database } from '../../src/db/client.ts';
import { loadTenantConfig } from '../../src/config/loader.ts';
import { buildSystemPrompt } from '../../src/agent/prompt.ts';
import { TurnHandler } from '../../src/routes/turn.ts';
import type { AgentRunner, AgentResult } from '../../src/agent/runner.ts';
import type { InboundMessage } from '../../src/contracts/agent.ts';

/**
 * specs/005-language.md § Tests.
 *
 * Proves no customer-facing copy is hardcoded, by running the same code paths
 * for two tenants whose copy differs. If a string were baked into source, both
 * tenants would receive it and these assertions would fail.
 *
 * Two English tenants prove this as strongly as an English and a non-English one
 * would, and without putting prose into the repository that Constitution C9
 * forbids. What is being tested is that copy comes from configuration - not that
 * any particular language works.
 */

const DEFAULT_TENANT = loadTenantConfig('test/fixtures/config');
const ALT = loadTenantConfig('test/fixtures/config-alt');

let db: Database;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
});
afterEach(async () => {
  await close();
});

const inbound = (text: string, subscriberId = 's1'): InboundMessage => ({
  tenantId: 'demo',
  subscriberId,
  text,
  channel: 'whatsapp',
  contactName: null,
  locale: null,
  receivedAt: new Date(),
});

const okResult = (messages: string[]): AgentResult => ({
  reply: { messages, escalate: false, escalation_reason: null, confidence: 0.9 },
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, costUsd: 0 },
  interventions: [],
  latencyMs: 1,
});

const slow: AgentRunner = {
  run: ({ signal }) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve(okResult(['late'])), 1500);
      signal?.addEventListener('abort', () => {
        clearTimeout(t);
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    }),
};

const deps = (runner: AgentRunner, rules: typeof DEFAULT_TENANT.rules) => ({
  db,
  runner,
  rules,
  raceDeadlineMs: 150,
  modelAbortMs: 5000,
  logger: { info: () => {}, error: () => {} },
});

describe('no customer-facing copy is hardcoded (C9)', () => {
  it('sends the tenant acknowledgement, not one from source', async () => {
    const out = await new TurnHandler(deps(slow, ALT.rules)).handle(inbound('how much is it?'));
    expect(out.reply.messages).toEqual([ALT.rules.messages.acknowledgement]);
    expect(out.reply.messages[0]).not.toBe(DEFAULT_TENANT.rules.messages.acknowledgement);
  });

  it('sends the tenant escalation message, not one from source', async () => {
    const boom: AgentRunner = { run: () => Promise.reject(new Error('down')) };
    const out = await new TurnHandler(deps(boom, ALT.rules)).handle(inbound('hello'));
    expect(out.reply.messages).toEqual([ALT.rules.messages.escalation]);
  });

  it('uses each tenant own copy for the same code path', async () => {
    const boom: AgentRunner = { run: () => Promise.reject(new Error('down')) };
    const alt = await new TurnHandler(deps(boom, ALT.rules)).handle(inbound('hello', 'a'));
    const base = await new TurnHandler(deps(boom, DEFAULT_TENANT.rules)).handle(
      inbound('hello', 'b'),
    );
    // Same code path, same input, different copy: proof it comes from config.
    expect(alt.reply.messages[0]).not.toBe(base.reply.messages[0]);
  });

  it('escalates on the tenant own keywords', async () => {
    const out = await new TurnHandler(deps(slow, ALT.rules)).handle(
      inbound('please transfer me now'),
    );
    expect(out.outcome).toBe('escalated_precheck');
    expect(out.reply.messages).toEqual([ALT.rules.messages.escalation]);
  });
});

describe('the framework scaffolding stays English', () => {
  it('builds English operating rules for every tenant', () => {
    const { staticPrefix } = buildSystemPrompt(ALT.persona, ALT.catalog, ALT.rules);
    expect(staticPrefix).toContain('OPERATING RULES');
    expect(staticPrefix).toContain('SECURITY');
    // The framework must not assume a reply language; the persona decides.
    expect(staticPrefix).toContain('Write in the language the persona above specifies.');
  });

  it('labels the catalog in English while the values come from the tenant', () => {
    const { catalogBlock } = buildSystemPrompt(ALT.persona, ALT.catalog, ALT.rules);
    expect(catalogBlock).toContain('name: Knife Skills Fundamentals');
    expect(catalogBlock).toContain('price:');
    expect(catalogBlock).toContain('EUR');
  });

  it('carries the tenant persona through verbatim, including its language rule', () => {
    // The persona is where a tenant asks for a non-English reply. The framework
    // passes it through without interpreting it.
    const { staticPrefix } = buildSystemPrompt(ALT.persona, ALT.catalog, ALT.rules);
    expect(staticPrefix).toContain('Reply in Portuguese');
  });
});

describe('committed source carries no Spanish copy', () => {
  // A cheap guard: copy in another language used to live in these files, and its
  // return would be invisible to every other test.
  it.each([
    'src/routes/turn.ts',
    'src/agent/guardrails.ts',
    'src/agent/prompt.ts',
    'src/agent/mock-provider.ts',
  ])('%s carries no prose in another language', file => {
    const content = readFileSync(file, 'utf8');
    // Non-ASCII Latin letters are the cheap signal that prose in another
    // language has been pasted back into source (Constitution C9).
    expect(content).not.toMatch(/[\u00C0-\u024F]/);
  });
});
