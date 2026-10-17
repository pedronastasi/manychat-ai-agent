import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDatabase } from '../helpers/db.ts';
import type { Database } from '../../src/db/client.ts';
import { nudges } from '../../src/db/schema.ts';
import { ConversationStore } from '../../src/conversation/store.ts';
import { BudgetGuard } from '../../src/conversation/budget.ts';
import { NudgeStore } from '../../src/nudge/store.ts';
import { OutboxQueue } from '../../src/outbox/queue.ts';
import { NO_TOOLS, RulesSchema } from '../../src/contracts/config.ts';
import type { InboundMessage, PerformableAction } from '../../src/contracts/agent.ts';
import type { ActionPerformer, ContactReader } from '../../src/channels/manychat/client.ts';
import { TurnScope } from '../../src/turn/scope.ts';
import type { ScopedTurn } from '../../src/turn/scope.ts';

/**
 * TurnScope builds one admitted turn's collaborators (ADR-0023). These pin the
 * rules it wires rather than decides: specs/024 § Only a turn that reads
 * history may read the contact; specs/025 § The agent schedules a nudge; it
 * does not send one; specs/037 § A reply never overtakes an earlier one. Every
 * value is invented.
 */

let db: Database;
let close: () => Promise<void>;
let store: ConversationStore;
let conversationId: string;
beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
  store = new ConversationStore(db);
  const conversation = await store.startTurn(
    { tenantId: 'demo', subscriberId: 's1', channel: 'whatsapp', idleResetHours: 24 },
    new Date(),
  );
  conversationId = conversation.id;
});
afterEach(async () => {
  await close();
});

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const rules = RulesSchema.parse({
  messages: { acknowledgement: 'One moment.', escalation: 'Passing you to a person.' },
  budget: { dailyTokenCap: 100_000, dailyCostCapUsd: 5 },
  rateLimit: { turnsPerSubscriberPerHour: 60 },
});

class RecordingPerformer implements ActionPerformer {
  readonly performed: PerformableAction[] = [];
  performAction(_subscriberId: string, action: PerformableAction): Promise<void> {
    this.performed.push(action);
    return Promise.resolve();
  }
}

class NoContact implements ContactReader {
  readContact(): Promise<never> {
    return Promise.reject(new Error('not read in these tests'));
  }
}

const inbound: InboundMessage = {
  tenantId: 'demo',
  subscriberId: 's1',
  channel: 'whatsapp',
  text: 'When does the evening course start?',
  contactName: null,
  locale: null,
  contactToken: null,
  receivedAt: new Date(),
};

const scopeOf = (opts: { contacts?: ContactReader; actions?: ActionPerformer } = {}) =>
  new TurnScope({
    store,
    budget: new BudgetGuard(db),
    queue: new OutboxQueue(db),
    nudges: new NudgeStore(db),
    rules,
    tools: NO_TOOLS,
    actions: opts.actions ?? new RecordingPerformer(),
    contacts: opts.contacts,
    logger,
  });

const turnOf = (turn: Partial<ScopedTurn> = {}): ScopedTurn => ({
  inbound,
  conversationId,
  bound: true,
  readsHistory: true,
  logger,
  late: false,
  deadlineAt: Date.now() + 1_000,
  ...turn,
});

describe('TurnScope (ADR-0023)', () => {
  it('offers the contact read only to a turn that reads history (specs/024 § Only a turn that reads history may read the contact)', () => {
    const scope = scopeOf({ contacts: new NoContact() });
    expect(scope.open(turnOf()).reads).toBeDefined();
    expect(scope.open(turnOf({ readsHistory: false })).reads).toBeUndefined();
    expect(scopeOf().open(turnOf()).reads).toBeUndefined();
    expect(scopeOf().open(turnOf()).pluginReads).toBeUndefined();
  });

  it('builds every collaborator afresh, so two turns share no state (ADR-0023)', () => {
    const scope = scopeOf();
    const first = scope.open(turnOf());
    const second = scope.open(turnOf());
    expect(second.stage).not.toBe(first.stage);
    expect(second.flows).not.toBe(first.flows);
    expect(second.recorder).not.toBe(first.recorder);
    expect(second.delivery).not.toBe(first.delivery);
  });

  it('queues every reply of a turn whose response was already sent (specs/037 § A reply never overtakes an earlier one)', async () => {
    const scope = scopeOf();
    expect(await scope.open(turnOf()).delivery.mustQueue()).toBe(false);
    expect(await scope.open(turnOf({ late: true })).delivery.mustQueue()).toBe(true);
  });

  it('schedules a nudge on the conversation instead of sending one (specs/025 § The agent schedules a nudge; it does not send one)', async () => {
    const actions = new RecordingPerformer();
    await scopeOf({ actions })
      .performer(conversationId)
      .performAction('s1', { tool: 'schedule_nudge', id: 'n1', minutes: 30 });
    expect(actions.performed).toEqual([]);
    const pending = await db.select().from(nudges);
    expect(pending.map(row => [row.conversationId, row.status])).toEqual([
      [conversationId, 'pending'],
    ]);
  });
});
