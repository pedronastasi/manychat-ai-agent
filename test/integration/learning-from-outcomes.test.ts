import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { eq, sql } from 'drizzle-orm';
import { createTestDatabase } from '../helpers/db.ts';
import { mockModel } from '../helpers/model.ts';
import type { Database } from '../../src/db/client.ts';
import {
  budgetCounters,
  conversations,
  insightProposals,
  learningRuns,
  turns,
} from '../../src/db/schema.ts';
import { loadEnv, loadTenantConfig } from '../../src/config/loader.ts';
import { run } from '../../src/cli/run.ts';
import { runInsights } from '../../src/learning/commands.ts';
import { openDatabase } from '../../src/learning/database.ts';
import { playbookSource, startLearning } from '../../src/learning/wiring.ts';
import type { TenantConfig } from '../../src/config/loader.ts';
import type { ContactRecord } from '../../src/contracts/manychat.ts';
import type { ContactReader } from '../../src/channels/manychat/client.ts';
import type { ActionRecord } from '../../src/contracts/agent.ts';
import { GenerateTextRunner } from '../../src/agent/runner.ts';
import { ConversationStore } from '../../src/conversation/store.ts';
import { Analyst } from '../../src/learning/analyst.ts';
import { LearningJob } from '../../src/learning/job.ts';
import { LearningStore, ReviewError } from '../../src/learning/store.ts';
import { PlaybookSource } from '../../src/learning/playbook.ts';
import { activate, report, review } from '../../src/learning/cli.ts';
import type { ReviewIo } from '../../src/learning/cli.ts';
import { NO_PLAYBOOK } from '../../src/learning/gate.ts';

/**
 * specs/031-learning-from-outcomes.md § Verification, against PGlite. Every
 * contact, message and tactic is invented (C1).
 */

const TENANT = 'demo';
const NOW = new Date('2026-10-06T12:00:00Z');
const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

const fixture = loadTenantConfig('test/fixtures/config');
const LEARNING = { language: 'English', enrolledTag: 'enrolled', maxRunCostUsd: 5 };
const tenant: TenantConfig = { ...fixture, rules: { ...fixture.rules, learning: LEARNING } };

let db: Database;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
});
afterEach(async () => {
  await close();
});

const offered = (status: ActionRecord['status'] = 'performed'): ActionRecord[] => [
  { tool: 'set_field', id: 'funnel_stage', value: 'offered', status },
];

/** A contact with one exchange: offered `offeredDays` ago, last heard from `lastDays` ago. */
async function seedContact(
  subscriberId: string,
  opts: { offeredDays?: number; lastDays: number; text?: string; actions?: ActionRecord[] },
): Promise<string> {
  const [conversation] = await db
    .insert(conversations)
    .values({ tenantId: TENANT, subscriberId, channel: 'whatsapp' })
    .returning({ id: conversations.id });
  const id = conversation!.id;
  const at = daysAgo(opts.offeredDays ?? opts.lastDays);
  await db.insert(turns).values({
    conversationId: id,
    role: 'user',
    text: opts.text ?? `Which course suits a beginner? (${subscriberId})`,
    createdAt: at,
  });
  await db.insert(turns).values({
    conversationId: id,
    role: 'agent',
    text: 'The weekend course is built for beginners.',
    actions: opts.actions ?? (opts.offeredDays === undefined ? [] : offered()),
    createdAt: at,
  });
  if (opts.lastDays !== (opts.offeredDays ?? opts.lastDays)) {
    await db.insert(turns).values({
      conversationId: id,
      role: 'user',
      text: 'Thanks, I will think about it.',
      createdAt: daysAgo(opts.lastDays),
    });
  }
  return id;
}

/** `count` offered, settled contacts, `enrolled` of them tagged. */
async function seedCohort(count: number, enrolled: number, prefix = 'lead') {
  const tags = new Map<string, string[]>();
  for (let index = 0; index < count; index++) {
    const subscriber = `${prefix}-${index}`;
    await seedContact(subscriber, { offeredDays: 30, lastDays: 20 + (index % 5) });
    tags.set(subscriber, index < enrolled ? ['enrolled'] : ['interested']);
  }
  return tags;
}

