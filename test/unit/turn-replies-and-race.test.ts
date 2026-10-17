import { describe, it, expect, afterEach, vi } from 'vitest';
import { raceDeadline } from '../../src/turn/race.ts';
import { modelOutcomeOf, plainReply } from '../../src/turn/replies.ts';
import type { AgentResult } from '../../src/agent/runner.ts';

/**
 * The race and outcome helpers the turn is built from. C7: the model races a
 * deadline fixed at the request's arrival (specs/002, specs/037). specs/012:
 * a failed call is recorded as `error`, never as the model's own escalation.
 */

afterEach(() => {
  vi.useRealTimers();
});

describe('raceDeadline (C7)', () => {
  it('settles with the work when it finishes first', async () => {
    await expect(raceDeadline(Promise.resolve('done'), Date.now() + 1_000)).resolves.toBe('done');
  });

  it('settles with the deadline at that point in time, not after a fresh delay', async () => {
    vi.useFakeTimers();
    const deadlineAt = Date.now() + 1_000;
    vi.advanceTimersByTime(600);
    const raced = raceDeadline(new Promise<never>(() => {}), deadlineAt);
    await vi.advanceTimersByTimeAsync(400);
    await expect(raced).resolves.toBe('deadline');
  });

  it('settles at once when the deadline has already passed', async () => {
    vi.useFakeTimers();
    const raced = raceDeadline(new Promise<never>(() => {}), Date.now() - 50);
    await vi.advanceTimersByTimeAsync(0);
    await expect(raced).resolves.toBe('deadline');
  });

  it('passes a failure of the work through, and leaves no timer behind', async () => {
    vi.useFakeTimers();
    await expect(
      raceDeadline(Promise.reject(new Error('boom')), Date.now() + 1_000),
    ).rejects.toThrow('boom');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('plainReply', () => {
  it('hands nothing to a person and appends no closing question', () => {
    expect(plainReply(['Hello'])).toEqual({
      messages: ['Hello'],
      escalate: false,
      escalation_reason: null,
      confidence: 1,
      closing_question: null,
    });
  });
});

describe('modelOutcomeOf (specs/012)', () => {
  const result = (reply: Partial<AgentResult['reply']>, extra: Partial<AgentResult> = {}) =>
    ({ reply: { ...plainReply(['Hi']), ...reply }, ...extra }) as AgentResult;

  it('records an answer as answered inline', () => {
    expect(modelOutcomeOf(result({}))).toBe('answered_inline');
  });

  it("records the model's escalation as its own", () => {
    expect(modelOutcomeOf(result({ escalate: true }))).toBe('escalated_model');
  });

  it('records a failed call as an error, though it escalates too', () => {
    expect(modelOutcomeOf(result({ escalate: true }, { modelError: 'TimeoutError' }))).toBe(
      'error',
    );
  });
});
