import { describe, it, expect } from 'vitest';
import { foldable, supersedes } from '../../src/turn/fold.ts';
import { RulesSchema } from '../../src/contracts/config.ts';
import type { InboundMessage } from '../../src/contracts/agent.ts';
import type { AgentResult } from '../../src/agent/runner.ts';
import { plainReply } from '../../src/turn/replies.ts';
import { escalationReply } from '../../src/agent/guardrails.ts';

/**
 * specs/046-one-reply-to-a-burst-of-bubbles.md: § A waiting message is folded
 * into the next one, and § A reply the contact wrote past is superseded. The
 * two rules, apart from the lanes that apply them. Every value is invented.
 */

const rules = RulesSchema.parse({
  messages: { acknowledgement: 'One moment.', escalation: 'Passing you to a person.' },
  budget: { dailyTokenCap: 100_000, dailyCostCapUsd: 5 },
  rateLimit: { turnsPerSubscriberPerHour: 60 },
  escalationKeywords: ['refund'],
  openingTrigger: { keywords: ['start workflow'], message: 'Hi! How can I help?' },
  foldBursts: true,
});

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

describe('a waiting message folds (specs/046)', () => {
  it('when it is plain text the next turn can read', () => {
    expect(foldable(inbound('and on weekends?'), rules)).toBe(true);
  });

  it('never when media, the opening sentinel or a keyword would answer it differently', () => {
    const media = { kind: 'image' as const, url: 'https://media.example.com/photo.jpg' };
    expect(foldable(inbound('', { media }), rules)).toBe(false);
    expect(foldable(inbound('start workflow'), rules)).toBe(false);
    expect(foldable(inbound('I want a refund'), rules)).toBe(false);
  });
});

describe('a reply the contact wrote past is superseded (specs/046)', () => {
  const result = (overrides: Partial<AgentResult> = {}): AgentResult => ({
    reply: plainReply(['The course runs on Tuesdays.']),
    model: 'mock:demo',
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, costUsd: 0 },
    interventions: [],
    latencyMs: 5,
    toolsOffered: false,
    ...overrides,
  });
  const turn = { rules, media: false, followed: true, flowsSent: 0 };

  it('when the contact wrote again and nothing reached them', () => {
    expect(supersedes(result(), turn)).toBe(true);
  });

  it('never when the contact did not write again, or folding is off', () => {
    expect(supersedes(result(), { ...turn, followed: false })).toBe(false);
    expect(supersedes(result(), { ...turn, rules: { ...rules, foldBursts: false } })).toBe(false);
  });

  it('never once a flow reached them, on a media turn, or on a handoff or failed call', () => {
    expect(supersedes(result(), { ...turn, flowsSent: 1 })).toBe(false);
    expect(supersedes(result(), { ...turn, media: true })).toBe(false);
    const handoff = escalationReply('low_confidence', 'Passing you to a person.');
    expect(supersedes(result({ reply: handoff }), turn)).toBe(false);
    expect(supersedes(result({ modelError: 'TimeoutError' }), turn)).toBe(false);
  });
});
