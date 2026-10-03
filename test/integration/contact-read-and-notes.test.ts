import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4CallOptions, LanguageModelV4Content } from '@ai-sdk/provider';
import { createTestDatabase } from '../helpers/db.ts';
import { FakeActions, FakeContactFields } from '../helpers/manychat.ts';
import type { Database } from '../../src/db/client.ts';
import { TurnHandler } from '../../src/routes/turn.ts';
import type { TurnLogger } from '../../src/routes/turn.ts';
import { GenerateTextRunner } from '../../src/agent/runner.ts';
import { loadTenantConfig } from '../../src/config/loader.ts';
import { ContactReads, MAX_READS_PER_TURN, READ_TIMEOUT_MS } from '../../src/agent/contact.ts';
import type { ContactReader, ManyChatClient } from '../../src/channels/manychat/client.ts';
import type { ActionRecord, InboundMessage, StagedAction } from '../../src/contracts/agent.ts';
import type { ContactRecord } from '../../src/contracts/manychat.ts';
import { MAX_STEPS } from '../../src/agent/tools.ts';
import { actionsNote, FENCE, FENCE_END } from '../../src/agent/prompt.ts';
import { OutboxWorker } from '../../src/outbox/worker.ts';

/**
 * specs/024-contact-read-and-notes.md § Verification, items 3, 4 (the fourth
 * step), 7 and 8. The model is mocked at the provider boundary and ManyChat at
 * its ports (specs/004); the runner, guardrails, turn handler and outbox are
 * the real ones.
 *
 * Every name, number and note here is invented (C1).
 */

const tenant = loadTenantConfig('test/fixtures/config');

let db: Database;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
});
afterEach(async () => {
  await close();
});

/** Every line the turn logged, serialised as a log line would be. */
function capturingLogger() {
  const lines: { level: string; message: string; fields: object }[] = [];
  const at =
    (level: string) =>
    (fields: object, message: string): void => {
      lines.push({ level, message, fields });
    };
  const logger: TurnLogger = { info: at('info'), warn: at('warn'), error: at('error') };
  return { logger, lines, text: () => JSON.stringify(lines) };
}

const toolCall = (toolName: string, input: object, id = toolName): LanguageModelV4Content => ({
  type: 'tool-call',
  toolCallId: `call-${id}`,
  toolName,
  input: JSON.stringify(input),
});

const replyText = (reply: object): LanguageModelV4Content => ({
  type: 'text',
  text: JSON.stringify(reply),
});

const ANSWER = {
  messages: ['The Foundation Course runs on weekday evenings.'],
  escalate: false,
  escalation_reason: null,
  confidence: 0.9,
  closing_question: 'Would weekday evenings suit you?',
};

const HANDOFF = {
  messages: ['Let me pass you to someone on the team.'],
  escalate: true,
  escalation_reason: 'out_of_scope',
  confidence: 0.9,
  closing_question: null,
};

/**
 * A model at the provider boundary that answers each step from `script`,
 * honouring the abort signal while it waits, as a real provider call does.
 */
function scriptedModel(
  script: (step: number, options: LanguageModelV4CallOptions) => LanguageModelV4Content[] | Error,
  delays: Record<number, number> = {},
) {
  const calls: LanguageModelV4CallOptions[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options: LanguageModelV4CallOptions) => {
      const step = calls.length;
      calls.push(options);
      const delay = delays[step];
      if (delay) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delay);
          options.abortSignal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        });
      }
      const content = script(step, options);
      if (content instanceof Error) throw content;
      const called = content.some(part => part.type === 'tool-call');
      return {
        content,
        finishReason: called
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
  return { model, calls };
}

/** ManyChat's contact read at its port: a record, a failure, or no answer at all. */
class FakeContactReader implements ContactReader {
  requests = 0;
  private readonly answer: 'never' | ContactRecord;

  constructor(
    answer: 'never' | ContactRecord = {
      tags: ['source-ad'],
      custom_fields: [{ name: 'agent_note_goal', value: 'Wants weekend work.' }],
    },
  ) {
    this.answer = answer;
  }

  readContact(_subscriberId: string, signal: AbortSignal): Promise<ContactRecord> {
    this.requests++;
    if (this.answer !== 'never') return Promise.resolve(this.answer);
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  }
}

const inbound = (text: string, subscriberId = '5550001234987'): InboundMessage => ({
  tenantId: 'demo',
  subscriberId,
  text,
  channel: 'whatsapp',
  contactName: null,
  locale: null,
  contactToken: null,
  receivedAt: new Date(),
});