/** The ManyChat read, keyed by subscriber. A subscriber in `failing` fails. */
class FakeTagReader implements ContactReader {
  reads: string[] = [];
  private readonly tags: Map<string, string[]>;
  private readonly failing: Set<string>;
  constructor(tags: Map<string, string[]>, failing = new Set<string>()) {
    this.tags = tags;
    this.failing = failing;
  }
  readContact(subscriberId: string): Promise<ContactRecord> {
    this.reads.push(subscriberId);
    if (this.failing.has(subscriberId)) return Promise.reject(new Error('ManyChat unavailable'));
    return Promise.resolve({ tags: this.tags.get(subscriberId) ?? [], custom_fields: [] });
  }
}

/** The analyst at the provider boundary: it answers from the turn ids it was sent. */
function analystModel(
  answer: (turnIds: string[]) => unknown,
  usage = { input: 20_000, output: 500 },
) {
  const calls: LanguageModelV4CallOptions[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options: LanguageModelV4CallOptions) => {
      calls.push(options);
      const text = JSON.stringify(options.prompt);
      const ids = [...text.matchAll(/\[turn ([0-9a-f-]{36})\]/g)].map(match => match[1]!);
      return {
        finishReason: { unified: 'stop' as const, raw: 'end_turn' },
        usage: {
          inputTokens: { total: usage.input, noCache: usage.input, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: usage.output, text: usage.output, reasoning: 0 },
        },
        content: [{ type: 'text' as const, text: JSON.stringify(answer(ids)) }],
        warnings: [],
      };
    },
  });
  return { model, calls };
}

const TACTIC = 'Ask what the contact wants to learn before sending course content.';
const RATIONALE = 'Enrolled contacts were asked about their goal before any offer.';
const goodAnswer = (ids: string[]) => ({
  proposals: [
    {
      text: TACTIC,
      rationale: RATIONALE,
      enrolledCount: 12,
      notEnrolledCount: 3,
      turnIds: ids.slice(0, 2),
    },
    {
      text: 'Quote the price, 120, first.',
      rationale: 'Fast.',
      enrolledCount: 1,
      notEnrolledCount: 0,
      turnIds: [],
    },
  ],
});

function logs() {
  const lines: { fields: object; message: string }[] = [];
  const at = (fields: object, message: string) => lines.push({ fields, message });
  return { logger: { info: at, warn: at, error: at }, lines };
}

function job(
  contacts: ContactReader,
  model: MockLanguageModelV4 | undefined,
  opts: { logger?: ReturnType<typeof logs>['logger']; config?: TenantConfig; spec?: string } = {},
) {
  return new LearningJob({
    db,
    tenantId: TENANT,
    config: () => opts.config ?? tenant,
    contacts,
    analyst: model
      ? new Analyst({ model, modelSpec: opts.spec ?? 'anthropic:claude-haiku-4-5' })
      : undefined,
    logger: opts.logger ?? logs().logger,
    pace: () => Promise.resolve(),
  });
}

/* -------------------------------------------------------------------------- */

