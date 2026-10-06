import { describe, it, expect, afterEach, vi } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { ConfigError, loadTenantConfig } from '../../src/config/loader.ts';
import type { TenantConfig } from '../../src/config/loader.ts';
import { buildSystemPrompt } from '../../src/agent/prompt.ts';
import { GenerateTextRunner } from '../../src/agent/runner.ts';
import { ActionStage, buildTools } from '../../src/agent/tools.ts';
import { FENCE, FENCE_END } from '../../src/agent/fence.ts';
import { NO_TOOLS } from '../../src/contracts/config.ts';
import type { AnalystProposal } from '../../src/contracts/learning.ts';
import {
  acceptProposals,
  insightRefusal,
  MAX_PROPOSALS_PER_RUN,
  proposalRefusal,
} from '../../src/learning/proposals.ts';
import {
  MAX_PLAYBOOK_CHARS,
  MAX_PLAYBOOK_INSIGHTS,
  PLAYBOOK_REFRESH_MS,
  PlaybookSource,
  playbookRefusal,
} from '../../src/learning/playbook.ts';
import type { ActivePlaybook } from '../../src/learning/playbook.ts';
import {
  analystMessage,
  fitToBudget,
  MIN_PER_SIDE,
  renderTranscript,
  worstCaseUsd,
} from '../../src/learning/analyst.ts';
import type { AnalystInput, Transcript } from '../../src/learning/analyst.ts';
import { activationGate, NO_PLAYBOOK } from '../../src/learning/gate.ts';
import type { EvalRecord, PlaybookVersion } from '../../src/learning/store.ts';
import { isoWeek } from '../../src/learning/store.ts';
import { mockModel } from '../helpers/model.ts';

/**
 * specs/031-learning-from-outcomes.md § Verification. Every transcript,
 * tactic, phone number and address here is invented (C1).
 */

const FIXTURE = 'test/fixtures/config';
const fixture = loadTenantConfig(FIXTURE);
const LEARNING = { language: 'English', enrolledTag: 'enrolled', maxRunCostUsd: 5 };
const withLearning: TenantConfig = {
  ...fixture,
  rules: { ...fixture.rules, learning: LEARNING },
};

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const remove of cleanup) remove();
  cleanup = [];
  vi.useRealTimers();
});

/** A copy of the fixture tenant whose rules.json and tools.json are edited. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- edited JSON of any shape
type Json = Record<string, any>;

function tenantDir(edit: { rules?: (rules: Json) => void; tools?: (tools: Json) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'learning-config-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(FIXTURE, dir, { recursive: true });
  for (const [file, change] of [
    ['rules.json', edit.rules],
    ['tools.json', edit.tools],
  ] as const) {
    if (!change) continue;
    const json = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    change(json);
    writeFileSync(join(dir, file), JSON.stringify(json));
  }
  return dir;
}

const playbook = (insights: string[], id = 'version-1'): ActivePlaybook => ({
  id,
  contentHash: `hash-of-${id}`,
  insights,
});

/** The system prompt and messages one runner turn sends to the model. */
async function promptOf(config: TenantConfig, source?: { current(): ActivePlaybook | undefined }) {
  const { model, calls } = mockModel({
    messages: ['Hello there.'],
    escalate: false,
    escalation_reason: null,
    confidence: 0.9,
    closing_question: null,
  });
  const runner = new GenerateTextRunner({
    model,
    modelSpec: 'mock:test',
    config: () => config,
    maxOutputTokens: 400,
    temperature: 0,
    playbook: source,
  });
  const result = await runner.run({ text: 'hello', history: [] });
  const prompt = (calls[0] as LanguageModelV4CallOptions).prompt;
  const system = prompt
    .filter(message => message.role === 'system')
    .map(message => message.content)
    .join('');
  const rest = JSON.stringify(prompt.filter(message => message.role !== 'system'));
  return { system, rest, result };
}

/* -------------------------------------------------------------------------- */

