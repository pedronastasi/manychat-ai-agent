import { describe, it, expect } from 'vitest';
import { ActionStage, buildTools, MAX_ACTIONS_PER_TURN } from '../../src/agent/tools.ts';
import type { ContactActions } from '../../src/agent/tools.ts';
import { FlowSends } from '../../src/agent/flows.ts';
import { stagedNotice } from '../../src/agent/prompt.ts';
import { ToolsSchema } from '../../src/contracts/config.ts';
import type { PerformableAction } from '../../src/contracts/agent.ts';
import type { ActionPerformer } from '../../src/channels/manychat/client.ts';

/**
 * specs/029-flows-before-the-reply.md § Verification items 1, 2 and 3: a flow
 * is sent when the model calls it, once per turn and within the cap, its
 * outcome is kept on the turn's record whatever the turn does next, and the
 * reply step is told what went out. Invented flows throughout.
 */

const tools = ToolsSchema.parse({
  flows: [
    { id: 'brochure', flowNs: 'content00000000000000_000001', description: 'A brochure.' },
    { id: 'results', flowNs: 'content00000000000000_000002', description: 'Results.' },
    {
      id: 'advanced_brochure',
      flowNs: 'content00000000000000_000003',
      description: 'The advanced brochure.',
      course: 'advanced',
    },
  ],
  tags: [{ id: 'interested', tag: 'interested', description: 'Interested.' }],
  fields: [
    {
      id: 'course',
      field: 'course',
      values: ['foundation', 'advanced'],
      description: 'The course.',
      course: true,
    },
  ],
});

/** ManyChat at the performer port: records each request, refuses the ids in `refusing`. */
class RecordingPerformer implements ActionPerformer {
  readonly requests: string[] = [];
  refusing = new Set<string>();
  performAction(_subscriberId: string, action: PerformableAction): Promise<void> {
    this.requests.push(`${action.tool} ${action.id}`);
    return this.refusing.has(action.id) ? Promise.reject(new Error('refused')) : Promise.resolve();
  }
}

const logger = { warn: () => {} };
const options = { toolCallId: 'test', messages: [], context: {} };
const onCourse: ContactActions = { sentFlows: new Set(), course: 'foundation' };

function turn() {
  const performer = new RecordingPerformer();
  const stage = new ActionStage();
  const flows = new FlowSends({ performer, subscriberId: 's1', logger });
  const built = buildTools(tools, stage, onCourse, undefined, { flows })!;
  const call = (name: string, input: object) =>
    built[name]!.execute!(input as never, options) as Promise<object>;
  return { performer, stage, call, built };
}

