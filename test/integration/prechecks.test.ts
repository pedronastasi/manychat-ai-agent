import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDatabase } from '../helpers/db.ts';
import type { Database } from '../../src/db/client.ts';
import { BudgetGuard } from '../../src/conversation/budget.ts';
import { RulesSchema } from '../../src/contracts/config.ts';
import type { InboundMessage } from '../../src/contracts/agent.ts';
import { Prechecks } from '../../src/turn/prechecks.ts';
import { offeringOf } from '../../src/turn/context.ts';

/**
 * What a turn is answered with before the model (C6): the opening sentinel
 * first, since the caps bound model spend and a scripted reply incurs none,
 * then the guards. specs/019 § Only bound turns enter history and the turn
 * cap; specs/020: media has no words to match until it is transcribed.
 * specs/028: the request's offering wins over the kept one. Every value is
 * invented.
 */

let db: Database;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
});
afterEach(async () => {
  await close();
});

const rules = RulesSchema.parse({
  messages: { acknowledgement: 'One moment.', escalation: 'Passing you to a person.' },
  budget: { dailyTokenCap: 100_000, dailyCostCapUsd: 5 },
  rateLimit: { turnsPerSubscriberPerHour: 60 },
  maxTurnsPerConversation: 3,
  escalationKeywords: ['refund'],
  openingTrigger: { keywords: ['start workflow'], message: 'Hi! How can I help?' },
});

const prechecks = () => new Prechecks({ budget: new BudgetGuard(db), rules });

const inbound = (text: string, extra: Partial<InboundMessage> = {}): InboundMessage => ({
  tenantId: 'demo',
  subscriberId: 's1',
  text,
  channel: 'whatsapp',
  contactName: null,
  locale: null,
  contactToken: null,
  receivedAt: new Date(),
  ...extra,
});

describe('prechecks (C6)', () => {
  it('lets an ordinary message through to the model', async () => {
    expect(
      await prechecks().check(inbound('When does the course start?'), {
        turnCount: 1,
        bound: true,
      }),
    ).toBeUndefined();
  });

  it('answers the opening sentinel with the scripted reply, even over the cap', async () => {
    const precheck = await prechecks().check(inbound('start workflow'), {
      turnCount: 99,
      bound: true,
    });
    expect(precheck).toMatchObject({
      outcome: 'answered_scripted',
      reply: { messages: ['Hi! How can I help?'], escalate: false },
    });
  });

  it('hands an escalation keyword to a person', async () => {
    const precheck = await prechecks().check(inbound('I want a refund'), {
      turnCount: 1,
      bound: true,
    });
    expect(precheck).toMatchObject({
      outcome: 'escalated_precheck',
      reply: { messages: ['Passing you to a person.'], escalate: true },
    });
  });

  it('holds a bound turn to the cap, and an unbound one only to the rate limit (specs/019)', async () => {
    const over = { turnCount: 4 };
    expect((await prechecks().check(inbound('Hello'), { ...over, bound: true }))?.outcome).toBe(
      'escalated_precheck',
    );
    expect(await prechecks().check(inbound('Hello'), { ...over, bound: false })).toBeUndefined();
  });

  it('matches no keyword on media, whose words come with its transcript (specs/020)', async () => {
    const media = { kind: 'audio' as const, url: 'https://media.example.com/clip.ogg' };
    expect(
      await prechecks().check(inbound('refund', { media }), { turnCount: 1, bound: true }),
    ).toBeUndefined();
  });
});

describe('offeringOf (specs/028)', () => {
  it("prefers the request's offering and names the one it replaced", () => {
    expect(offeringOf('evening-course', 'weekend-course')).toEqual({
      offering: 'evening-course',
      offeringChangedFrom: 'weekend-course',
    });
  });

  it('keeps the stored offering when the request carries none', () => {
    expect(offeringOf(undefined, 'weekend-course')).toEqual({
      offering: 'weekend-course',
      offeringChangedFrom: undefined,
    });
  });

  it('names no change when the two agree', () => {
    expect(offeringOf('weekend-course', 'weekend-course').offeringChangedFrom).toBeUndefined();
  });
});