describe('the cohort is contacts who were offered, given time to pay (specs/031 V3)', () => {
  it('excludes the never offered, the offered over 90 days ago and the recently active', async () => {
    const tags = await seedCohort(20, 20, 'in');
    await seedContact('never-offered', { lastDays: 30 });
    await seedContact('offered-long-ago', { offeredDays: 120, lastDays: 100 });
    await seedContact('still-talking', { offeredDays: 30, lastDays: 3 });
    await seedContact('offer-failed', { lastDays: 30, actions: offered('failed') });
    const reader = new FakeTagReader(tags);
    const outcome = await job(reader, analystModel(goodAnswer).model).run(NOW);
    expect(new Set(reader.reads)).toEqual(new Set(tags.keys()));
    expect(outcome).toMatchObject({ status: 'insufficient', enrolled: 20, notEnrolled: 0 });
  });

  it('drops a contact whose read fails, rather than labelling it not enrolled', async () => {
    const tags = await seedCohort(41, 20);
    const reader = new FakeTagReader(tags, new Set(['lead-40']));
    const { model, calls } = analystModel(goodAnswer);
    const outcome = await job(reader, model).run(NOW);
    expect(outcome).toMatchObject({ status: 'completed', enrolled: 20, notEnrolled: 20 });
    expect(calls).toHaveLength(1);
  });

  it('with 19 contacts on a side the run is insufficient, and the analyst is never called', async () => {
    const tags = await seedCohort(39, 19);
    const { model, calls } = analystModel(goodAnswer);
    const outcome = await job(new FakeTagReader(tags), model).run(NOW);
    expect(outcome).toMatchObject({ status: 'insufficient', enrolled: 19, notEnrolled: 20 });
    expect(calls).toHaveLength(0);
    const [run] = await db.select().from(learningRuns);
    expect(run).toMatchObject({ status: 'insufficient', enrolledCount: 19, notEnrolledCount: 20 });
  });

  it('does not run without INSIGHT_MODEL or a learning block', async () => {
    const reader = new FakeTagReader(new Map());
    expect(await job(reader, undefined).run(NOW)).toEqual({ status: 'disabled' });
    expect(await job(reader, analystModel(goodAnswer).model, { config: fixture }).run(NOW)).toEqual(
      { status: 'disabled' },
    );
    expect(await db.select().from(learningRuns)).toHaveLength(0);
  });
});

describe('the analyst reads cleaned, fenced transcripts (specs/031 V4)', () => {
  it('receives an invented phone, email and URL removed, inside the fence', async () => {
    const tags = await seedCohort(40, 20);
    await db
      .update(turns)
      .set({ text: 'Reach me on +1 555 010 0199, lead@example.com or https://example.com/me' })
      .where(eq(turns.role, 'user'));
    const { model, calls } = analystModel(goodAnswer);
    await job(new FakeTagReader(tags), model).run(NOW);
    const sent = JSON.stringify(calls[0]!.prompt);
    // The whole number: a bare 555 can turn up in a random turn id.
    expect(sent).not.toMatch(/555 010 0199|lead@example\.com|https:\/\/example/);
    expect(sent).toContain('<<<CONTACT_MESSAGE>>>\\nReach me on [removed]');
  });
});

describe('proposals that fail the refusals are never stored (specs/031 V5)', () => {
  it('stores the tactic and refuses the price', async () => {
    const tags = await seedCohort(40, 20);
    const outcome = await job(new FakeTagReader(tags), analystModel(goodAnswer).model).run(NOW);
    expect(outcome.status).toBe('completed');
    const stored = await db.select().from(insightProposals);
    expect(stored.map(proposal => proposal.text)).toEqual([TACTIC]);
  });

  it('records schema-invalid output as failed, with no proposal and its cost', async () => {
    const tags = await seedCohort(40, 20);
    const { model } = analystModel(() => ({ proposals: [{ text: 'missing fields' }] }));
    const outcome = await job(new FakeTagReader(tags), model).run(NOW);
    expect(outcome.status).toBe('failed');
    expect(await db.select().from(insightProposals)).toHaveLength(0);
    const [run] = await db.select().from(learningRuns);
    expect(Number(run!.costUsd)).toBeGreaterThan(0);
  });
});

