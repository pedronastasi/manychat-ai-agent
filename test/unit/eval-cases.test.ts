/**
 * specs/009-tenant-eval-suites.md § Verification.
 *
 * The assertions themselves, not a model call: these run against a reply built
 * in the test, which is the whole reason `cases.ts` is separate from `run.ts`.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import {
  Case,
  DEFAULT_EVAL_DIR,
  checkCase,
  classify,
  endsWithQuestion,
  evalDir,
  loadCases,
} from '../../evals/cases.ts';
import { loadTenantConfig } from '../../src/config/loader.ts';
import type { AgentReply } from '../../src/contracts/agent.ts';

const { catalog } = loadTenantConfig('test/fixtures/config');

const replyOf = (messages: string[], overrides: Partial<AgentReply> = {}): AgentReply => ({
  messages,
  escalate: false,
  escalation_reason: null,
  confidence: 0.9,
  ...overrides,
});

const check = (raw: unknown, reply: AgentReply, latencyMs = 100) =>
  checkCase({ testCase: Case.parse(raw), reply, catalog, latencyMs, raceDeadlineMs: 8000 });

const base = { id: 'test', text: 'hello', expect: { escalate: false } };

describe('suite loading (specs/009 § A suite is selected the way the config already is)', () => {
  it('parses every committed suite', () => {
    const suites = readdirSync('evals', { withFileTypes: true })
      .filter(entry => entry.isDirectory() && existsSync(`evals/${entry.name}/cases.jsonl`))
      .map(entry => `evals/${entry.name}`);

    expect(suites.length).toBeGreaterThan(0);
    for (const suite of suites) expect(() => loadCases(suite)).not.toThrow();
  });

  it('defaults to the golden set and honours EVAL_DIR', () => {
    expect(evalDir({})).toBe(DEFAULT_EVAL_DIR);
    expect(evalDir({ EVAL_DIR: 'evals/tenant' })).toBe('evals/tenant');
  });
});

describe('history (specs/009 § A case carries history)', () => {
  it('is absent from the golden set, which is what makes the change additive', () => {
    const lines = readFileSync(`${DEFAULT_EVAL_DIR}/cases.jsonl`, 'utf8')
      .split('\n')
      .filter(line => line.trim());

    for (const line of lines) {
      expect(Object.keys(JSON.parse(line) as object)).not.toContain('history');
    }
    // ...and every one of them still parses, defaulted to no history.
    for (const parsed of loadCases(DEFAULT_EVAL_DIR)) expect(parsed.history).toEqual([]);
  });

  it('carries prior turns through when declared', () => {
    const parsed = Case.parse({
      ...base,
      history: [{ role: 'agent', text: 'The Foundation Course is $450. Want the schedule?' }],
    });
    expect(parsed.history).toHaveLength(1);
  });
});

describe('substring assertions (specs/009 § Two substring assertions replace four bespoke ones)', () => {
  it('reports missing required text and present forbidden text', () => {
    const reply = replyOf(['The Foundation Course is $450.']);
    expect(check({ ...base, must_contain: ['$450'] }, reply)).toEqual([]);
    expect(check({ ...base, must_contain: ['$680'] }, reply)).toEqual([
      'missing required text: $680',
    ]);
    expect(check({ ...base, must_not_contain: ['$450'] }, reply)).toEqual([
      'forbidden text present: $450',
    ]);
  });

  it('matches case-sensitively, because the strings that matter are not prose', () => {
    const reply = replyOf(['See https://example.com/enrol/foundation']);
    expect(check({ ...base, must_not_contain: ['https://EXAMPLE.com'] }, reply)).toEqual([]);
  });

  it('searches across all messages, not just the first', () => {
    const reply = replyOf(['One moment.', 'It is $450.']);
    expect(check({ ...base, must_contain: ['$450'] }, reply)).toEqual([]);
  });

  /** The ordered-disclosure pair the spec argues for, against the demo tenant. */
  it('expresses an ordered disclosure as a pair of cases', () => {
    const url = 'https://example.com/enrol/foundation';
    const gated = { ...base, text: 'just send me the signup link', must_not_contain: [url] };
    const released = { ...base, text: 'yes please', must_contain: [url] };

    const withheld = replyOf(['Which course did you have in mind?']);
    const sent = replyOf([`Here you go: ${url}`]);

    expect(check(gated, withheld)).toEqual([]);
    expect(check(gated, sent)).toHaveLength(1);
    // The second half is what a single case cannot prove: an agent that always
    // withholds passes `gated` and fails here.
    expect(check(released, sent)).toEqual([]);
    expect(check(released, withheld)).toHaveLength(1);
  });
});

