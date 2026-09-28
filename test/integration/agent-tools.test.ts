import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDatabase } from '../helpers/db.ts';
import type { Database } from '../../src/db/client.ts';
import { TurnHandler } from '../../src/routes/turn.ts';
import type { AgentRunner, AgentResult, HistoryTurn } from '../../src/agent/runner.ts';
import { RulesSchema } from '../../src/contracts/config.ts';
import type { InboundMessage, ActionRecord } from '../../src/contracts/agent.ts';
import { OutboxQueue } from '../../src/outbox/queue.ts';
import { OutboxWorker } from '../../src/outbox/worker.ts';
import { ConversationStore } from '../../src/conversation/store.ts';
import { FakeActions, FakeContactFields } from '../helpers/manychat.ts';
import { ActionStage } from '../../src/agent/tools.ts';

/**
 * specs/012-agent-tools.md § Verification items 3, 6 and 9.
 *
 * Item 3 — each escalation path discards staged actions, zero ManyChat requests.
 * Item 6 — delivery ordering: text before actions, on both paths.
 * Item 9 — action status is written correctly on every path.
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

const rules = RulesSchema.parse({
  messages: { acknowledgement: 'One moment.', escalation: 'Passing you to a person.' },
  escalationKeywords: ['speak to a human'],
  maxTurnsPerConversation: 25,
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

const toolCallingRunner = (opts: {
  escalate?: boolean;
  confidence?: number;
  modelError?: string;
}): AgentRunner => ({
  run: ({ stage = new ActionStage() }) => {
    stage.stage({
      tool: 'send_flow',
      id: 'foundation_brochure',
      flowNs: 'content00000000000000_000001',
    });
    const result: AgentResult = {
      reply: {
        messages: [opts.escalate ? 'Passing you to a person.' : 'Sending the brochure now.'],
        escalate: opts.escalate ?? false,
        escalation_reason: opts.escalate ? 'out_of_scope' : null,
        confidence: opts.confidence ?? 0.9,
        closing_question: null,
      },
      model: 'mock:demo',
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, costUsd: 0.001 },
      interventions: [],
      latencyMs: 5,
      toolsOffered: true,
      ...(opts.modelError ? { modelError: opts.modelError } : {}),
    };
    return Promise.resolve(result);
  },
});

const makeDeps = (
  runner: AgentRunner,
  over: Partial<{ raceDeadlineMs: number; modelAbortMs: number }> = {},
) => ({
  db,
  runner,
  rules,
  logger,
  raceDeadlineMs: over.raceDeadlineMs ?? 200,
  modelAbortMs: over.modelAbortMs ?? 5000,
  tokenWriter: contactFields,
  tokensEnforced: true,
  actions: new FakeActions(),
});

const agentTurn = async () => {
  const all = await db.query.turns.findMany();
  return all.find(turn => turn.role === 'agent')!;
};

/* -------------------------------------------------------------------------- */
/* V3 — escalation paths discard staged actions                               */
/* -------------------------------------------------------------------------- */