describe('no transcript text reaches a proposal row or a log line (specs/031 V6)', () => {
  it('stores ids and the analyst’s words, and logs counts and statuses', async () => {
    const tags = await seedCohort(40, 20);
    const { logger, lines } = logs();
    await job(new FakeTagReader(tags), analystModel(goodAnswer).model, { logger }).run(NOW);
    const [proposal] = await db.select().from(insightProposals);
    const row = JSON.stringify(proposal);
    expect(row).not.toMatch(/beginner|think about it|weekend course/i);
    expect(proposal!.turnIds).toHaveLength(2);
    const logged = JSON.stringify(lines);
    expect(lines.length).toBeGreaterThan(0);
    expect(logged).not.toMatch(/beginner|think about it|weekend course/i);
    expect(logged).not.toContain(TACTIC);
    expect(logged).not.toContain(RATIONALE);
    expect(logged).toContain('"status":"completed"');
  });
});

describe('only an approved, active version reaches a prompt (specs/031 V7)', () => {
  it('keeps pending and rejected proposals out, and an approved one out until it is active', async () => {
    const tags = await seedCohort(40, 20);
    const answer = (ids: string[]) => ({
      proposals: [
        {
          text: TACTIC,
          rationale: RATIONALE,
          enrolledCount: 9,
          notEnrolledCount: 2,
          turnIds: ids.slice(0, 1),
        },
        {
          text: 'Send the brochure only after a question.',
          rationale: RATIONALE,
          enrolledCount: 4,
          notEnrolledCount: 1,
          turnIds: [],
        },
        {
          text: 'Offer the call back before the link.',
          rationale: RATIONALE,
          enrolledCount: 3,
          notEnrolledCount: 2,
          turnIds: [],
        },
      ],
    });
    await job(new FakeTagReader(tags), analystModel(answer).model).run(NOW);
    const store = new LearningStore(db);
    const [approve, reject] = await store.pendingProposals(TENANT);
    await store.reject(TENANT, reject!.id);
    const candidate = await store.approve(TENANT, approve!.id);

    const source = new PlaybookSource({
      reader: store,
      tenantId: TENANT,
      logger: { info: () => {}, warn: () => {} },
    });
    const systemNow = async () => {
      await source.refresh();
      const { model, calls } = mockModel({
        messages: ['Hi.'],
        escalate: false,
        escalation_reason: null,
        confidence: 0.9,
        closing_question: null,
      });
      await new GenerateTextRunner({
        model,
        modelSpec: 'mock:test',
        config: () => tenant,
        maxOutputTokens: 400,
        temperature: 0,
        playbook: source,
      }).run({ text: 'hello', history: [] });
      return JSON.stringify(calls[0]!.prompt);
    };

    const before = await systemNow();
    for (const text of [TACTIC, 'Send the brochure', 'Offer the call back']) {
      expect(before).not.toContain(text);
    }
    await store.activate(TENANT, candidate.id);
    const after = await systemNow();
    expect(after).toContain(TACTIC);
    expect(after).not.toContain('Send the brochure');
    expect(after).not.toContain('Offer the call back');
  });

  it('refuses an edit that states a fact, and a version over the bounds', async () => {
    const store = new LearningStore(db);
    const [run] = await db
      .insert(learningRuns)
      .values({ tenantId: TENANT, week: '2026-W41' })
      .returning();
    await store.addProposals(TENANT, run!.id, [
      { text: TACTIC, rationale: RATIONALE, enrolledCount: 1, notEnrolledCount: 0, turnIds: [] },
    ]);
    const [pending] = await store.pendingProposals(TENANT);
    await expect(store.approve(TENANT, pending!.id, 'Say it costs 99.')).rejects.toThrow(
      ReviewError,
    );
    await expect(
      store.createVersion(
        TENANT,
        Array.from({ length: 11 }, (_unused, index) => `Tactic ${'abcdefghijk'[index]}.`),
      ),
    ).rejects.toThrow(/at most 10 insights/);
  });
});

