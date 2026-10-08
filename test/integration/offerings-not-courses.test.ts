import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq, sql } from 'drizzle-orm';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as schema from '../../src/db/schema.ts';
import { conversations, insightProposals, learningRuns } from '../../src/db/schema.ts';
import type { Database } from '../../src/db/client.ts';
import { MIGRATIONS_DIR, runMigrations } from '../../src/db/migrate.ts';
import { createTestDatabase } from '../helpers/db.ts';
import { TurnHandler } from '../../src/routes/turn.ts';
import type { AgentRunner } from '../../src/agent/runner.ts';
import { RulesSchema } from '../../src/contracts/config.ts';
import { loadTenantConfig } from '../../src/config/loader.ts';
import { ManyChatAdapter } from '../../src/channels/manychat/adapter.ts';
import { FakeActions, FakeContactFields } from '../helpers/manychat.ts';

/**
 * specs/042-the-sales-layer-sells-offerings-not-courses.md § Verification
 * items 5 and 6: the turn request's `offering`, with `course` still read in
 * its absence, and the migration that renames the stored offering and the
 * learning job's counts without losing a value. Against PGlite and the
 * fictional demo tenant in test/fixtures/config.
 */

const tools = loadTenantConfig('test/fixtures/config').tools!;
const rules = RulesSchema.parse({
  messages: { acknowledgement: 'One moment.', escalation: 'Passing you to a person.' },
  budget: { dailyTokenCap: 100_000, dailyCostCapUsd: 5 },
  rateLimit: { turnsPerSubscriberPerHour: 60 },
});
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const runner: AgentRunner = {
  run: async () => ({
    reply: {
      messages: ['Happy to help.'],
      escalate: false,
      escalation_reason: null,
      confidence: 0.9,
      closing_question: 'Anything else?',
    },
    model: 'mock:demo',
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, costUsd: 0.001 },
    interventions: [],
    latencyMs: 5,
    toolsOffered: true,
  }),
};

describe('the request carries offering, and still accepts course (specs/042 V5)', () => {
  let db: Database;
  let close: () => Promise<void>;
  let contactFields: FakeContactFields;
  beforeEach(async () => {
    ({ db, close } = await createTestDatabase());
    contactFields = new FakeContactFields();
  });
  afterEach(async () => {
    await close();
  });

  const adapter = new ManyChatAdapter({
    sendText: async () => {},
    writeToken: async () => {},
    performAction: async () => {},
  });

  /** A request as ManyChat sends it, parsed by the strict inbound schema and handled. */
  async function stored(subscriberId: string, keys: Record<string, string>) {
    const inbound = adapter.parse(
      {
        subscriber_id: subscriberId,
        text: 'tell me more',
        ai_token: contactFields.tokenOf(subscriberId),
        ...keys,
      },
      { tenantId: 'demo', channel: 'whatsapp' },
    );
    await new TurnHandler({
      db,
      runner,
      rules,
      tools,
      logger,
      raceDeadlineMs: 200,
      modelAbortMs: 5000,
      tokenWriter: contactFields,
      tokensEnforced: true,
      actions: new FakeActions(),
    }).handle(inbound);
    return (
      await db.query.conversations.findFirst({
        where: eq(conversations.subscriberId, subscriberId),
      })
    )?.offering;
  }

  it('stores `offering` when it is the only key', async () => {
    expect(await stored('s-offering', { offering: 'advanced' })).toBe('advanced');
  });

  it('reads `course` as `offering` when no `offering` is sent', async () => {
    expect(await stored('s-course', { course: 'foundation' })).toBe('foundation');
  });

  it('lets `offering` win when both are sent', async () => {
    expect(await stored('s-both', { offering: 'advanced', course: 'foundation' })).toBe('advanced');
  });

  it('treats an empty `offering` as no offering, even beside a `course`', async () => {
    expect(await stored('s-empty', { offering: '', course: 'foundation' })).toBeNull();
  });
});

describe('the migration keeps every stored value (specs/042 V6)', () => {
  const rows = <T>(raw: unknown): T[] =>
    Array.isArray(raw) ? (raw as T[]) : ((raw as { rows?: T[] }).rows ?? []);

  it('renames course to offering and the enrolled counts to converted, values intact', async () => {
    const client = new PGlite();
    const db = drizzle(client, { schema }) as unknown as Database;
    const before = mkdtempSync(join(tmpdir(), 'migrations-before-042-'));
    try {
      // The schema as it stood before this spec: every migration up to 0011.
      for (const file of readdirSync(MIGRATIONS_DIR).filter(name => name < '0012')) {
        if (file.endsWith('.sql')) cpSync(join(MIGRATIONS_DIR, file), join(before, file));
      }
      await runMigrations(db, before);
      await db.execute(sql`
        INSERT INTO conversations (tenant_id, subscriber_id, channel, course)
        VALUES ('demo', 'a', 'whatsapp', 'foundation'), ('demo', 'b', 'whatsapp', NULL)`);
      const [run] = rows<{ id: string }>(
        await db.execute(sql`
          INSERT INTO learning_runs (tenant_id, week, status, enrolled_count, not_enrolled_count)
          VALUES ('demo', '2026-W40', 'completed', 7, 31) RETURNING id`),
      );
      await db.execute(sql`
        INSERT INTO insight_proposals
          (tenant_id, run_id, text, rationale, enrolled_count, not_enrolled_count, turn_ids)
        VALUES ('demo', ${run!.id}, 'An invented tactic.', 'Invented.', 5, 2, '[]'::jsonb)`);

      expect(await runMigrations(db)).toEqual(['0012_offerings_and_conversions.sql']);

      const kept = await db
        .select({ subscriberId: conversations.subscriberId, offering: conversations.offering })
        .from(conversations)
        .orderBy(conversations.subscriberId);
      expect(kept).toEqual([
        { subscriberId: 'a', offering: 'foundation' },
        { subscriberId: 'b', offering: null },
      ]);
      expect(
        await db
          .select({
            converted: learningRuns.convertedCount,
            notConverted: learningRuns.notConvertedCount,
          })
          .from(learningRuns),
      ).toEqual([{ converted: 7, notConverted: 31 }]);
      expect(
        await db
          .select({
            converted: insightProposals.convertedCount,
            notConverted: insightProposals.notConvertedCount,
          })
          .from(insightProposals),
      ).toEqual([{ converted: 5, notConverted: 2 }]);
    } finally {
      rmSync(before, { recursive: true, force: true });
      await client.close();
    }
  });
});
