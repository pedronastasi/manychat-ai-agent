import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '../helpers/db.ts';
import type { Database } from '../../src/db/client.ts';
import { conversations, turns } from '../../src/db/schema.ts';
import { TurnHandler } from '../../src/routes/turn.ts';
import type { AgentResult, AgentRunner, AgentTurnInput } from '../../src/agent/runner.ts';
import { ActionStage, buildTools } from '../../src/agent/tools.ts';
import { RulesSchema } from '../../src/contracts/config.ts';
import type { InboundMessage } from '../../src/contracts/agent.ts';
import { loadTenantConfig } from '../../src/config/loader.ts';
import { ConversationStore } from '../../src/conversation/store.ts';
import { NudgeStore } from '../../src/nudge/store.ts';
import { NudgeWorker } from '../../src/nudge/worker.ts';
import { OutboxWorker } from '../../src/outbox/worker.ts';
import { ManyChatHttpClient } from '../../src/channels/manychat/client.ts';
import type { ContactRecord } from '../../src/contracts/manychat.ts';
import { FakeActions, FakeContactFields, fakeManyChatApi } from '../helpers/manychat.ts';
import { asProspect } from '../helpers/intent.ts';

/**
 * specs/028-multi-course-funnels.md § Verification item 5: the conversation's
 * course is updated from inbound values and from `performed` writes, inbound
 * wins, and a nudge turn uses the stored value. Against PGlite and the
 * fictional demo tenant in test/fixtures/config.
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

const fixture = loadTenantConfig('test/fixtures/config');
const tools = fixture.tools!;

const rules = RulesSchema.parse({
  messages: { acknowledgement: 'One moment.', escalation: 'Passing you to a person.' },
  budget: { dailyTokenCap: 100_000, dailyCostCapUsd: 5 },
  rateLimit: { turnsPerSubscriberPerHour: 60 },
});

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const MINUTE_MS = 60_000;

const inbound = (course?: string | null, subscriberId = 's1'): InboundMessage => ({
  tenantId: 'demo',
  subscriberId,
  text: 'tell me more',
  channel: 'whatsapp',
  contactName: null,
  locale: null,
  contactToken: contactFields.tokenOf(subscriberId),
  course,
  receivedAt: new Date(),
});

/**
 * A model that records what it was given and, when `course` is set, writes
 * the course field through the real tools.
 */
function courseRunner(opts: { course?: string; delayMs?: number } = {}) {
  const inputs: AgentTurnInput[] = [];
  const runner: AgentRunner = {
    run: async input => {
      inputs.push(input);
      const stage = input.stage ?? new ActionStage();
      const built = buildTools(tools, stage, asProspect(input.contact), undefined, {
        nudgeTurn: input.nudge !== undefined,
      });
      if (opts.course) {
        await built?.set_field?.execute?.(
          { field: 'course', value: opts.course },
          { toolCallId: 'test', messages: [], context: {} },
        );
      }
      if (opts.delayMs) await new Promise(resolve => setTimeout(resolve, opts.delayMs));
      const result: AgentResult = {
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
      };
      return result;
    },
  };
  return { runner, inputs };
}