describe('insights:review and insights:activate (specs/031 V7, V8)', () => {
  /** Answers each question in turn, and records what was printed. */
  function scripted(answers: string[]): ReviewIo & { printed: string[] } {
    const printed: string[] = [];
    return {
      printed,
      print: line => printed.push(line),
      ask: () => Promise.resolve(answers.shift() ?? ''),
    };
  }

  it('builds one candidate from a review, and activates it once its eval shows no regression', async () => {
    const tags = await seedCohort(40, 20);
    const answer = (ids: string[]) => ({
      proposals: [
        {
          text: TACTIC,
          rationale: RATIONALE,
          enrolledCount: 9,
          notEnrolledCount: 2,
          turnIds: ids.slice(0, 1),
        },
        {
          text: 'Send the brochure only after a question.',
          rationale: RATIONALE,
          enrolledCount: 4,
          notEnrolledCount: 1,
          turnIds: [],
        },
      ],
    });
    await job(new FakeTagReader(tags), analystModel(answer).model).run(NOW);

    const io = scripted(['a', 'e', 'Send the brochure once they ask about content.', '']);
    expect(await review(db, TENANT, io)).toEqual({ approved: 2, rejected: 0, retired: 0 });
    // The cited turn is printed from the database to the reviewer.
    expect(io.printed.join('\n')).toContain('Which course suits a beginner?');
    const store = new LearningStore(db);
    const versions = await store.versions(TENANT);
    const candidate = versions.at(-1)!;
    expect(candidate.insights).toEqual([TACTIC, 'Send the brochure once they ask about content.']);

    expect((await activate(db, TENANT, candidate.id, 'suite')).message).toMatch(/no eval record/);
    const outcomes = { greeting: 'passed' as const, price: 'failed' as const };
    await store.recordEval(TENANT, {
      playbookHash: NO_PLAYBOOK,
      suiteHash: 'suite',
      model: 'anthropic:claude-haiku-4-5',
      outcomes,
    });
    await store.recordEval(TENANT, {
      playbookHash: candidate.contentHash,
      suiteHash: 'suite',
      model: 'anthropic:claude-haiku-4-5',
      outcomes,
    });
    const done = await activate(db, TENANT, candidate.id.slice(0, 8), 'suite');
    expect(done).toMatchObject({ ok: true });
    expect((await store.activeVersion(TENANT))?.id).toBe(candidate.id);

    // Retiring builds the next candidate; rolling back to the first skips the gate.
    const retired = scripted(['1', '']);
    expect((await review(db, TENANT, retired)).retired).toBe(1);
    const next = (await store.versions(TENANT)).at(-1)!;
    expect(next.insights).toEqual(['Send the brochure once they ask about content.']);
    expect((await activate(db, TENANT, next.id, 'suite')).ok).toBe(false);
  });

  it('rolls back to a version that was active before without an eval', async () => {
    const store = new LearningStore(db);
    const first = await store.createVersion(TENANT, [TACTIC]);
    const second = await store.createVersion(TENANT, [TACTIC, 'Ask about their schedule.']);
    await store.activate(TENANT, first.id);
    await store.activate(TENANT, second.id);
    expect(await activate(db, TENANT, first.id, 'suite')).toMatchObject({
      ok: true,
      message: expect.stringMatching(/rolled back/),
    });
    expect((await store.activeVersion(TENANT))?.id).toBe(first.id);
  });
});

describe('every agent turn records its playbook version (specs/031 V11)', () => {
  it('writes the version on agent turns, and null with none active', async () => {
    const store = new ConversationStore(db);
    const [conversation] = await db
      .insert(conversations)
      .values({ tenantId: TENANT, subscriberId: 'v11', channel: 'whatsapp' })
      .returning();
    await store.recordAgentReply(conversation!.id, 'Hi.', 'answered_inline', {
      bound: true,
      usage: { model: 'mock:test', playbookVersion: 'version-9' },
    });
    await store.recordAgentReply(conversation!.id, 'Hi again.', 'answered_inline', {
      bound: true,
      usage: { model: 'mock:test', playbookVersion: null },
    });
    const rows = await db
      .select({ version: turns.playbookVersion })
      .from(turns)
      .where(eq(turns.conversationId, conversation!.id))
      .orderBy(turns.seq);
    expect(rows.map(row => row.version)).toEqual(['version-9', null]);
  });

  it('reports the enrolment rate per version a contact was first offered under', async () => {
    const tags = await seedCohort(4, 1);
    await db.execute(sql`update turns set playbook_version = 'version-9' where role = 'agent'`);
    await seedContact('before-playbook', { offeredDays: 40, lastDays: 30 });
    tags.set('before-playbook', ['enrolled']);
    const rates = await report(db, TENANT, tenant, new FakeTagReader(tags), NOW, () =>
      Promise.resolve(),
    );
    expect(rates).toEqual(
      expect.arrayContaining([
        { version: 'version-9', contacts: 4, enrolled: 1 },
        { version: null, contacts: 1, enrolled: 1 },
      ]),
    );
  });
});