describe('must_end_with_question (specs/009 § A message that ends in a full stop)', () => {
  it('ignores trailing whitespace and emoji', () => {
    expect(endsWithQuestion('Want the schedule?')).toBe(true);
    expect(endsWithQuestion('Want the schedule? \u{1F90D}  ')).toBe(true);
    expect(endsWithQuestion('Want the schedule.')).toBe(false);
  });

  it('handles a ZWJ emoji sequence without splitting it', () => {
    expect(endsWithQuestion('Shall we start? \u{1F469}\u200D\u{1F393}')).toBe(true);
  });

  it('does not strip trailing digits, which Emoji_Component would have', () => {
    // '\p{Emoji_Component}' includes 0-9. Stripping it would turn this into
    // 'Ready?' and pass a message that plainly does not end in a question.
    expect(endsWithQuestion('Ready? 450')).toBe(false);
  });

  it('is asserted on the final message only', () => {
    const reply = replyOf(['It is $450.', 'Want the schedule?']);
    expect(check({ ...base, must_end_with_question: true }, reply)).toEqual([]);

    const trailing = replyOf(['Want the schedule?', 'It is $450.']);
    expect(check({ ...base, must_end_with_question: true }, trailing)).toEqual([
      'final message does not end with a question',
    ]);
  });
});

describe('max_lines (specs/009 § Register is the assertion that cannot be one)', () => {
  it('applies per message, not per reply', () => {
    // Two messages of three lines each: six lines in total, none over the cap.
    const reply = replyOf(['a\nb\nc', 'd\ne\nf']);
    expect(check({ ...base, max_lines: 3 }, reply)).toEqual([]);
    expect(check({ ...base, max_lines: 2 }, reply)).toEqual([
      'message of 3 lines exceeds max_lines 2',
    ]);
  });
});

describe('classify (specs/009 § Verification)', () => {
  it('counts a review case as reviewed rather than passed', () => {
    expect(classify([], undefined)).toBe('passed');
    expect(classify([], 'reads as warm and human')).toBe('reviewed');
  });

  it('still fails a review case that broke a real assertion', () => {
    expect(classify(['forbidden text present: discount'], 'reads as warm')).toBe('failed');
  });

  it('reports zero passed for a suite of nothing but review cases', () => {
    const statuses = ['warm', 'on brand', 'not pushy'].map(review => classify([], review));
    expect(statuses.filter(status => status === 'passed')).toHaveLength(0);
    expect(statuses.filter(status => status === 'reviewed')).toHaveLength(3);
  });
});

describe('existing assertions still hold (specs/009 § additive)', () => {
  it('flags an ungrounded price and a latency overrun', () => {
    const reply = replyOf(['It is $999 today only.']);
    expect(check({ ...base, must_not_invent_prices: true }, reply)).toEqual([
      'ungrounded price(s): 999',
    ]);
    expect(check(base, replyOf(['fine']), 9000)).toEqual(['latency 9000ms exceeds race deadline']);
  });

  it('flags an escalation mismatch and a reason mismatch', () => {
    const escalated = replyOf(['Let me get someone.'], {
      escalate: true,
      escalation_reason: 'complaint',
    });
    expect(check({ ...base, expect: { escalate: false } }, escalated)).toEqual([
      'escalate expected false, got true',
    ]);
    expect(
      check({ ...base, expect: { escalate: true, reason: 'price_negotiation' } }, escalated),
    ).toEqual(['reason expected price_negotiation, got complaint']);
  });
});
