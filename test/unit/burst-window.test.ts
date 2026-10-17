import { describe, it, expect } from 'vitest';
import { TurnLanes } from '../../src/conversation/turns.ts';
import { RulesSchema } from '../../src/contracts/config.ts';

/**
 * specs/047-a-burst-window-before-the-model.md § Verification items 1 and 6:
 * a turn's quiet wait ends as soon as the contact writes again, and the window
 * is off by default and capped inside the race.
 */

const rules = {
  messages: { acknowledgement: 'One moment.', escalation: 'Passing you to a person.' },
  budget: {},
  rateLimit: {},
};

describe('a turn waiting for the contact to go quiet (specs/047 V1)', () => {
  it('settles at once when a later turn claims its place', async () => {
    const lanes = new TurnLanes(60_000);
    const first = lanes.enter('demo:s1');
    const started = Date.now();
    const quiet = first.quiet(5_000);
    lanes.enter('demo:s1').claim();
    expect(await quiet).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('settles false once the window passes in silence', async () => {
    const lanes = new TurnLanes(60_000);
    expect(await lanes.enter('demo:s1').quiet(30)).toBe(false);
  });

  it("is not woken by another contact's turn, or by a later turn that never claims", async () => {
    const lanes = new TurnLanes(60_000);
    const first = lanes.enter('demo:s1');
    const quiet = first.quiet(50);
    lanes.enter('demo:s2').claim();
    lanes.enter('demo:s1');
    expect(await quiet).toBe(false);
  });
});

describe('burstWindowMs (specs/047 V6)', () => {
  it('is 0 unless the tenant sets it', () => {
    expect(RulesSchema.parse(rules).burstWindowMs).toBe(0);
  });

  it('is refused past 4 seconds', () => {
    expect(RulesSchema.safeParse({ ...rules, burstWindowMs: 4_000 }).success).toBe(true);
    expect(RulesSchema.safeParse({ ...rules, burstWindowMs: 4_001 }).success).toBe(false);
  });
});