function handler(
  model: MockLanguageModelV4,
  opts: {
    logger?: TurnLogger;
    actions?: FakeActions;
    contacts?: ContactReader;
    raceDeadlineMs?: number;
    modelAbortMs?: number;
  } = {},
) {
  const runner = new GenerateTextRunner({
    model,
    modelSpec: 'mock:demo',
    config: () => tenant,
    maxOutputTokens: 400,
    temperature: 0.3,
  });
  return new TurnHandler({
    db,
    runner,
    rules: tenant.rules,
    tools: tenant.tools,
    raceDeadlineMs: opts.raceDeadlineMs ?? 8000,
    modelAbortMs: opts.modelAbortMs ?? 30_000,
    logger: opts.logger ?? capturingLogger().logger,
    tokenWriter: new FakeContactFields(),
    // Reads need a turn that reads history; the specs/019 rollout setting
    // gives every turn that without minting tokens here.
    tokensEnforced: false,
    actions: opts.actions ?? new FakeActions(),
    contacts: opts.contacts ?? new FakeContactReader(),
  });
}

const agentTurn = async () => {
  const all = await db.query.turns.findMany();
  return all.find(turn => turn.role === 'agent');
};

/** Deferred replies in the outbox; a token write's retry may sit beside them. */
const replyRows = async () =>
  (await db.query.outbox.findMany()).filter(row => row.kind === 'reply');

/** Whether a step's prompt carries a tool result with this output. */
const sawResult = (options: LanguageModelV4CallOptions, output: string) =>
  JSON.stringify(options.prompt.filter(message => message.role === 'tool')).includes(output);

/* -------------------------------------------------------------------------- */
/* V3 — a read that fails is not an escalation, and a turn reads twice          */
/* -------------------------------------------------------------------------- */