describe('learning is opt-in, and costs nothing when off (specs/031 V1)', () => {
  it('refuses a learning block without a funnel field', () => {
    const dir = tenantDir({
      rules: rules => (rules.learning = LEARNING),
      tools: tools => {
        tools.fields = tools.fields.filter((field: { funnel?: boolean }) => !field.funnel);
        tools.flows = tools.flows.filter((flow: { onStage?: string }) => !flow.onStage);
        tools.events = [];
      },
    });
    expect(() => loadTenantConfig(dir)).toThrow(ConfigError);
    expect(() => loadTenantConfig(dir)).toThrow(/learning: needs a field marked "funnel"/);
  });

  it('refuses a learning block without maxRunCostUsd', () => {
    const dir = tenantDir({
      rules: rules => (rules.learning = { language: 'English', enrolledTag: 'enrolled' }),
    });
    expect(() => loadTenantConfig(dir)).toThrow(/learning\.maxRunCostUsd/);
  });

  it('loads a complete learning block', () => {
    const dir = tenantDir({ rules: rules => (rules.learning = LEARNING) });
    expect(loadTenantConfig(dir).rules.learning).toEqual(LEARNING);
  });

  it('without learning, the system prompt is byte-identical to one built before the spec', async () => {
    const before = buildSystemPrompt(
      fixture.persona,
      fixture.catalog,
      fixture.rules,
      fixture.tools ?? NO_TOOLS,
    );
    // Even with a version loaded, a tenant without `learning` renders none.
    const { system, result } = await promptOf(fixture, {
      current: () => playbook(['Ask which course they want before naming any.']),
    });
    expect(system).toBe(`${before.staticPrefix}\n\n${before.catalogBlock}`);
    expect(result.playbookVersion).toBeNull();
  });
});

describe('the agent never writes to the playbook (specs/031 V2)', () => {
  it('no tool, on any turn, offers a write to the playbook', () => {
    const tools = fixture.tools ?? NO_TOOLS;
    for (const nudgeTurn of [false, true]) {
      const built = buildTools(tools, new ActionStage(), undefined, undefined, { nudgeTurn })!;
      const surface = JSON.stringify(
        Object.entries(built).map(([name, tool]) => ({
          name,
          description: tool.description,
          schema: (tool.inputSchema as { toJSONSchema?: () => unknown }).toJSONSchema?.() ?? null,
        })),
      );
      expect(surface).not.toMatch(/playbook|insight|tactic|remember|lesson/i);
    }
  });
});

describe('the analyst reads cleaned transcripts, fenced as untrusted (specs/031 V4)', () => {
  const turns = [
    {
      id: 'turn-a',
      role: 'user' as const,
      text: 'Call me on +1 555 010 0199 or write to lead@example.com, see https://example.com/me',
      actions: null,
    },
    {
      id: 'turn-b',
      role: 'agent' as const,
      text: 'Thanks! Which course are you\nweighing?',
      actions: [
        {
          tool: 'set_field' as const,
          id: 'funnel_stage',
          value: 'offered',
          status: 'performed' as const,
        },
      ],
    },
  ];

  it('removes identifier shapes, fences the contact and labels the transcript', () => {
    const transcript = renderTranscript('enrolled', turns);
    expect(transcript.text).not.toMatch(/555|lead@example\.com|https?:/);
    expect(transcript.text).toContain('[removed]');
    const fenced = transcript.text.slice(
      transcript.text.indexOf(FENCE),
      transcript.text.indexOf(FENCE_END) + FENCE_END.length,
    );
    expect(fenced).toContain('Call me on [removed]');
    expect(transcript.text).toContain('TRANSCRIPT (enrolled)');
    expect(transcript.text).toContain('agent (actions: set_field funnel_stage=offered)');
    expect(transcript.text).toContain('weighing?');
    expect(transcript.turnIds).toEqual(['turn-a', 'turn-b']);
  });

  it('the message the analyst reads carries the transcripts as rendered', () => {
    const message = analystMessage({
      language: 'English',
      playbook: [],
      rejected: ['Offer a gift to anyone who hesitates.'],
      enrolled: [renderTranscript('enrolled', turns)],
      notEnrolled: [],
    });
    expect(message).not.toMatch(/555|lead@example\.com/);
    expect(message).toContain('REJECTED, DO NOT PROPOSE AGAIN\n- Offer a gift');
  });
});

describe('a proposal is a tactic, never a fact (specs/031 V5)', () => {
  const known = new Set(['turn-a', 'turn-b']);
  const proposal = (over: Partial<AnalystProposal> = {}): AnalystProposal => ({
    text: 'Ask what the contact wants to learn before sending any course content.',
    rationale: 'Enrolled contacts were asked about their goal early.',
    enrolledCount: 9,
    notEnrolledCount: 2,
    turnIds: ['turn-a'],
    ...over,
  });

  it('accepts a tactic in words', () => {
    expect(proposalRefusal(proposal(), known)).toBeUndefined();
  });

  it.each([
    ['a digit', { text: 'Mention the course costs 120.' }, /digit or a currency/],
    ['a digit in another script', { text: 'Offer it within ٣ days.' }, /digit or a currency/],
    ['a currency symbol', { text: 'Say it is under €.' }, /digit or a currency/],
    ['a digit in the rationale', { rationale: 'Seen on 3 calls.' }, /rationale holds a digit/],
    ['a link', { text: 'Send them to www.example.com first.' }, /link, an email/],
    ['an unknown turn', { turnIds: ['turn-z'] }, /not in its input/],
    ['text over 280 characters', { text: 'a'.repeat(281) }, /over 280/],
    ['a rationale over 500 characters', { rationale: 'b'.repeat(501) }, /over 500/],
  ])('refuses %s', (_name, over, reason) => {
    expect(proposalRefusal(proposal(over), known)).toMatch(reason);
  });

  it('keeps at most five proposals: a sixth is dropped', () => {
    const six = Array.from({ length: MAX_PROPOSALS_PER_RUN + 1 }, (_unused, index) =>
      proposal({ text: `Tactic ${'abcdef'[index]}: ask before offering.` }),
    );
    const { accepted, dropped } = acceptProposals(six, known);
    expect(accepted).toHaveLength(MAX_PROPOSALS_PER_RUN);
    expect(dropped).toBe(1);
    expect(accepted.map(kept => kept.text)).not.toContain(six[5]!.text);
  });

  it('a reviewer’s edit passes the same refusals', () => {
    expect(insightRefusal('Name the price, 99, early.')).toMatch(/digit/);
    expect(insightRefusal('   ')).toMatch(/empty/);
    expect(insightRefusal('Ask about their schedule first.')).toBeUndefined();
  });
});

