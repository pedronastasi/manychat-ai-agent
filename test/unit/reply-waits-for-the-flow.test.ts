import { describe, it, expect } from 'vitest';
import { FlowSends } from '../../src/agent/flows.ts';
import { renderManyChat } from '../../src/channels/manychat/adapter.ts';
import { ToolsSchema, capabilitiesFor, MAX_SETTLE_SECONDS } from '../../src/contracts/config.ts';
import type { AgentReply, PerformableAction, StagedAction } from '../../src/contracts/agent.ts';
import type { ActionPerformer } from '../../src/channels/manychat/client.ts';

/**
 * specs/030-reply-waits-for-the-flow.md § Verification items 1, 2 and 3: a
 * flow declares how long it plays, the turn keeps when the last one ends, and
 * a silent response says nothing but keeps the callback. Invented flows.
 */

const flowEntry = (id: string, settleSeconds?: number) => ({
  id,
  flowNs: `content00000000000000_${id}`,
  description: 'A flow.',
  ...(settleSeconds !== undefined ? { settleSeconds } : {}),
});

describe('a flow declares how long it plays (specs/030 V1)', () => {
  it('loads settleSeconds from 0 to the bound', () => {
    for (const settleSeconds of [0, 6, MAX_SETTLE_SECONDS]) {
      const tools = ToolsSchema.parse({ flows: [flowEntry('tour', settleSeconds)] });
      expect(tools.flows[0]!.settleSeconds).toBe(settleSeconds);
    }
    expect(MAX_SETTLE_SECONDS).toBe(30);
  });

  it('refuses a value outside the range or not a whole second', () => {
    for (const settleSeconds of [-1, MAX_SETTLE_SECONDS + 1, 2.5]) {
      expect(() => ToolsSchema.parse({ flows: [flowEntry('tour', settleSeconds)] })).toThrow();
    }
  });

  it('is optional', () => {
    const tools = ToolsSchema.parse({ flows: [flowEntry('tour')] });
    expect(tools.flows[0]!.settleSeconds).toBeUndefined();
  });
});

/** ManyChat at the performer port: refuses the flow ids in `refusing`. */
class Performer implements ActionPerformer {
  refusing = new Set<string>();
  performAction(_subscriberId: string, action: PerformableAction): Promise<void> {
    return this.refusing.has(action.id) ? Promise.reject(new Error('refused')) : Promise.resolve();
  }
}

const tools = ToolsSchema.parse({
  flows: [flowEntry('tour', 6), flowEntry('gallery', 2), flowEntry('leaflet')],
  tags: [{ id: 'keen', tag: 'keen', description: 'Keen.' }],
});

const send = (id: string): StagedAction => ({
  tool: 'send_flow',
  id,
  flowNs: `content00000000000000_${id}`,
});

function flowSends() {
  const performer = new Performer();
  let now = 1_000_000;
  const flows = new FlowSends({
    performer,
    subscriberId: 's1',
    logger: { warn: () => {} },
    tools,
    clock: () => now,
  });
  return { performer, flows, advance: (ms: number) => (now += ms), at: () => now };
}

describe('the turn keeps when its last flow ends (specs/030 V2)', () => {
  it('counts a flow’s settleSeconds from ManyChat’s answer', async () => {
    const { flows, at } = flowSends();
    expect(flows.playsUntil).toBe(0);
    await flows.send([send('tour')]);
    expect(flows.playsUntil).toBe(at() + 6000);
  });

  it('takes the latest of several flows, whichever order they went in', async () => {
    const { flows, advance, at } = flowSends();
    await flows.send([send('tour')]);
    const tourEnds = at() + 6000;
    advance(1000);
    await flows.send([send('gallery')]);
    expect(flows.playsUntil).toBe(tourEnds);
    advance(5500);
    await flows.send([send('gallery')]);
    expect(flows.playsUntil).toBe(at() + 2000);
  });

  it('ignores a refused flow, a flow without the field, and other writes', async () => {
    const { performer, flows } = flowSends();
    performer.refusing.add('tour');
    await flows.send([send('tour'), send('leaflet'), { tool: 'add_tag', id: 'keen', tag: 'keen' }]);
    expect(flows.playsUntil).toBe(0);
  });

  it('waits for nothing without the tenant’s tools', async () => {
    const flows = new FlowSends({
      performer: new Performer(),
      subscriberId: 's1',
      logger: { warn: () => {} },
    });
    await flows.send([send('tour')]);
    expect(flows.playsUntil).toBe(0);
  });
});

describe('a silent response says nothing and keeps the callback (specs/030 V3)', () => {
  const reply: AgentReply = {
    messages: ['One moment.'],
    escalate: false,
    escalation_reason: null,
    confidence: 1,
    closing_question: null,
  };

  it('renders no message, and the callback still routes the next one here', () => {
    const out = renderManyChat(reply, {
      capabilities: capabilitiesFor('whatsapp'),
      callbackUrl: 'https://agent.example.com/v1/turn',
      silent: true,
    });
    expect(out.content.messages).toEqual([]);
    expect(out.content.external_message_callback?.url).toBe('https://agent.example.com/v1/turn');
  });

  it('renders the reply when not silent', () => {
    const out = renderManyChat(reply, { capabilities: capabilitiesFor('whatsapp') });
    expect(out.content.messages).toEqual([{ type: 'text', text: 'One moment.' }]);
  });
});