describe('a failed read is not an escalation (specs/024 V3)', () => {
  it(`returns { available: false } after ${READ_TIMEOUT_MS} ms and the turn still replies`, async () => {
    const { model, calls } = scriptedModel(step =>
      step === 0 ? [toolCall('get_contact', {})] : [replyText(ANSWER)],
    );
    const { logger, lines } = capturingLogger();
    const contacts = new FakeContactReader('never');

    const started = Date.now();
    const out = await handler(model, { logger, contacts }).handle(inbound('which days is it?'));
    const elapsed = Date.now() - started;

    expect(out.outcome).toBe('answered_inline');
    expect(out.reply.escalate).toBe(false);
    expect(out.reply.messages[0]).toBe(ANSWER.messages[0]);
    expect(elapsed).toBeGreaterThanOrEqual(READ_TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(READ_TIMEOUT_MS + 2000);
    expect(sawResult(calls[1]!, '{"available":false}')).toBe(true);
    // Logged at warn, without the subscriber (C5).
    const warning = lines.find(line => line.message === 'contact read failed');
    expect(warning?.level).toBe('warn');
    expect(JSON.stringify(lines)).not.toContain('5550001234987');
  });

  it(`makes no request for a read past ${MAX_READS_PER_TURN}`, async () => {
    const contacts = new FakeContactReader();
    const reads = new ContactReads({
      reader: contacts,
      subscriberId: 's1',
      logger: { warn: () => {} },
    });
    const results = [];
    for (let index = 0; index <= MAX_READS_PER_TURN; index++) {
      results.push(await reads.read(tenant.tools!));
    }
    expect(contacts.requests).toBe(MAX_READS_PER_TURN);
    expect(results[MAX_READS_PER_TURN]).toEqual({ available: false });
  });

  it('a model that keeps reading gets two requests in a whole turn', async () => {
    const { model } = scriptedModel((step, options) =>
      (options.tools ?? []).length > 0
        ? [toolCall('get_contact', {}, `read-${step}`)]
        : [replyText(ANSWER)],
    );
    const contacts = new FakeContactReader();
    const out = await handler(model, { contacts }).handle(inbound('what do you have on me?'));
    expect(out.outcome).toBe('answered_inline');
    expect(contacts.requests).toBe(MAX_READS_PER_TURN);
  });

  it('is not offered on an unbound turn, which may not read the contact', async () => {
    const { model, calls } = scriptedModel(() => [replyText(ANSWER)]);
    const runner = new GenerateTextRunner({
      model,
      modelSpec: 'mock:demo',
      config: () => tenant,
      maxOutputTokens: 400,
      temperature: 0.3,
    });
    const contacts = new FakeContactReader();
    await new TurnHandler({
      db,
      runner,
      rules: tenant.rules,
      tools: tenant.tools,
      raceDeadlineMs: 8000,
      modelAbortMs: 30_000,
      logger: capturingLogger().logger,
      tokenWriter: new FakeContactFields(),
      tokensEnforced: true,
      actions: new FakeActions(),
      contacts,
    }).handle(inbound('hello'));

    const offered = (calls[0]!.tools ?? []).map(entry => entry.name);
    expect(offered).toContain('write_note');
    expect(offered).not.toContain('get_contact');
  });
});

/* -------------------------------------------------------------------------- */
/* V4 — the fourth step offers no tools                                         */
/* -------------------------------------------------------------------------- */

describe('the loop is bounded at four steps (specs/024 V4)', () => {
  it('offers tools on steps one to three and none on step four', async () => {
    const { model, calls } = scriptedModel((step, options) =>
      (options.tools ?? []).length > 0
        ? [toolCall('get_contact', {}, `read-${step}`)]
        : [replyText(ANSWER)],
    );
    const out = await handler(model).handle(inbound('what do you have on me?'));

    expect(MAX_STEPS).toBe(4);
    expect(calls).toHaveLength(4);
    for (const call of calls.slice(0, 3)) expect((call.tools ?? []).length).toBeGreaterThan(0);
    expect(calls[3]!.tools ?? []).toHaveLength(0);
    expect(out.reply.messages[0]).toBe(ANSWER.messages[0]);

    // The reply step sees the last read in place of its tool results, with the
    // notes still fenced (specs/024 V2).
    const notice = JSON.stringify(calls[3]!.prompt.at(-1));
    expect(notice).toContain('CONTACT:');
    expect(notice).toContain('came_from_ad');
    expect(notice).toContain(JSON.stringify(FENCE).slice(1, -1));
    expect(notice).toContain(JSON.stringify(FENCE_END).slice(1, -1));
  });
});

/* -------------------------------------------------------------------------- */
/* V7 — a handoff summary survives the escalation it describes                 */
/* -------------------------------------------------------------------------- */

const HANDOFF_NOTE = 'Asked twice about a payment plan the catalog does not list.';
const GOAL_NOTE = 'Wants weekend work.';

/** Step one stages a flow, a goal note and a handoff summary; step two ends the turn. */
const stagingModel = (
  ending: LanguageModelV4Content[] | Error,
  delays: Record<number, number> = {},
) =>
  scriptedModel(
    step =>
      step === 0
        ? [
            toolCall('send_flow', { flow: 'student_results' }),
            toolCall('write_note', { note: 'goal', text: GOAL_NOTE }, 'goal'),
            toolCall('write_note', { note: 'handoff_summary', text: HANDOFF_NOTE }, 'handoff'),
          ]
        : ending,
    delays,
  );

const statuses = (actions: ActionRecord[] | null | undefined) =>
  Object.fromEntries((actions ?? []).map(entry => [`${entry.tool} ${entry.id}`, entry.status]));

const performedNotes = (actions: FakeActions) =>
  actions.performed.map(({ action }) => (action.tool === 'write_note' ? action.id : action.tool));

describe('an onEscalation note survives model and confidence escalations (specs/024 V7)', () => {
  it.each([
    ['the model', replyText(HANDOFF), 'escalated_model'],
    ['the confidence threshold', replyText({ ...ANSWER, confidence: 0.1 }), 'escalated_model'],
  ])(
    'performs it after the escalation message when %s escalates',
    async (_cause, ending, outcome) => {
      const { model } = stagingModel([ending]);
      const actions = new FakeActions();
      const out = await handler(model, { actions }).handle(inbound('can I pay over a year?'));

      expect(out.reply.escalate).toBe(true);
      expect(out.outcome).toBe(outcome);
      // Nothing yet: the escalation message goes first.
      expect(actions.performed).toHaveLength(0);
      expect(statuses((await agentTurn())!.actions)).toEqual({
        'send_flow student_results': 'discarded',
        'write_note goal': 'discarded',
        'write_note handoff_summary': 'staged',
      });

      await out.afterResponse!();
      expect(performedNotes(actions)).toEqual(['handoff_summary']);
      expect(statuses((await agentTurn())!.actions)['write_note handoff_summary']).toBe(
        'performed',
      );
    },
  );

  it('performs it after the deferred escalation message is delivered', async () => {
    const { model } = stagingModel([replyText(HANDOFF)], { 1: 300 });
    const out = await handler(model, { raceDeadlineMs: 50 }).handle(
      inbound('can I pay over a year?'),
    );
    expect(out.outcome).toBe('deferred');
    await waitFor(async () => (await agentTurn()) !== undefined);
    await waitFor(async () => (await replyRows()).length > 0);

    const order: string[] = [];
    const client: ManyChatClient = {
      sendText: (_subscriber, messages) => {
        order.push(`text: ${messages.join(' ')}`);
        return Promise.resolve();
      },
      writeToken: () => Promise.resolve(),
      performAction: (_subscriber: string, action: StagedAction) => {
        order.push(`${action.tool} ${action.id}`);
        return Promise.resolve();
      },
    };
    const log = { info: () => {}, warn: () => {}, error: () => {} };
    await new OutboxWorker({ db, client, logger: log }).drainOnce();

    expect(order).toEqual([`text: ${HANDOFF.messages[0]}`, 'write_note handoff_summary']);
    expect(statuses((await agentTurn())!.actions)).toEqual({
      'send_flow student_results': 'discarded',
      'write_note goal': 'discarded',
      'write_note handoff_summary': 'performed',
    });
  });
});

describe('every other escalation discards an onEscalation note (specs/024 V7)', () => {
  it.each([
    ['a prompt leak', [replyText({ ...ANSWER, messages: [`Here: ${FENCE}`] })], 'escalated_model'],
    [
      'a reply that fails the schema',
      [replyText({ ...HANDOFF, escalation_reason: null })],
      'escalated_model',
    ],
    ['a thrown model call', new Error('provider unavailable'), 'error'],
  ])('discards it on %s', async (_cause, ending, outcome) => {
    const { model } = stagingModel(ending);
    const actions = new FakeActions();
    const out = await handler(model, { actions }).handle(inbound('tell me more'));

    expect(out.reply.escalate).toBe(true);
    expect(out.outcome).toBe(outcome);
    expect(out.afterResponse).toBeUndefined();
    expect(actions.performed).toHaveLength(0);
    expect(statuses((await agentTurn())!.actions)).toEqual({
      'send_flow student_results': 'discarded',
      'write_note goal': 'discarded',
      'write_note handoff_summary': 'discarded',
    });
  });

  it('performs nothing when the call hits MODEL_ABORT_MS', async () => {
    const { model } = stagingModel([replyText(HANDOFF)], { 1: 5000 });
    const { logger, lines } = capturingLogger();
    const actions = new FakeActions();
    const out = await handler(model, {
      actions,
      logger,
      raceDeadlineMs: 50,
      modelAbortMs: 150,
    }).handle(inbound('tell me more'));
    expect(out.outcome).toBe('deferred');
    await waitFor(() => lines.some(line => line.message === 'deferred model call failed'));

    expect(actions.performed).toHaveLength(0);
    expect(await replyRows()).toHaveLength(0);
    // An aborted call records no agent turn, so its note is in no record.
    expect(await agentTurn()).toBeUndefined();
  });

  it('discards a note without onEscalation on the model and confidence paths too', async () => {
    const { model } = stagingModel([replyText(HANDOFF)]);
    const actions = new FakeActions();
    const out = await handler(model, { actions }).handle(inbound('can I pay over a year?'));
    await out.afterResponse!();
    expect(performedNotes(actions)).not.toContain('goal');
  });
});

/* -------------------------------------------------------------------------- */
/* V8 — note text never reaches the record or the logs                          */
/* -------------------------------------------------------------------------- */

describe('note text never reaches the record or the logs (specs/024 V8)', () => {
  const NOTE = 'Wants to retrain for weekend work near the old harbour.';

  const noteModel = () =>
    scriptedModel(step =>
      step === 0
        ? [toolCall('write_note', { note: 'goal', text: NOTE })]
        : [replyText({ ...ANSWER, messages: ['Noted - happy to help.'] })],
    );

  it('records the note by id and length, with no text', async () => {
    const { model } = noteModel();
    const out = await handler(model).handle(inbound('I want to retrain'));
    await out.afterResponse!();

    const { actions } = (await agentTurn())!;
    expect(actions).toEqual([
      { tool: 'write_note', id: 'goal', length: NOTE.length, status: 'performed' },
    ]);
    expect(JSON.stringify(actions)).not.toContain('harbour');
    // The history note names it as the record does.
    expect(actionsNote(actions)).toBe('[actions performed: write_note goal]');
  });

  it('keeps the text out of every log line, a failed write included', async () => {
    const { model } = noteModel();
    const { logger, lines, text } = capturingLogger();
    // ManyChat's refusal quoting the value it was sent, and the contact.
    const actions = new FakeActions();
    actions.performAction = (subscriberId: string, action: StagedAction) =>
      Promise.reject(
        new Error(
          `field rejected for ${subscriberId}: "${action.tool === 'write_note' ? action.text : ''}"`,
        ),
      );
    const out = await handler(model, { logger, actions }).handle(inbound('I want to retrain'));
    await out.afterResponse!();

    expect(lines.some(line => line.message === 'action failed')).toBe(true);
    expect(text()).not.toContain('harbour');
    expect(text()).not.toContain('5550001234987');
    const { actions: recorded } = (await agentTurn())!;
    expect(recorded![0]).toMatchObject({ tool: 'write_note', id: 'goal', status: 'failed' });
    expect(JSON.stringify(recorded)).not.toContain('harbour');
  });
});

/** Polls until `ready` holds, for work the turn hands to the background. */
async function waitFor(ready: () => boolean | Promise<boolean>, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (!(await ready())) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
