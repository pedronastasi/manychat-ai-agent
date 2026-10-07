import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4CallOptions, LanguageModelV4Content } from '@ai-sdk/provider';
import { createTestDatabase } from '../helpers/db.ts';
import { FakeActions, FakeContactFields } from '../helpers/manychat.ts';
import { EXAMPLE_READ_PLUGIN, tenantProject } from '../helpers/plugins.ts';
import type { Database } from '../../src/db/client.ts';
import { TurnHandler } from '../../src/routes/turn.ts';
import { GenerateTextRunner } from '../../src/agent/runner.ts';
import { MAX_STEPS } from '../../src/agent/tools.ts';
import { FENCE } from '../../src/agent/prompt.ts';
import { loadTenantConfig } from '../../src/config/loader.ts';
import { NO_TOOLS } from '../../src/contracts/config.ts';
import type { InboundMessage } from '../../src/contracts/agent.ts';
import { loadPlugins } from '../../src/plugins/loader.ts';
import type { Plugins, HostLogger } from '../../src/plugins/plugins.ts';

/**
 * specs/039-plugin-reads-return-declared-data.md § Verification: the invented
 * read plugin, loaded from a stand-in tenant project, is called by a model at
 * the provider boundary through the real runner, turn handler and outbox.
 */

// The fixture tenant without its tools.json: only the plugin offers a tool.
const tenant = { ...loadTenantConfig('test/fixtures/config'), tools: NO_TOOLS };

let plugins: Plugins;
let removeProject: () => void;
beforeAll(async () => {
  const project = tenantProject([EXAMPLE_READ_PLUGIN], {
    [EXAMPLE_READ_PLUGIN]: EXAMPLE_READ_PLUGIN,
  });
  removeProject = project.remove;
  plugins = await loadPlugins(project.configDir);
});
afterAll(() => removeProject());

let db: Database;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
});
afterEach(async () => {
  await close();
});

/** Counts the plugin's own reads, which it reports through the logger it is given. */
function journal() {
  let reads = 0;
  const at = (_fields: object, message: string) => {
    if (message === 'availability read') reads++;
  };
  const logger: HostLogger = { info: at, warn: at, error: at };
  return { logger, reads: () => reads };
}

const readCall = (step: number): LanguageModelV4Content => ({
  type: 'tool-call',
  toolCallId: `read-${step}`,
  toolName: 'class_availability',
  input: JSON.stringify({ course: 'foundation' }),
});

const ANSWER = {
  messages: ['There are four seats left, and the next intake starts next month.'],
  escalate: false,
  escalation_reason: null,
  confidence: 0.9,
  closing_question: 'Shall I keep one for you?',
};

/**
 * Calls the read on every step that offers tools, and answers on the reply
 * step, which offers none. `delays` holds a step's wait before it answers.
 */
function model(delays: Record<number, number> = {}) {
  const calls: LanguageModelV4CallOptions[] = [];
  const mock = new MockLanguageModelV4({
    doGenerate: async (options: LanguageModelV4CallOptions) => {
      const step = calls.length;
      calls.push(options);
      const delay = delays[step];
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      const reads = (options.tools ?? []).length > 0;
      return {
        content: reads ? [readCall(step)] : [{ type: 'text', text: JSON.stringify(ANSWER) }],
        finishReason: reads
          ? { unified: 'tool-calls' as const, raw: 'tool_use' }
          : { unified: 'stop' as const, raw: 'end_turn' },
        usage: {
          inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 20, text: 20, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  return { model: mock, calls };
}

const inbound = (text: string): InboundMessage => ({
  tenantId: 'demo',
  subscriberId: '5550000000039',
  text,
  channel: 'whatsapp',
  contactName: null,
  locale: null,
  contactToken: null,
  receivedAt: new Date(),
});

function handler(
  languageModel: MockLanguageModelV4,
  logger: HostLogger,
  opts: { raceDeadlineMs?: number; tokensEnforced?: boolean } = {},
) {
  const runner = new GenerateTextRunner({
    model: languageModel,
    modelSpec: 'mock:demo',
    config: () => tenant,
    maxOutputTokens: 400,
    temperature: 0.3,
    plugins,
  });
  return new TurnHandler({
    db,
    runner,
    rules: tenant.rules,
    tools: tenant.tools,
    raceDeadlineMs: opts.raceDeadlineMs ?? 8000,
    modelAbortMs: 30_000,
    logger,
    tokenWriter: new FakeContactFields(),
    tokensEnforced: opts.tokensEnforced ?? false,
    actions: plugins.performer(new FakeActions(), logger),
    plugins,
  });
}

const agentTurn = async () => (await db.query.turns.findMany()).find(turn => turn.role === 'agent');

async function waitFor(ready: () => boolean | Promise<boolean>, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (!(await ready())) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

/** Every text part the model was sent on a step, its system prompt left out. */
const promptText = (options: LanguageModelV4CallOptions) =>
  JSON.stringify(options.prompt.filter(entry => entry.role !== 'system'));

describe('a plugin read on both delivery paths (specs/039 V8)', () => {
  it('builds the deferred reply from the same read, and the reply step sees it fenced', async () => {
    const { logger, reads } = journal();
    const { model: languageModel, calls } = model({ [MAX_STEPS - 1]: 300 });
    const out = await handler(languageModel, logger, { raceDeadlineMs: 50 }).handle(
      inbound('is there room on the foundation course?'),
    );
    expect(out.outcome).toBe('deferred');
    await waitFor(async () => (await db.query.outbox.findMany()).some(row => row.kind === 'reply'));

    // Three steps called the read; the budget let two through, and the third
    // made no call. The read the deadline overtook is not made again.
    expect(calls).toHaveLength(MAX_STEPS);
    expect(reads()).toBe(2);
    const [row] = (await db.query.outbox.findMany()).filter(entry => entry.kind === 'reply');
    expect(JSON.stringify(row!.payload)).toContain(ANSWER.messages[0]);

    // The reply step offers no tools, so its note carries the last read, fenced.
    const replyStep = calls[MAX_STEPS - 1]!;
    expect(replyStep.tools ?? []).toHaveLength(0);
    const note = promptText(replyStep);
    expect(note).toContain('READ class_availability:');
    expect(note).toContain('seatsLeft');
    expect(note).toContain(FENCE);
    expect(note).toContain('next foundation intake');

    expect((await agentTurn())!.reads).toEqual([
      expect.objectContaining({ tool: 'class_availability', available: true }),
      expect.objectContaining({ tool: 'class_availability', available: true }),
      expect.objectContaining({ tool: 'class_availability', available: false }),
    ]);
  });

  it('answers inline from the read, and records it without the result', async () => {
    const { logger, reads } = journal();
    const out = await handler(model().model, logger).handle(inbound('when does it start?'));
    expect(out.outcome).toBe('answered_inline');
    expect(reads()).toBe(2);
    const turn = (await agentTurn())!;
    expect(turn.reads).toHaveLength(3);
    expect(JSON.stringify(turn.reads)).not.toContain('next foundation intake');
    // A read stages nothing.
    expect(turn.actions).toEqual([]);
  });

  it('is not offered on an unbound turn, which may not read', async () => {
    const { logger, reads } = journal();
    const { model: languageModel, calls } = model();
    await handler(languageModel, logger, { tokensEnforced: true }).handle(inbound('hello'));
    expect((calls[0]!.tools ?? []).map(entry => entry.name)).not.toContain('class_availability');
    expect(reads()).toBe(0);
    expect((await agentTurn())!.reads).toBeNull();
  });
});
