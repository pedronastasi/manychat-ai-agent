import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDatabase } from '../helpers/db.ts';
import type { Database } from '../../src/db/client.ts';
import { TurnHandler } from '../../src/routes/turn.ts';
import type { AgentRunner, AgentResult } from '../../src/agent/runner.ts';
import { ActionStage, buildTools } from '../../src/agent/tools.ts';
import type { ContactActions } from '../../src/agent/tools.ts';
import { RulesSchema } from '../../src/contracts/config.ts';
import type { InboundMessage, StagedAction } from '../../src/contracts/agent.ts';
import { loadTenantConfig } from '../../src/config/loader.ts';
import { OutboxWorker } from '../../src/outbox/worker.ts';
import { FakeActions, FakeContactFields } from '../helpers/manychat.ts';

/**
 * specs/023-sales-funnel.md § Verification item 4: performing the
 * payment-link flow writes `link_sent` after it, records both, and writes
 * nothing when the flow fails. On both delivery paths, and read back by the
 * next turn.
 */

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

const tools = loadTenantConfig('test/fixtures/config').tools!;

const rules = RulesSchema.parse({
  messages: { acknowledgement: 'One moment.', escalation: 'Passing you to a person.' },
  budget: { dailyTokenCap: 100_000, dailyCostCapUsd: 5 },
  rateLimit: { turnsPerSubscriberPerHour: 60 },
});

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const inbound = (text: string, subscriberId = 's1'): InboundMessage => ({
  tenantId: 'demo',
  subscriberId,
  text,
  channel: 'whatsapp',
  contactName: null,
  locale: null,
  contactToken: contactFields.tokenOf(subscriberId),
  receivedAt: new Date(),
});

const LINK_SENT_WRITE = {
  tool: 'set_field',
  id: 'funnel_stage',
  value: 'link_sent',
  status: 'performed',
};

/**
 * A model that calls `send_flow` with `flow` through the real tools, built
 * for the contact the turn handler read, and records what it was given.
 */
function flowRunner(flow: string, opts: { delayMs?: number; seen?: ContactActions[] } = {}) {
  return {
    run: async ({ stage = new ActionStage(), contact }) => {
      if (contact) opts.seen?.push(contact);
      const built = buildTools(tools, stage, contact);
      await built?.send_flow?.execute?.(
        { flow },
        { toolCallId: 'test', messages: [], context: {} },
      );
      if (opts.delayMs) await new Promise(resolve => setTimeout(resolve, opts.delayMs));
      const result: AgentResult = {
        reply: {
          messages: ['Sending it now.'],
          escalate: false,
          escalation_reason: null,
          confidence: 0.9,
          closing_question: null,
        },
        model: 'mock:demo',
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, costUsd: 0.001 },
        interventions: [],
        latencyMs: 5,
        toolsOffered: true,
      };
      return result;
    },
  } satisfies AgentRunner;
}

const makeDeps = (runner: AgentRunner, actions = new FakeActions()) => ({
  db,
  runner,
  rules,
  tools,
  logger,
  raceDeadlineMs: 200,
  modelAbortMs: 5000,
  tokenWriter: contactFields,
  tokensEnforced: true,
  actions,
});

const agentTurns = async () =>
  (await db.query.turns.findMany({ orderBy: (table, { asc }) => [asc(table.seq)] })).filter(
    turn => turn.role === 'agent',
  );

describe('the payment-link flow writes link_sent after it (specs/023 V4)', () => {
  it('inline: performs the flow, then the stage, and records both', async () => {
    const deps = makeDeps(flowRunner('enrolment_link'));
    const out = await new TurnHandler(deps).handle(inbound('send me the link'));
    await out.afterResponse!();

    expect(deps.actions.performed.map(entry => entry.action)).toEqual([
      expect.objectContaining({ tool: 'send_flow', id: 'enrolment_link' }),
      { tool: 'set_field', id: 'funnel_stage', field: 'funnel_stage', value: 'link_sent' },
    ]);
    const [turn] = await agentTurns();
    expect(turn!.actions).toEqual([
      { tool: 'send_flow', id: 'enrolment_link', status: 'performed' },
      LINK_SENT_WRITE,
    ]);
  });

  it('inline: writes no stage when the flow fails', async () => {
    const actions = new FakeActions();
    actions.failing = true;
    const deps = makeDeps(flowRunner('enrolment_link'), actions);
    const out = await new TurnHandler(deps).handle(inbound('send me the link'));
    await out.afterResponse!();

    expect(actions.performed).toHaveLength(0);
    const [turn] = await agentTurns();
    expect(turn!.actions).toEqual([
      expect.objectContaining({ tool: 'send_flow', id: 'enrolment_link', status: 'failed' }),
    ]);
  });

  it('a content flow writes no stage', async () => {
    const deps = makeDeps(flowRunner('foundation_brochure'));
    const out = await new TurnHandler(deps).handle(inbound('send me the brochure'));
    await out.afterResponse!();

    expect(deps.actions.performed).toHaveLength(1);
    const [turn] = await agentTurns();
    expect(turn!.actions).toEqual([
      { tool: 'send_flow', id: 'foundation_brochure', status: 'performed' },
    ]);
  });

  it('deferred: the worker delivers the text, then the flow, then the stage', async () => {
    const deps = makeDeps(flowRunner('enrolment_link', { delayMs: 400 }));
    const out = await new TurnHandler(deps).handle(inbound('send me the link'));
    expect(out.outcome).toBe('deferred');

    await vi.waitFor(
      async () => {
        const [turn] = await agentTurns();
        expect(turn?.actions).toEqual([
          { tool: 'send_flow', id: 'enrolment_link', status: 'staged' },
        ]);
      },
      { timeout: 3000 },
    );
    // The enqueue follows the turn's record; wait for the row to exist.
    const replies = async () =>
      (await db.query.outbox.findMany()).filter(row => row.kind === 'reply');
    await vi.waitFor(async () => expect(await replies()).toHaveLength(1));

    const events: string[] = [];
    const client = {
      sendText: () => {
        events.push('text');
        return Promise.resolve();
      },
      writeToken: () => Promise.resolve(),
      performAction: (_subscriber: string, action: StagedAction) => {
        events.push(action.tool === 'set_field' ? `${action.id}=${action.value}` : action.id);
        return Promise.resolve();
      },
    };
    await new OutboxWorker({ db, client, logger }).drainOnce();

    expect(events).toEqual(['text', 'enrolment_link', 'funnel_stage=link_sent']);
    const [turn] = await agentTurns();
    expect(turn!.actions).toEqual([
      { tool: 'send_flow', id: 'enrolment_link', status: 'performed' },
      LINK_SENT_WRITE,
    ]);
  });

  it('the next turn reads the stage and the flows sent from the record', async () => {
    const first = makeDeps(flowRunner('foundation_brochure'));
    await (
      await new TurnHandler(first).handle(inbound('send me the brochure'))
    ).afterResponse!();
    const second = makeDeps(flowRunner('enrolment_link'));
    await (
      await new TurnHandler(second).handle(inbound('and the link'))
    ).afterResponse!();

    const seen: ContactActions[] = [];
    const third = makeDeps(flowRunner('foundation_brochure', { seen }));
    const out = await new TurnHandler(third).handle(inbound('send the brochure again'));

    expect(seen[0]!.funnelStage).toBe('link_sent');
    expect([...seen[0]!.sentFlows].sort()).toEqual(['enrolment_link', 'foundation_brochure']);
    // The brochure is no longer offered, so the repeat could not be staged.
    expect(out.afterResponse).toBeUndefined();
    expect(third.actions.performed).toHaveLength(0);
  });
});