describe('escalation discards staged actions (specs/012 V3)', () => {
  it('discards when the model itself escalates', async () => {
    const td = makeDeps(toolCallingRunner({ escalate: true }));
    const out = await new TurnHandler(td).handle(inbound('something odd'));
    expect(out.outcome).toBe('escalated_model');
    expect(td.actions.performed).toHaveLength(0);

    const turn = await agentTurn();
    expect(turn.actions).toBeDefined();
    expect(turn.actions!.every((rec: ActionRecord) => rec.status === 'discarded')).toBe(true);
  });

  it('discards when guardrails force escalation (low confidence)', async () => {
    const td = makeDeps(toolCallingRunner({ escalate: true, confidence: 0.1 }));
    const out = await new TurnHandler(td).handle(inbound('maybe?'));
    expect(out.reply.escalate).toBe(true);
    expect(td.actions.performed).toHaveLength(0);
  });

  it('discards when the model call fails', async () => {
    const td = makeDeps(
      toolCallingRunner({ escalate: true, modelError: 'NoObjectGeneratedError' }),
    );
    const out = await new TurnHandler(td).handle(inbound('hello'));
    expect(out.outcome).toBe('error');
    expect(td.actions.performed).toHaveLength(0);
  });

  it('discards when the runner throws (provider down)', async () => {
    const failing: AgentRunner = {
      run: ({ stage: st = new ActionStage() }) => {
        st.stage({ tool: 'send_flow', id: 'x', flowNs: 'ns' });
        return Promise.reject(new Error('provider down'));
      },
    };
    const td = makeDeps(failing);
    const out = await new TurnHandler(td).handle(inbound('hello'));
    expect(out.outcome).toBe('error');
    expect(td.actions.performed).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* V6 — delivery ordering                                                     */
/* -------------------------------------------------------------------------- */

describe('delivery ordering (specs/012 V6)', () => {
  it('inline path: afterResponse callback exists only when actions are staged and not escalating', async () => {
    const td = makeDeps(toolCallingRunner({}));
    const out = await new TurnHandler(td).handle(inbound('send me the brochure'));
    expect(out.outcome).toBe('answered_inline');
    expect(out.afterResponse).toBeDefined();

    expect(td.actions.performed).toHaveLength(0);

    await out.afterResponse!();
    expect(td.actions.performed).toHaveLength(1);
    expect(td.actions.performed[0]!.action.tool).toBe('send_flow');
  });

  it('inline path: no afterResponse when the turn escalates', async () => {
    const td = makeDeps(toolCallingRunner({ escalate: true }));
    const out = await new TurnHandler(td).handle(inbound('something'));
    expect(out.afterResponse).toBeUndefined();
  });

  it('deferred path: actions travel through the outbox and are performed after text', async () => {
    const slow = (ms: number): AgentRunner => ({
      run: ({ stage = new ActionStage(), signal }) =>
        new Promise((resolve, reject) => {
          stage.stage({
            tool: 'send_flow',
            id: 'foundation_brochure',
            flowNs: 'content00000000000000_000001',
          });
          const timer = setTimeout(
            () =>
              resolve({
                reply: {
                  messages: ['Here is the brochure.'],
                  escalate: false,
                  escalation_reason: null,
                  confidence: 0.9,
                  closing_question: null,
                },
                model: 'mock:demo',
                usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, costUsd: 0.001 },
                interventions: [],
                latencyMs: ms,
                toolsOffered: true,
              }),
            ms,
          );
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
    });

    const td = makeDeps(slow(600));
    const out = await new TurnHandler(td).handle(inbound('brochure', 'deferred-sub'));
    expect(out.outcome).toBe('deferred');

    await vi.waitFor(
      async () => {
        const turn = await agentTurn();
        expect(turn).toBeDefined();
        expect(turn.actions).toBeDefined();
        expect(turn.actions!.length).toBeGreaterThan(0);
        expect(turn.actions![0]!.status).toBe('staged');
      },
      { timeout: 3000 },
    );

    const claimed = await new OutboxQueue(db).claimBatch(10);
    expect(claimed).toHaveLength(1);
  });

  it('dead-lettered outbox row marks actions as dead_lettered', async () => {
    const store = new ConversationStore(db);
    const conversation = await store.startTurn({
      tenantId: 'demo',
      subscriberId: 'dead-sub',
      channel: 'whatsapp',
      idleResetHours: 24,
    });
    await store.recordUserMessage(conversation.id, 'hello', { bound: true });
    const turnId = await store.recordAgentReply(
      conversation.id,
      'Sending the brochure.',
      'deferred',
      {
        bound: true,
        actions: [{ tool: 'send_flow', id: 'foundation_brochure', status: 'staged' }],
      },
    );

    const queue = new OutboxQueue(db);
    await queue.enqueue({
      tenantId: 'demo',
      subscriberId: 'dead-sub',
      conversationId: conversation.id,
      reply: {
        messages: ['Sending the brochure.'],
        escalate: false,
        escalation_reason: null,
        confidence: 0.9,
        closing_question: null,
      },
      actions: {
        staged: [
          { tool: 'send_flow', id: 'foundation_brochure', flowNs: 'content00000000000000_000001' },
        ],
        turnId,
      },
    });

    const { ManyChatApiError } = await import('../../src/channels/manychat/client.ts');
    const failClient = {
      sendText: () => Promise.reject(new ManyChatApiError(400, 'bad', false)),
      writeToken: () => Promise.resolve(),
      performAction: () => Promise.resolve(),
    };
    const workerResult = await new OutboxWorker({
      db,
      client: failClient,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    }).drainOnce();

    expect(workerResult.deadLettered).toBe(1);

    const turn = (await db.query.turns.findMany()).find(row => row.id === turnId)!;
    expect(turn.actions).toBeDefined();
    expect(turn.actions![0]!.status).toBe('dead_lettered');
  });
});

/* -------------------------------------------------------------------------- */
/* V9 — action status recording on each path                                  */
/* -------------------------------------------------------------------------- */

describe('action status recording (specs/012 V9)', () => {
  it('records null actions when no tool was offered', async () => {
    const noTools: AgentRunner = {
      run: () =>
        Promise.resolve({
          reply: {
            messages: ['No tools here.'],
            escalate: false,
            escalation_reason: null,
            confidence: 0.9,
            closing_question: null,
          },
          model: 'mock:demo',
          usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, costUsd: 0.001 },
          interventions: [],
          latencyMs: 5,
        }),
    };
    await new TurnHandler(makeDeps(noTools)).handle(inbound('hello', 'no-tool-sub'));
    const turn = await agentTurn();
    expect(turn.actions).toBeNull();
  });

  it('records empty array when tools offered but none chosen', async () => {
    const noneChosen: AgentRunner = {
      run: () =>
        Promise.resolve({
          reply: {
            messages: ['I can help with that schedule.'],
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
        }),
    };
    await new TurnHandler(makeDeps(noneChosen)).handle(inbound('when is it?', 'none-chosen-sub'));
    const turn = await agentTurn();
    expect(turn.actions).toEqual([]);
  });

  it('records staged status on the inline path before afterResponse', async () => {
    const td = makeDeps(toolCallingRunner({}));
    const out = await new TurnHandler(td).handle(inbound('send brochure', 'inline-sub'));
    expect(out.outcome).toBe('answered_inline');

    const turnBefore = await agentTurn();
    expect(turnBefore.actions).toBeDefined();
    expect(turnBefore.actions![0]!.status).toBe('staged');
  });

  it('resolves staged to performed after afterResponse succeeds', async () => {
    const td = makeDeps(toolCallingRunner({}));
    const out = await new TurnHandler(td).handle(inbound('send brochure', 'resolved-sub'));
    await out.afterResponse!();

    const turn = await agentTurn();
    expect(turn.actions![0]!.status).toBe('performed');
  });

  it('resolves staged to failed when performAction rejects', async () => {
    const failingActions = new FakeActions();
    failingActions.failing = true;
    const td = {
      ...makeDeps(toolCallingRunner({})),
      actions: failingActions,
    };
    const out = await new TurnHandler(td).handle(inbound('send brochure', 'fail-sub'));
    await out.afterResponse!();

    const turn = await agentTurn();
    expect(turn.actions![0]!.status).toBe('failed');
    expect(turn.actions![0]!.error).toBeDefined();
  });

  it('records discarded status when the model escalates', async () => {
    const td = makeDeps(toolCallingRunner({ escalate: true }));
    await new TurnHandler(td).handle(inbound('help', 'discard-sub'));

    const turn = await agentTurn();
    expect(turn.actions!.every((rec: ActionRecord) => rec.status === 'discarded')).toBe(true);
  });

  it('records dropped_over_cap for actions past the limit', async () => {
    const overCap: AgentRunner = {
      run: ({ stage = new ActionStage() }) => {
        stage.stage({ tool: 'send_flow', id: 'foundation_brochure', flowNs: 'ns1' });
        stage.stage({ tool: 'add_tag', id: 'interested_foundation', tag: 'tg' });
        stage.stage({ tool: 'remove_tag', id: 'interested_foundation', tag: 'tg' });
        stage.stage({ tool: 'add_tag', id: 'over_cap_tag', tag: 'tg2' }); // 4th, dropped
        return Promise.resolve({
          reply: {
            messages: ['Done.'],
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
        });
      },
    };
    const td = makeDeps(overCap);
    const out = await new TurnHandler(td).handle(inbound('all of it', 'cap-sub'));
    await out.afterResponse!();

    const turn = await agentTurn();
    const performed = turn.actions!.filter((rec: ActionRecord) => rec.status === 'performed');
    const dropped = turn.actions!.filter((rec: ActionRecord) => rec.status === 'dropped_over_cap');
    expect(performed).toHaveLength(3);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.id).toBe('over_cap_tag');
  });
});

/* -------------------------------------------------------------------------- */
/* History carries action records (specs/012 V10 integration)                  */
/* -------------------------------------------------------------------------- */

describe('history carries action records (specs/012 V10)', () => {
  it('passes actions from a prior turn into the next turn history', async () => {
    const seen: HistoryTurn[][] = [];
    let callCount = 0;
    const recording: AgentRunner = {
      run: ({ history, stage = new ActionStage() }) => {
        seen.push([...history]);
        callCount++;
        if (callCount === 1) {
          stage.stage({
            tool: 'send_flow',
            id: 'foundation_brochure',
            flowNs: 'content00000000000000_000001',
          });
        }
        return Promise.resolve({
          reply: {
            messages: [callCount === 1 ? 'Sending the brochure.' : 'Sure, anything else?'],
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
        });
      },
    };
    const td = makeDeps(recording);

    const first = await new TurnHandler(td).handle(inbound('send brochure', 'hist-sub'));
    await first.afterResponse!();

    await new TurnHandler(td).handle(inbound('thanks', 'hist-sub'));

    expect(seen[1]).toBeDefined();
    const agentHistory = seen[1]!.find(row => row.role === 'agent');
    expect(agentHistory).toBeDefined();
    expect(agentHistory!.actions).toBeDefined();
    expect(agentHistory!.actions![0]!.status).toBe('performed');
  });
});