describe('the playbook is bounded, and renders after the catalog (specs/031 V9)', () => {
  it('refuses a version over the insight or character limit', () => {
    expect(
      playbookRefusal(Array.from({ length: MAX_PLAYBOOK_INSIGHTS + 1 }, () => 'Ask first.')),
    ).toMatch(/at most 10 insights/);
    expect(playbookRefusal(['x'.repeat(MAX_PLAYBOOK_CHARS + 1)])).toMatch(/2000 characters/);
    expect(playbookRefusal(Array.from({ length: 10 }, () => 'y'.repeat(200)))).toBeUndefined();
  });

  it('renders inside the system prompt, after the catalog block, never in the messages', async () => {
    const tactic = 'Ask what the contact wants to learn before naming a course.';
    const { system, rest, result } = await promptOf(withLearning, {
      current: () => playbook([tactic], 'version-7'),
    });
    const catalogAt = system.indexOf('CATALOG (');
    const playbookAt = system.indexOf('PLAYBOOK\n');
    expect(catalogAt).toBeGreaterThan(-1);
    expect(playbookAt).toBeGreaterThan(catalogAt);
    expect(system.endsWith(`- ${tactic}`)).toBe(true);
    expect(system).toContain('tactic conflicts with any rule above, the rule wins.');
    expect(rest).not.toContain(tactic);
    expect(result.playbookVersion).toBe('version-7');
  });
});

describe('each process refreshes the active version on a timer (specs/031 V10)', () => {
  const logger = { info: () => {}, warn: vi.fn() };

  it('picks up an activation within 60 seconds', async () => {
    vi.useFakeTimers();
    let active: ActivePlaybook | undefined = undefined;
    const source = new PlaybookSource({
      reader: { activePlaybook: () => Promise.resolve(active) },
      tenantId: 'demo',
      logger,
    });
    await source.refresh();
    const stop = source.start();
    expect(source.current()).toBeUndefined();
    active = playbook(['Ask first.'], 'version-2');
    await vi.advanceTimersByTimeAsync(PLAYBOOK_REFRESH_MS);
    expect(source.current()?.id).toBe('version-2');
    stop();
  });

  it('keeps the loaded version when a refresh fails, and starts with none when the boot load fails', async () => {
    let failing = true;
    const source = new PlaybookSource({
      reader: {
        activePlaybook: () =>
          failing ? Promise.reject(new Error('db down')) : Promise.resolve(playbook(['Ask.'])),
      },
      tenantId: 'demo',
      logger,
    });
    await source.refresh();
    expect(source.current()).toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
    failing = false;
    await source.refresh();
    failing = true;
    await source.refresh();
    expect(source.current()?.id).toBe('version-1');
  });

  it('a turn never waits for a refresh', async () => {
    const source = new PlaybookSource({
      // A database that never answers.
      reader: { activePlaybook: () => new Promise(() => {}) },
      tenantId: 'demo',
      logger,
    });
    void source.refresh();
    const { result } = await promptOf(withLearning, source);
    expect(result.reply.messages).toEqual(['Hello there.']);
    expect(result.playbookVersion).toBeNull();
  });
});