describe('a flow is sent when the model calls it (specs/029 V1)', () => {
  it('sends during the call and says so', async () => {
    const { performer, call } = turn();
    expect(await call('send_flow', { flow: 'brochure' })).toEqual({ sent: true });
    expect(performer.requests).toEqual(['send_flow brochure']);
  });

  it('says when ManyChat refused it', async () => {
    const { performer, call } = turn();
    performer.refusing.add('brochure');
    expect(await call('send_flow', { flow: 'brochure' })).toEqual({ sent: false });
  });

  it('sends a flow once per turn, and the second call returns the first outcome', async () => {
    const { performer, call } = turn();
    await call('send_flow', { flow: 'brochure' });
    expect(await call('send_flow', { flow: 'brochure' })).toEqual({ sent: true });
    expect(performer.requests).toEqual(['send_flow brochure']);
  });

  it('a repeat made while the first request is in flight gets its real outcome', async () => {
    const { performer, call } = turn();
    const answered = performer.performAction.bind(performer);
    performer.performAction = (subscriberId, action) =>
      new Promise(resolve => setTimeout(resolve, 20)).then(() => answered(subscriberId, action));
    const outcomes = await Promise.all([
      call('send_flow', { flow: 'brochure' }),
      call('send_flow', { flow: 'brochure' }),
    ]);

    expect(outcomes).toEqual([{ sent: true }, { sent: true }]);
    expect(performer.requests).toEqual(['send_flow brochure']);
  });

  it('counts a sent flow against the cap, and sends none past it', async () => {
    const { performer, stage, call } = turn();
    for (let index = 0; index < MAX_ACTIONS_PER_TURN - 1; index++) {
      stage.stage({ tool: 'add_tag', id: `tag${index}`, tag: `tag${index}` });
    }
    expect(await call('send_flow', { flow: 'brochure' })).toEqual({ sent: true });
    expect(await call('send_flow', { flow: 'results' })).toEqual({
      sent: false,
      reason: 'over the per-turn limit',
    });
    expect(performer.requests).toEqual(['send_flow brochure']);
    expect(stage.dropped).toEqual([expect.objectContaining({ id: 'results' })]);
  });

  it('refuses another course’s flow without a request', async () => {
    const { performer, call } = turn();
    expect(await call('send_flow', { flow: 'advanced_brochure' })).toEqual({ sent: false });
    expect(performer.requests).toEqual([]);
  });

  it('tells the model the flow goes out before its reply', () => {
    const { built } = turn();
    expect(built.send_flow!.description).toContain('before your reply');
  });

  it('stages as before without a flow sender', async () => {
    const stage = new ActionStage();
    const built = buildTools(tools, stage, onCourse)!;
    expect(await built.send_flow!.execute!({ flow: 'brochure' } as never, options)).toEqual({
      staged: true,
    });
    expect(stage.staged).toEqual([expect.objectContaining({ tool: 'send_flow', id: 'brochure' })]);
    expect(built.send_flow!.description).toContain('staged, not performed');
  });
});

describe('a sent flow keeps its outcome on the record (specs/029 V2)', () => {
  it('records sent and staged entries in call order', async () => {
    const { stage, call } = turn();
    await call('add_tag', { tag: 'interested' });
    await call('send_flow', { flow: 'brochure' });

    expect(stage.records('staged')).toEqual([
      { tool: 'add_tag', id: 'interested', status: 'staged' },
      { tool: 'send_flow', id: 'brochure', status: 'performed' },
    ]);
    expect(stage.staged.map(action => action.id)).toEqual(['interested']);
  });

  it('is not marked discarded when the turn escalates', async () => {
    const { performer, stage, call } = turn();
    performer.refusing.add('results');
    await call('send_flow', { flow: 'brochure' });
    await call('send_flow', { flow: 'results' });
    await call('add_tag', { tag: 'interested' });

    expect(stage.records('discarded')).toEqual([
      { tool: 'send_flow', id: 'brochure', status: 'performed' },
      { tool: 'send_flow', id: 'results', status: 'failed', error: 'refused' },
      { tool: 'add_tag', id: 'interested', status: 'discarded' },
    ]);
  });
});

describe('the reply step is told what went out (specs/029 V3)', () => {
  it('names sent and refused flows, and still lists what is staged', async () => {
    const { performer, stage, call } = turn();
    performer.refusing.add('results');
    await call('send_flow', { flow: 'brochure' });
    await call('send_flow', { flow: 'results' });
    await call('add_tag', { tag: 'interested' });

    const notice = stagedNotice(stage);
    expect(notice).toContain('SENT: Already sent to the contact');
    expect(notice).toContain('send_flow brochure');
    expect(notice).toContain('NOT SENT: ManyChat refused: send_flow results');
    expect(notice).toContain('ACTIONS: Staged');
    expect(notice).toContain('add_tag interested');
    expect(notice).toContain('Your reply has not been sent yet.');
  });

  it('reads as before on a turn that sent nothing', () => {
    expect(stagedNotice(new ActionStage())).toBe(
      'ACTIONS: None of your tool calls were staged. Nothing has been sent yet. Now write the reply.',
    );
  });
});
