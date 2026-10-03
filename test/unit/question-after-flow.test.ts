import { describe, it, expect, vi } from 'vitest';
import { holdQuestion, sendHeldQuestion } from '../../src/conversation/question.ts';
import { ActionStage, buildTools } from '../../src/agent/tools.ts';
import { ToolsSchema } from '../../src/contracts/config.ts';
import type { StagedAction } from '../../src/contracts/agent.ts';

/**
 * specs/029-question-after-flow.md § Verification items 1, 2 and 5: the
 * settle time loads and travels with the staged flow, the trailing question is
 * held only behind a flow, and a held question is sent once, whatever became
 * of the flow. Invented flows and copy throughout.
 */

const flow = (id: string, settleSeconds?: number): StagedAction => ({
  tool: 'send_flow',
  id,
  flowNs: `content00000000000000_00000${id.length}`,
  ...(settleSeconds === undefined ? {} : { settleSeconds }),
});

const tag: StagedAction = { tool: 'add_tag', id: 'interested', tag: 'interested' };

const toolsWith = (settleSeconds: unknown) =>
  ToolsSchema.safeParse({
    flows: [
      {
        id: 'brochure',
        flowNs: 'content00000000000000_000001',
        description: 'A brochure.',
        settleSeconds,
      },
    ],
  });

describe('settleSeconds loads from 0 to 30 and travels with the flow (specs/029 V1)', () => {
  it.each([0, 12, 30])('accepts %d', value => {
    expect(toolsWith(value).success).toBe(true);
  });

  it.each([-1, 31, 2.5, '10'])('refuses %p', value => {
    expect(toolsWith(value).success).toBe(false);
  });

  it('is optional', () => {
    expect(toolsWith(undefined).success).toBe(true);
  });

  it('is copied onto the staged send_flow, and left off when the flow has none', async () => {
    const tools = ToolsSchema.parse({
      flows: [
        { id: 'slow', flowNs: 'content00000000000000_000001', description: 'A.', settleSeconds: 9 },
        { id: 'quick', flowNs: 'content00000000000000_000002', description: 'B.' },
      ],
    });
    const stage = new ActionStage();
    const built = buildTools(tools, stage)!;
    const call = async (flowId: string): Promise<void> => {
      await built.send_flow!.execute!({ flow: flowId } as never, {
        toolCallId: 'test',
        messages: [],
        context: {},
      });
    };
    await call('slow');
    await call('quick');

    expect(stage.staged[0]).toMatchObject({ tool: 'send_flow', id: 'slow', settleSeconds: 9 });
    expect(stage.staged[1]).not.toHaveProperty('settleSeconds');
  });
});

describe('the trailing question is held only behind a flow (specs/029 V2)', () => {
  const reply = ['Here is the brochure.', 'Would you like the prices?'];

  it('holds the last message when a flow is staged and it is a question', () => {
    expect(holdQuestion(reply, [flow('brochure')])).toEqual({
      messages: ['Here is the brochure.'],
      held: { text: 'Would you like the prices?', settleMs: 0 },
    });
  });

  it('holds nothing when no flow is staged', () => {
    expect(holdQuestion(reply, [tag]).held).toBeUndefined();
    expect(holdQuestion(reply, []).messages).toEqual(reply);
  });

  it('holds nothing when the reply does not end on a question', () => {
    const statement = ['Here is the brochure.', 'It is on its way.'];
    expect(holdQuestion(statement, [flow('brochure')])).toEqual({
      messages: statement,
      held: undefined,
    });
  });

  it('keeps a question that is the whole reply, since the response must carry a message', () => {
    expect(holdQuestion(['Would you like the prices?'], [flow('brochure')]).held).toBeUndefined();
  });

  it('waits for the longest settle time among the staged flows', () => {
    const { held } = holdQuestion(reply, [flow('a', 4), tag, flow('b', 12), flow('c')]);
    expect(held?.settleMs).toBe(12_000);
  });
});

describe('a held question is sent once, whatever became of the flow (specs/029 V5)', () => {
  const held = { text: 'Would you like the prices?', settleMs: 7000 };
  const logger = () => ({ warn: vi.fn() });

  it('waits the settle time, then sends the question as one message', async () => {
    const sent: string[][] = [];
    const sleep = vi.fn(() => Promise.resolve());
    await sendHeldQuestion(
      { sendText: (_subscriber, messages) => Promise.resolve(void sent.push(messages)) },
      's1',
      held,
      logger(),
      sleep,
    );

    expect(sleep).toHaveBeenCalledWith(7000);
    expect(sent).toEqual([['Would you like the prices?']]);
  });

  it('does not wait when the settle time is 0', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    await sendHeldQuestion(
      { sendText: () => Promise.resolve() },
      's1',
      { ...held, settleMs: 0 },
      logger(),
      sleep,
    );
    expect(sleep).not.toHaveBeenCalled();
  });

  it('logs a failed send once, without the question or the subscriber, and does not retry', async () => {
    const log = logger();
    const sendText = vi.fn(() =>
      Promise.reject(new Error('ManyChat refused "Would you like the prices?" for s1-subscriber')),
    );
    await sendHeldQuestion({ sendText }, 's1-subscriber', held, log, () => Promise.resolve());

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
    const fields = JSON.stringify(log.warn.mock.calls[0]);
    expect(fields).toContain('[question]');
    expect(fields).toContain('[subscriber]');
    expect(fields).not.toContain('Would you like the prices?');
    expect(fields).not.toContain('s1-subscriber');
  });
});
