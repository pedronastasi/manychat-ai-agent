import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4CallOptions, LanguageModelV4Content } from '@ai-sdk/provider';
import { createTestDatabase } from '../helpers/db.ts';
import { FakeActions, FakeContactFields } from '../helpers/manychat.ts';
import { EXAMPLE_PLUGIN, tenantProject } from '../helpers/plugins.ts';
import type { Database } from '../../src/db/client.ts';
import { TurnHandler } from '../../src/routes/turn.ts';
import { GenerateTextRunner } from '../../src/agent/runner.ts';
import { loadTenantConfig } from '../../src/config/loader.ts';
import { NO_TOOLS } from '../../src/contracts/config.ts';
import type { InboundMessage } from '../../src/contracts/agent.ts';
import type { ManyChatClient } from '../../src/channels/manychat/client.ts';
import { OutboxWorker } from '../../src/outbox/worker.ts';
import { loadPlugins } from '../../src/plugins/loader.ts';
import type { Plugins, HostLogger } from '../../src/plugins/plugins.ts';

/**
 * specs/036-plugins-extend-through-the-ports.md § Verification: the invented
 * plugin's tool, loaded from a stand-in tenant project, is called by a model
 * at the provider boundary and performed after the reply on both delivery
 * paths. The runner, turn handler and outbox are the real ones.
 */

// The fixture tenant without its tools.json: only the plugin offers a tool.
const tenant = { ...loadTenantConfig('test/fixtures/config'), tools: NO_TOOLS };

let plugins: Plugins;
let removeProject: () => void;
beforeAll(async () => {
  const project = tenantProject([EXAMPLE_PLUGIN], { [EXAMPLE_PLUGIN]: EXAMPLE_PLUGIN });
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

/** Every line written, in order, with the events a test adds beside them. */
function journal() {
  const order: string[] = [];
  const lines: { message: string; fields: Record<string, unknown> }[] = [];
  const at = (fields: object, message: string) => {
    lines.push({ message, fields: fields as Record<string, unknown> });
    if (message === 'lead logged') order.push('plugin crm_log_lead');
  };
  const logger: HostLogger = { info: at, warn: at, error: at };
  return { order, lines, logger };
}

const toolCall = (toolName: string, input: object): LanguageModelV4Content => ({
  type: 'tool-call',
  toolCallId: `call-${toolName}`,
  toolName,
  input: JSON.stringify(input),
});

const replyText = (reply: object): LanguageModelV4Content => ({
  type: 'text',
  text: JSON.stringify(reply),
});

const ANSWER = {
  messages: ['The evening course starts next month.'],
  escalate: false,
  escalation_reason: null,
  confidence: 0.9,
  closing_question: 'Shall I keep a place for you?',
};

const HANDOFF = {
  messages: ['Let me pass you to someone on the team.'],
  escalate: true,
  escalation_reason: 'out_of_scope',
  confidence: 0.9,
  closing_question: null,
};

/** Calls the plugin tool on the first step and answers with `reply` on the second. */
function model(reply: object, delays: Record<number, number> = {}) {
  const calls: LanguageModelV4CallOptions[] = [];
  const mock = new MockLanguageModelV4({
    doGenerate: async (options: LanguageModelV4CallOptions) => {
      const step = calls.length;
      calls.push(options);
      const delay = delays[step];
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      const content =
        step === 0
          ? [
              toolCall('crm_log_lead', {
                temperature: 'hot',
                callback: true,
                summary: 'Wants the evening course; reach them at lead@example.com',
              }),
            ]
          : [replyText(reply)];
      return {
        content,
        finishReason:
          step === 0
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
  subscriberId: '5550000000010',
  text,
  channel: 'whatsapp',
  contactName: null,
  locale: null,
  contactToken: null,
  receivedAt: new Date(),
});

function handler(languageModel: MockLanguageModelV4, logger: HostLogger, raceDeadlineMs = 8000) {
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
    raceDeadlineMs,
    modelAbortMs: 30_000,
    logger,
    tokenWriter: new FakeContactFields(),
    tokensEnforced: false,
    actions: plugins.performer(new FakeActions(), logger),
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

describe('a plugin tool is staged and performed after the reply (specs/036 V6)', () => {
  it('on the inline path: offered to the model, staged by its call, performed after the response', async () => {
    const { lines, logger } = journal();
    const { model: languageModel, calls } = model(ANSWER);
    const out = await handler(languageModel, logger).handle(inbound('when does it start?'));

    expect(out.outcome).toBe('answered_inline');
    expect(calls[0]!.tools?.map(tool => tool.name)).toEqual(['crm_log_lead']);
    // Nothing performed while the response is being written.
    expect(lines.some(line => line.message === 'lead logged')).toBe(false);
    expect((await agentTurn())!.actions).toEqual([
      { tool: 'plugin', id: 'crm_log_lead', status: 'staged' },
    ]);

    await out.afterResponse!();
    const logged = lines.find(line => line.message === 'lead logged')!;
    expect(logged.fields).toMatchObject({
      plugin: 'example-crm',
      given: 'logger,params,signal,subscriberId',
      subscriber: '[subscriber]',
    });
    const params = JSON.parse(logged.fields.params as string) as Record<string, unknown>;
    expect(params).toMatchObject({ temperature: 'hot', callback: true });
    // The note was cleaned before the plugin saw it.
    expect(params.summary).not.toContain('lead@example.com');
    expect((await agentTurn())!.actions).toEqual([
      { tool: 'plugin', id: 'crm_log_lead', status: 'performed' },
    ]);
  });

  it('is discarded when the turn escalates, and never performed', async () => {
    const { lines, logger } = journal();
    const out = await handler(model(HANDOFF).model, logger).handle(inbound('can I pay later?'));
    expect(out.reply.escalate).toBe(true);
    await out.afterResponse?.();
    expect(lines.some(line => line.message === 'lead logged')).toBe(false);
    expect((await agentTurn())!.actions).toEqual([
      { tool: 'plugin', id: 'crm_log_lead', status: 'discarded' },
    ]);
  });

  it('on the deferred path: performed by the outbox worker after the text is delivered', async () => {
    const { order, logger } = journal();
    const out = await handler(model(ANSWER, { 1: 300 }).model, logger, 50).handle(
      inbound('when does it start?'),
    );
    expect(out.outcome).toBe('deferred');
    await waitFor(async () => (await db.query.outbox.findMany()).some(row => row.kind === 'reply'));

    const client: ManyChatClient = {
      sendText: (_subscriber, messages) => {
        order.push(`text: ${messages.join(' ')}`);
        return Promise.resolve();
      },
      writeToken: () => Promise.resolve(),
      performAction: () => Promise.reject(new Error('a plugin action reached ManyChat')),
    };
    await new OutboxWorker({ db, client, logger, plugins }).drainOnce();

    expect(order).toEqual([
      `text: ${ANSWER.messages[0]} ${ANSWER.closing_question}`,
      'plugin crm_log_lead',
    ]);
    expect((await agentTurn())!.actions).toEqual([
      { tool: 'plugin', id: 'crm_log_lead', status: 'performed' },
    ]);
  });
});