describe('the weekly claim runs one analyst call per tenant and week (specs/031 V12)', () => {
  it('two concurrent claims make exactly one call', async () => {
    const tags = await seedCohort(40, 20);
    const { model, calls } = analystModel(goodAnswer);
    const outcomes = await Promise.all([
      job(new FakeTagReader(tags), model).run(NOW),
      job(new FakeTagReader(tags), model).run(NOW),
    ]);
    expect(outcomes.map(outcome => outcome.status).sort()).toEqual(['claimed', 'completed']);
    expect(calls).toHaveLength(1);
    // A forced run is a second, recorded one.
    const forced = await job(new FakeTagReader(tags), model).run(NOW, { forced: true });
    expect(forced.status).toBe('completed');
    expect(calls).toHaveLength(2);
    const runs = await db.select().from(learningRuns);
    expect(runs.map(run => run.forced).sort()).toEqual([false, true]);
  });
});

describe('a run’s cost is its own (specs/031 V13)', () => {
  it('is recorded on the run and never added to budget_counters', async () => {
    const tags = await seedCohort(40, 20);
    await job(new FakeTagReader(tags), analystModel(goodAnswer).model).run(NOW);
    const [run] = await db.select().from(learningRuns);
    expect(run!.status).toBe('completed');
    expect(Number(run!.costUsd)).toBeGreaterThan(0);
    expect(await db.select().from(budgetCounters)).toHaveLength(0);
  });

  it('a run that cannot fit with twenty a side is skipped_budget and makes no call', async () => {
    const tags = await seedCohort(40, 20);
    const { model, calls } = analystModel(goodAnswer);
    const poor = {
      ...tenant,
      rules: { ...tenant.rules, learning: { ...LEARNING, maxRunCostUsd: 0.0001 } },
    };
    const outcome = await job(new FakeTagReader(tags), model, { config: poor }).run(NOW);
    expect(outcome.status).toBe('skipped_budget');
    expect(calls).toHaveLength(0);
  });
});

