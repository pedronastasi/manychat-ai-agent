import { describe, it, expect } from 'vitest';
import { TurnLanes } from '../../src/conversation/turns.ts';

/**
 * specs/045-one-reply-to-a-burst-of-bubbles.md § Verification item 1: a turn
 * is followed only by a later turn of the same contact that has claimed its
 * place and not left.
 */

describe('a turn followed by the contact (specs/045 V1)', () => {
  it('is followed once a later turn claims its place, and not before', () => {
    const lanes = new TurnLanes(60_000);
    const first = lanes.enter('demo:s1');
    const second = lanes.enter('demo:s1');
    expect(first.followed()).toBe(false);
    second.claim();
    expect(first.followed()).toBe(true);
    expect(second.followed()).toBe(false);
  });

  it('is no longer followed once the later turn leaves', () => {
    const lanes = new TurnLanes(60_000);
    const first = lanes.enter('demo:s1');
    const second = lanes.enter('demo:s1');
    second.claim();
    second.leave();
    expect(first.followed()).toBe(false);
  });

  it("is never followed by another contact's turn", () => {
    const lanes = new TurnLanes(60_000);
    const first = lanes.enter('demo:s1');
    lanes.enter('demo:s2').claim();
    expect(first.followed()).toBe(false);
  });

  it('is never followed by a turn that arrived before it', () => {
    const lanes = new TurnLanes(60_000);
    const first = lanes.enter('demo:s1');
    first.claim();
    const second = lanes.enter('demo:s1');
    expect(second.followed()).toBe(false);
  });
});