const handler = (runner: AgentRunner, actions = new FakeActions()) =>
  new TurnHandler({
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

const storedCourse = async (subscriberId = 's1') =>
  (
    await db.query.conversations.findFirst({
      where: eq(conversations.subscriberId, subscriberId),
    })
  )?.course;

describe('the conversation keeps the course a request carries (specs/028 V5)', () => {
  it('records the inbound course, and records a change to it', async () => {
    const { runner, inputs } = courseRunner();
    await handler(runner).handle(inbound('foundation'));
    expect(await storedCourse()).toBe('foundation');
    expect(inputs[0]!.contact).toMatchObject({ course: 'foundation' });
    expect(inputs[0]!.contact?.courseChangedFrom).toBeUndefined();

    // A second course's advert, mid-sale: taken, and the change is noted.
    await handler(runner).handle(inbound('advanced'));
    expect(await storedCourse()).toBe('advanced');
    expect(inputs[1]!.contact).toMatchObject({
      course: 'advanced',
      courseChangedFrom: 'foundation',
    });
  });

  it('keeps the stored course when the request carries none it knows', async () => {
    const { runner, inputs } = courseRunner();
    await handler(runner).handle(inbound('foundation'));
    for (const absent of ['', '{{course}}', 'not-a-course', null, undefined]) {
      await handler(runner).handle(inbound(absent));
    }
    expect(await storedCourse()).toBe('foundation');
    expect(inputs.slice(1).map(input => input.contact?.course)).toEqual(
      Array(5).fill('foundation'),
    );
  });
});

describe('only a bound request stores its course (specs/028 V5, specs/019)', () => {
  it('uses an unbound request’s course for the turn, without storing it', async () => {
    const { runner, inputs } = courseRunner();
    await handler(runner).handle(inbound('foundation'));
    expect(await storedCourse()).toBe('foundation');

    // The contact now holds a token, and this request does not carry it.
    const unbound: InboundMessage = { ...inbound('advanced'), contactToken: null };
    await handler(runner).handle(unbound);
    expect(inputs[1]!.contact).toMatchObject({
      course: 'advanced',
      courseChangedFrom: 'foundation',
    });
    expect(await storedCourse()).toBe('foundation');
  });
});

describe('a stored course the catalog no longer has is no course (specs/028 V5)', () => {
  it('ignores it on a turn, and replaces it from the next request', async () => {
    const { runner, inputs } = courseRunner();
    await handler(runner).handle(inbound(null));
    await db.update(conversations).set({ course: 'retired-course' });

    await handler(runner).handle(inbound(null));
    expect(inputs[1]!.contact?.course).toBeUndefined();

    await handler(runner).handle(inbound('advanced'));
    expect(inputs[2]!.contact).toMatchObject({ course: 'advanced' });
    expect(inputs[2]!.contact?.courseChangedFrom).toBeUndefined();
    expect(await storedCourse()).toBe('advanced');
  });
});

describe('the conversation keeps a course this service wrote (specs/028 V5)', () => {
  it('inline: records the course once the write is performed', async () => {
    const out = await handler(courseRunner({ course: 'advanced' }).runner).handle(inbound(null));
    expect(await storedCourse()).toBeNull();
    await out.afterResponse!();
    expect(await storedCourse()).toBe('advanced');
  });

  it('inline: records nothing when ManyChat refuses the write', async () => {
    const actions = new FakeActions();
    actions.failing = true;
    const out = await handler(courseRunner({ course: 'advanced' }).runner, actions).handle(
      inbound('foundation'),
    );
    await out.afterResponse!();
    expect(await storedCourse()).toBe('foundation');
  });

  it('deferred: records the course once the outbox worker performs the write', async () => {
    const out = await handler(
      courseRunner({ course: 'weekend-intensive', delayMs: 400 }).runner,
    ).handle(inbound(null));
    expect(out.outcome).toBe('deferred');
    // The reply row, not the contact token issued to this new contact.
    await vi.waitFor(async () =>
      expect((await db.query.outbox.findMany()).map(row => row.kind)).toContain('reply'),
    );

    const api = fakeManyChatApi();
    const client = new ManyChatHttpClient({
      apiToken: 'test-token',
      baseUrl: 'https://api.example.com',
      replyField: 'ai_message',
      replyFlowNs: 'reply_flow',
      tokenField: 'ai_token',
      fetchImpl: api.fetch,
    });
    await new OutboxWorker({ db, client, logger }).drainOnce();
    expect(await storedCourse()).toBe('weekend-intensive');
  });

  it('lets the next request win over a course this service wrote', async () => {
    const out = await handler(courseRunner({ course: 'advanced' }).runner).handle(inbound(null));
    await out.afterResponse!();
    expect(await storedCourse()).toBe('advanced');

    // ManyChat's value at request time already holds every write performed,
    // so a different one there is newer than the row.
    const { runner, inputs } = courseRunner();
    await handler(runner).handle(inbound('foundation'));
    expect(inputs[0]!.contact?.course).toBe('foundation');
    expect(await storedCourse()).toBe('foundation');
  });
});

describe('a nudge turn uses the stored course (specs/028 V5)', () => {
  it.each([
    ['advanced', 'advanced'],
    ['retired-course', undefined],
  ])('passes the stored course %s to the model as %s', async (stored, expected) => {
    const store = new ConversationStore(db);
    const wroteAt = new Date(Date.now() - 120 * MINUTE_MS);
    const conversation = await store.startTurn(
      { tenantId: 'demo', subscriberId: 's1', channel: 'whatsapp', idleResetHours: 24 },
      wroteAt,
    );
    await db.insert(turns).values({
      conversationId: conversation.id,
      role: 'user',
      text: 'when are the classes?',
      createdAt: wroteAt,
    });
    await store.setCourse(conversation.id, stored);
    await new NudgeStore(db).schedule(conversation.id, 119, wroteAt);

    const { runner, inputs } = courseRunner();
    const nudgeWorker = new NudgeWorker({
      db,
      runner,
      config: () => fixture,
      contacts: {
        readContact: (): Promise<ContactRecord> => Promise.resolve({ tags: [], custom_fields: [] }),
      },
      logger,
      modelAbortMs: 5000,
    });
    expect(await nudgeWorker.drainOnce()).toEqual(['sent']);
    expect(inputs[0]!.nudge).toBeDefined();
    expect(inputs[0]!.contact?.course).toBe(expected);
  });
});
