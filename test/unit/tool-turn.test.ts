import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ToolsSchema } from '../../src/contracts/config.ts';
import { ActionStage } from '../../src/agent/tools.ts';
import { ToolTurn, fitsOffering } from '../../src/agent/tools/turn.ts';

/**
 * What every tool of a turn reads as it runs, apart from the tools.
 * specs/034 § Until intent is prospect, the sale's tools refuse; specs/028
 * § A flow belongs to one offering or to all; specs/023 § The funnel is a
 * field the agent moves (forward only). Runs against the invented fixture
 * tenant's tools.json.
 */

const config = ToolsSchema.parse(
  JSON.parse(readFileSync('test/fixtures/config/tools.json', 'utf8')),
);
const field = (id: string, fieldName: string, value: string, extra: { offering?: true } = {}) =>
  ({ tool: 'set_field', id, field: fieldName, value, ...extra }) as const;

describe('the intent gate (specs/034)', () => {
  it('is closed until the contact is a prospect', () => {
    const turn = new ToolTurn(config, new ActionStage(), { sentFlows: new Set() }, {});
    expect(turn.closed()).toBe(true);
  });

  it('opens on a prospect staged earlier in the same turn', () => {
    const stage = new ActionStage();
    const turn = new ToolTurn(config, stage, { sentFlows: new Set() }, {});
    stage.stage(field('intent', 'intent', 'prospect'));
    expect(turn.turnIntent()).toBe('prospect');
    expect(turn.closed()).toBe(false);
  });

  it('stays open for a contact already known to be a prospect', () => {
    const contact = { sentFlows: new Set<string>(), intent: 'prospect' as const };
    expect(new ToolTurn(config, new ActionStage(), contact, {}).closed()).toBe(false);
  });
});

describe("the turn's offering (specs/028)", () => {
  it("is the contact's until the turn stages another", () => {
    const stage = new ActionStage();
    const contact = { sentFlows: new Set<string>(), offering: 'foundation' };
    const turn = new ToolTurn(config, stage, contact, {});
    expect(turn.turnOffering()).toBe('foundation');
    stage.stage(field('course', 'course', 'advanced', { offering: true }));
    expect(turn.turnOffering()).toBe('advanced');
  });

  it('admits a flow of that offering, or of every offering', () => {
    expect(fitsOffering({ offering: 'advanced' }, 'advanced')).toBe(true);
    expect(fitsOffering({}, 'advanced')).toBe(true);
    expect(fitsOffering({ offering: 'foundation' }, 'advanced')).toBe(false);
  });
});

describe('the stage floor (specs/023)', () => {
  it("starts at the contact's last performed stage and rises with what the turn stages", () => {
    const stage = new ActionStage();
    const contact = { sentFlows: new Set<string>(), funnelStage: 'qualifying' };
    const turn = new ToolTurn(config, stage, contact, {});
    expect(turn.stageFloor()).toBe(1);
    stage.stage(field('funnel_stage', 'funnel_stage', 'offered'));
    expect(turn.stageFloor()).toBe(3);
  });

  it('counts a payment link on its way out at link_sent (specs/029)', () => {
    const turn = new ToolTurn(config, new ActionStage(), { sentFlows: new Set() }, {});
    turn.linkStarting += 1;
    expect(turn.stageFloor()).toBe(5);
  });
});

describe('the flows offered (specs/023, specs/032)', () => {
  it('leave out the opening and a send-once flow the contact already had', () => {
    const once = config.flows.find(flow => !flow.repeatable && flow.role !== 'opening')!;
    const turn = new ToolTurn(config, new ActionStage(), { sentFlows: new Set([once.id]) }, {});
    const offered = turn.unsent.map(flow => flow.id);
    expect(offered).not.toContain(once.id);
    expect(turn.unsent.some(flow => flow.role === 'opening')).toBe(false);
  });
});
