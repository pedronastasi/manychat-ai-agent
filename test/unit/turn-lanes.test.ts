import { describe, it, expect, afterEach, vi } from 'vitest';
import { TurnLanes } from '../../src/conversation/turns.ts';

/**
 * specs/037-one-turn-at-a-time-per-contact.md § Verification item 1: a
 * contact's turns enter one at a time, in arrival order, another contact's
 * never wait for them, and a wait ends at its bound.
 */

afterEach(() => {
  vi.useRealTimers();
});

describe("a contact's turns (specs/037 V1)", () => {
  it('enter one at a time, in the order they asked', async () => {
    const lanes = new TurnLanes(60_000);
    const entered: string[] = [];
    const first = lanes.enter('demo:s1');
    const second = lanes.enter('demo:s1');
    const third = lanes.enter('demo:s1');
    expect([first.waited, second.waited, third.waited]).toEqual([false, true, true]);

    void first.ready.then(() => entered.push('first'));
    void second.ready.then(() => entered.push('second'));
    void third.ready.then(() => entered.push('third'));
    await Promise.resolve();
    await Promise.resolve();
    expect(entered).toEqual(['first']);

    first.leave();
    await expect(second.ready).resolves.toBe('ready');
    expect(entered).toEqual(['first', 'second']);
    second.leave();
    await third.ready;
    expect(entered).toEqual(['first', 'second', 'third']);
  });

  it("never wait for another contact's", async () => {
    const lanes = new TurnLanes(60_000);
    lanes.enter('demo:s1');
    const other = lanes.enter('demo:s2');
    expect(other.waited).toBe(false);
    await expect(other.ready).resolves.toBe('ready');
  });

  it('stop waiting once the earlier turn outruns the bound (C6)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const lanes = new TurnLanes(1_000);
    lanes.enter('demo:s1');
    const stuck = lanes.enter('demo:s1');
    let state: string | undefined;
    void stuck.ready.then(value => (state = value));
    await vi.advanceTimersByTimeAsync(999);
    expect(state).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(state).toBe('expired');
  });

  it('let a turn straight in once the contact has none left', async () => {
    const lanes = new TurnLanes(60_000);
    const only = lanes.enter('demo:s1');
    only.leave();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(lanes.enter('demo:s1').waited).toBe(false);
  });
});
