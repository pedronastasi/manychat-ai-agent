import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '../helpers/db.ts';
import type { Database } from '../../src/db/client.ts';
import { nudges, turns } from '../../src/db/schema.ts';
import { ConversationStore } from '../../src/conversation/store.ts';
import { BudgetGuard } from '../../src/conversation/budget.ts';
import { NudgeStore } from '../../src/nudge/store.ts';
import { ActionStage } from '../../src/agent/tools.ts';
import type { AgentResult } from '../../src/agent/runner.ts';
import { TurnRecorder } from '../../src/turn/recorder.ts';
import { escalationReply } from '../../src/agent/guardrails.ts';
import { plainReply } from '../../src/turn/replies.ts';

/**
 * TurnRecorder writes how a turn ended, for the inline and the deferred path
 * alike. specs/012 § Every staged action is recorded on its turn, and
 * § Guardrails run before any action is performed; specs/019 § Only bound
 * turns enter history and the turn cap; specs/024 § A handoff summary
 * survives the escalation it describes; specs/025: any escalation cancels a
 * waiting nudge. Every value is invented.
 */

let db: Database;
let close: () => Promise<void>;
let store: ConversationStore;
beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
  store = new ConversationStore(db);
});
afterEach(async () => {
  await close();
});

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

async function recorderFor(bound: boolean, stage = new ActionStage()) {
  const conversation = await store.startTurn(
    { tenantId: 'demo', subscriberId: 's1', channel: 'whatsapp', idleResetHours: 24 },
    new Date(),
  );
  const recorder = new TurnRecorder(
    { store, budget: new BudgetGuard(db), nudges: new NudgeStore(db) },
    { conversationId: conversation.id, tenantId: 'demo', bound, logger, stage },
  );
  return { recorder, conversationId: conversation.id };
}

const result = (overrides: Partial<AgentResult> = {}): AgentResult => ({
  reply: { ...plainReply(['The next intake opens in spring.']), confidence: 0.9 },
  model: 'mock:demo',
  usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, costUsd: 0.001 },
  interventions: [],
  latencyMs: 5,
  toolsOffered: true,
  ...overrides,
});

const escalating = (escalatedBy: AgentResult['escalatedBy']) =>
  result({ reply: escalationReply('low_confidence', 'Passing you to a person.'), escalatedBy });

const agentRow = async (conversationId: string) => {
  const rows = await db.select().from(turns).where(eq(turns.conversationId, conversationId));
  return rows.find(row => row.role === 'agent')!;
};

describe('a decided reply (specs/019, specs/025)', () => {
  it('records its own outcome and marks a bound escalation', async () => {
    const { recorder, conversationId } = await recorderFor(true);
    await recorder.decided(
      escalationReply('complaint', 'Passing you to a person.'),
      'escalated_precheck',
    );
    expect((await agentRow(conversationId)).outcome).toBe('escalated_precheck');
    expect((await store.find('demo', 's1'))?.escalatedAt).not.toBeNull();
  });

  it("leaves an unbound contact's state alone, but still cancels their nudge", async () => {
    const { recorder, conversationId } = await recorderFor(false);
    await new NudgeStore(db).schedule(conversationId, 60);
    await recorder.decided(
      escalationReply('complaint', 'Passing you to a person.'),
      'escalated_precheck',
    );
    expect((await store.find('demo', 's1'))?.escalatedAt).toBeNull();
    const [nudge] = await db.select().from(nudges).where(eq(nudges.conversationId, conversationId));
    expect(nudge?.cancelReason).toBe('escalated');
  });

  it('marks nothing for a reply that does not escalate', async () => {
    const { recorder } = await recorderFor(true);
    await recorder.decided(plainReply(['Hi! How can I help?']), 'answered_scripted');
    expect((await store.find('demo', 's1'))?.escalatedAt).toBeNull();
  });
});

describe('a settled model reply (specs/012, specs/024)', () => {
  const tag = { tool: 'add_tag', id: 'interested', tag: 'interested' } as const;
  const note = {
    tool: 'write_note',
    id: 'handoff',
    field: 'handoff_note',
    text: 'Asked about evening classes.',
    onEscalation: true,
  } as const;

  it('records null actions when no tool was offered', async () => {
    const { recorder, conversationId } = await recorderFor(true);
    await recorder.settle(result({ toolsOffered: false }), 'answered_inline');
    expect((await agentRow(conversationId)).actions).toBeNull();
  });

  it('records what was staged, and performs all of it, when the reply stands', async () => {
    const stage = new ActionStage();
    stage.stage(tag);
    const { recorder, conversationId } = await recorderFor(true, stage);
    const settled = result();
    await recorder.settle(settled, 'answered_inline');
    expect((await agentRow(conversationId)).actions?.map(action => action.status)).toEqual([
      'staged',
    ]);
    expect(recorder.performable(settled)).toEqual([tag]);
  });

  it("keeps only the handoff note through the model's own escalation", async () => {
    const stage = new ActionStage();
    stage.stage(tag);
    stage.stage(note);
    const { recorder, conversationId } = await recorderFor(true, stage);
    const settled = escalating('model');
    await recorder.settle(settled, 'escalated_model');
    expect(recorder.performable(settled)).toEqual([note]);
    const statuses = (await agentRow(conversationId)).actions?.map(
      action => `${action.tool}:${action.status}`,
    );
    expect(statuses).toEqual(['add_tag:discarded', 'write_note:staged']);
    expect((await store.find('demo', 's1'))?.escalatedAt).not.toBeNull();
  });

  it('keeps nothing through an escalation the leak guardrail made', async () => {
    const stage = new ActionStage();
    stage.stage(note);
    const { recorder } = await recorderFor(true, stage);
    expect(recorder.performable(escalating('leak'))).toEqual([]);
  });

  it('discards everything on a superseded reply', async () => {
    const stage = new ActionStage();
    stage.stage(tag);
    const { recorder, conversationId } = await recorderFor(true, stage);
    await recorder.settle(result(), 'superseded');
    expect((await agentRow(conversationId)).actions?.map(action => action.status)).toEqual([
      'discarded',
    ]);
  });
});