describe('the insights commands and the process wiring (specs/031 V12)', () => {
  const ciEnv = {
    AGENT_MODEL: 'mock:demo',
    PUBLIC_BASE_URL: 'https://ci.example.com',
    MANYCHAT_SHARED_SECRET: 'ci-secret-ci-secret-ci-secret-xx',
    DATABASE_URL: 'pglite',
  };
  let dir: string;
  let printed: string[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'learning-tenant-'));
    cpSync('test/fixtures/config', dir, { recursive: true });
    const rules = JSON.parse(readFileSync(join(dir, 'rules.json'), 'utf8'));
    writeFileSync(join(dir, 'rules.json'), JSON.stringify({ ...rules, learning: LEARNING }));
    for (const [name, value] of Object.entries(ciEnv)) vi.stubEnv(name, value);
    vi.stubEnv('CONFIG_DIR', dir);
    vi.stubEnv('INSIGHT_MODEL', '');
    printed = [];
    const capture = (...parts: unknown[]) => void printed.push(parts.join(' '));
    vi.spyOn(console, 'log').mockImplementation(capture);
    vi.spyOn(console, 'error').mockImplementation(capture);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('prints usage for no command or an unknown one', async () => {
    expect(await runInsights([])).toBe(2);
    expect(await runInsights(['remember'])).toBe(2);
    expect(printed.join('\n')).toContain('Usage: insights <command>');
  });

  it('refuses a tenant without a learning block', async () => {
    vi.stubEnv('CONFIG_DIR', 'test/fixtures/config');
    expect(await runInsights(['report'])).toBe(1);
    expect(printed.join('\n')).toMatch(/no "learning" block/);
  });

  it('runs without INSIGHT_MODEL only to say it does not', async () => {
    expect(await runInsights(['run'])).toBe(1);
    expect(printed.join('\n')).toMatch(/INSIGHT_MODEL is unset/);
  });

  it('runs this week’s job with an analyst, and says when the week is taken', async () => {
    vi.stubEnv('INSIGHT_MODEL', 'mock:demo');
    expect(await runInsights(['run'])).toBe(0);
    expect(printed.join('\n')).toMatch(/: insufficient/);
  });

  it('activates nothing it cannot name, and reports with its header', async () => {
    expect(await runInsights(['activate'])).toBe(2);
    expect(await runInsights(['activate', 'nothing'])).toBe(1);
    expect(printed.join('\n')).toMatch(/no single playbook version matches nothing/);
    expect(await runInsights(['report'])).toBe(0);
    expect(printed.join('\n')).toContain('Before and after, not controlled');
    expect(printed.join('\n')).toContain('No settled contacts were offered');
  });

  it('the agent CLI runs the same commands', async () => {
    expect(await run(['node', 'agent', 'insights', 'run'])).toBe(1);
    expect(printed.join('\n')).toMatch(/INSIGHT_MODEL is unset/);
  });

  it('loads no playbook without a learning block, and starts and stops with one', async () => {
    const env = loadEnv();
    const logger = logs().logger;
    expect(playbookSource(db, env, fixture, logger)).toBeUndefined();
    const store = new LearningStore(db);
    const version = await store.createVersion(env.TENANT_ID, [TACTIC]);
    await store.activate(env.TENANT_ID, version.id);
    const source = playbookSource(db, env, tenant, logger)!;
    vi.stubEnv('INSIGHT_MODEL', 'mock:demo');
    const stop = await startLearning({
      db,
      env: loadEnv(),
      config: () => tenant,
      contacts: new FakeTagReader(new Map()),
      logger,
      playbook: source,
    });
    expect(source.current()?.id).toBe(version.id);
    await stop();
  });

  it('checks on a timer whether the week’s run is still to claim', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const tags = await seedCohort(1, 0);
      const reader = new FakeTagReader(tags);
      const stop = job(reader, analystModel(goodAnswer).model).start(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      await stop();
      expect(reader.reads).toEqual(['lead-0']);
      const [run] = await db.select().from(learningRuns);
      expect(run?.status).toBe('insufficient');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a stop ends a run in flight, recorded failed, rather than waiting it out', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      await seedCohort(2, 1);
      const reads: string[] = [];
      // A read that answers only when it is aborted, as a hung ManyChat call would.
      const hanging: ContactReader = {
        readContact: (subscriberId, signal) => {
          reads.push(subscriberId);
          return new Promise((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(new Error('aborted'))),
          );
        },
      };
      const { logger, lines } = logs();
      const stop = job(hanging, analystModel(goodAnswer).model, { logger }).start(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      for (let tries = 0; reads.length === 0 && tries < 100; tries++) {
        await new Promise(resolve => setImmediate(resolve));
      }
      await stop();
      expect(reads).toHaveLength(1);
      const [run] = await db.select().from(learningRuns);
      expect(run?.status).toBe('failed');
      expect(run?.finishedAt).not.toBeNull();
      // The row still holds the week, so the forfeit is said out loud.
      expect(lines.map(line => line.message)).toContain(
        'learning run stopped by shutdown; this week has no run until insights:run --force',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens and migrates the database a command names', async () => {
    const opened = await openDatabase(loadEnv());
    expect(await new LearningStore(opened).activeVersion('demo')).toBeUndefined();
  });
});