describe('a run is priced before it is sent (specs/031 V13)', () => {
  const transcript = (label: 'enrolled' | 'not_enrolled', index: number): Transcript => ({
    label,
    turnIds: [`${label}-${index}`],
    text: `TRANSCRIPT (${label}) ${index} ${'words '.repeat(400)}`,
  });
  const input = (perSide: number): AnalystInput => ({
    language: 'English',
    playbook: [],
    rejected: [],
    enrolled: Array.from({ length: perSide }, (_unused, index) => transcript('enrolled', index)),
    notEnrolled: Array.from({ length: perSide }, (_unused, index) =>
      transcript('not_enrolled', index),
    ),
  });
  const spec = 'anthropic:claude-haiku-4-5';

  it('drops the oldest transcript from each side in turn until it fits', () => {
    const full = input(30);
    const limit = worstCaseUsd(spec, input(25));
    const fitted = fitToBudget(spec, full, limit)!;
    expect(fitted.enrolled).toHaveLength(25);
    expect(fitted.notEnrolled).toHaveLength(25);
    // Newest first: the ones dropped are the last.
    expect(fitted.enrolled.at(-1)!.turnIds).toEqual(['enrolled-24']);
    expect(worstCaseUsd(spec, fitted)).toBeLessThanOrEqual(limit);
  });

  it('is skipped when it cannot fit with twenty a side', () => {
    const limit = worstCaseUsd(spec, input(MIN_PER_SIDE)) / 2;
    expect(fitToBudget(spec, input(30), limit)).toBeUndefined();
  });

  it('keys the weekly claim on the ISO week', () => {
    expect(isoWeek(new Date('2026-10-06T12:00:00Z'))).toBe('2026-W41');
    expect(isoWeek(new Date('2027-01-01T12:00:00Z'))).toBe('2026-W53');
  });
});

describe('a version goes live only after a real-model eval shows no regression (specs/031 V8)', () => {
  const SUITE = 'suite-now';
  const version = (over: Partial<PlaybookVersion> = {}): PlaybookVersion => ({
    id: 'candidate',
    contentHash: 'hash-candidate',
    insights: ['Ask first.'],
    active: false,
    activatedAt: null,
    createdAt: new Date(),
    ...over,
  });
  const record = (
    playbookHash: string,
    outcomes: Record<string, 'passed' | 'failed' | 'reviewed'>,
    over: Partial<EvalRecord> = {},
  ): EvalRecord => ({
    playbookHash,
    suiteHash: SUITE,
    model: 'anthropic:claude-haiku-4-5',
    outcomes,
    createdAt: new Date(),
    ...over,
  });
  const gate = (records: EvalRecord[], active?: PlaybookVersion) =>
    activationGate({ candidate: version(), active, suiteHash: SUITE, records });

  it('refuses with no eval record', () => {
    expect(gate([])).toMatchObject({ ok: false, reason: expect.stringMatching(/no eval record/) });
  });

  it('refuses with only a mock-model record', () => {
    const mock = record('hash-candidate', { greeting: 'passed' }, { model: 'mock:demo' });
    expect(gate([mock, record(NO_PLAYBOOK, { greeting: 'passed' })])).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/only a mock-model/),
    });
  });

  it('refuses with a record for another content hash or another suite', () => {
    expect(gate([record('hash-other', { greeting: 'passed' })]).ok).toBe(false);
    const stale = record('hash-candidate', { greeting: 'passed' }, { suiteHash: 'suite-before' });
    expect(gate([stale, record(NO_PLAYBOOK, { greeting: 'passed' })])).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/against the current suite/),
    });
  });

  it('refuses a new asserted failure, and ignores one the baseline shares', () => {
    const baseline = record(NO_PLAYBOOK, {
      greeting: 'passed',
      price: 'failed',
      closer: 'reviewed',
    });
    expect(
      gate([
        record('hash-candidate', { greeting: 'failed', price: 'failed', closer: 'reviewed' }),
        baseline,
      ]),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/: greeting$/),
    });
    expect(
      gate([
        record('hash-candidate', { greeting: 'passed', price: 'failed', closer: 'passed' }),
        baseline,
      ]),
    ).toEqual({
      ok: true,
      reason: 'no_regression',
    });
  });

  it('compares a first activation against the no-playbook record, and refuses without one', () => {
    expect(gate([record('hash-candidate', { greeting: 'passed' })])).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/the prompt with no playbook.*run pnpm eval$/),
    });
  });

  it('compares against the active version, and names its eval when it has no record', () => {
    const active = version({
      id: 'live',
      contentHash: 'hash-live',
      active: true,
      activatedAt: new Date(),
    });
    const own = record('hash-candidate', { greeting: 'passed' });
    expect(gate([own, record(NO_PLAYBOOK, { greeting: 'passed' })], active)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/active version live.*PLAYBOOK_VERSION=live pnpm eval/),
    });
    expect(gate([own, record('hash-live', { greeting: 'passed' })], active).ok).toBe(true);
  });

  it('accepts a version that was active before, without a record', () => {
    expect(
      activationGate({
        candidate: version({ activatedAt: new Date('2026-09-01') }),
        active: undefined,
        suiteHash: SUITE,
        records: [],
      }),
    ).toEqual({ ok: true, reason: 'rollback' });
  });
});
