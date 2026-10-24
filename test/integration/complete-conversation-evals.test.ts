import { describe, it, expect } from 'vitest';
import { RulesSchema, ToolsSchema } from '../../src/contracts/config.ts';
import { runRepetition } from '../../src/evals/conversations/harness.ts';
import { failuresOf } from '../../src/evals/conversations/assert.ts';
import { reportJson, runScenario, runSuite } from '../../src/evals/conversations/run.ts';
import { fixtureTenant, promptText, runOptions, say, scenario } from '../helpers/conversations.ts';
import type { TurnScript } from '../helpers/conversations.ts';
import type { SimulatedChannel } from '../../src/evals/conversations/channel.ts';

/**
 * specs/043-complete-conversation-evals.md § Verification items 2, 3, 4, 6
 * and 9. The model is faked at the provider boundary and ManyChat at its
 * ports (specs/004); the turn handler, its race, the tools, the guardrails,
 * the outbox and the database are the production ones. Every message, reply
 * and note is invented (C1).
 */

// Every write but intent waits for a prospect (specs/034), and a course's
// content for that course (specs/028): scripts follow the production gates.
const PROSPECT = { name: 'set_field', input: { field: 'intent', value: 'prospect' } };
const FOUNDATION = { name: 'set_field', input: { field: 'course', value: 'foundation' } };
const BROCHURE = { name: 'send_flow', input: { flow: 'foundation_brochure' } };
const ctx = { catalog: fixtureTenant.catalog, tools: fixtureTenant.tools, latencyBudgetMs: 8000 };

/** One repetition of `scenario` under a script, with its failures. */
async function once(fields: Record<string, unknown>, turns: TurnScript[], over = {}) {
  const { opts, models } = runOptions(() => turns, over);
  const parsed = scenario(fields);
  const run = await runRepetition(parsed, 1, { ...opts, runner: opts.runner() });
  return { run, failures: failuresOf(parsed, run, ctx), model: models[0]! };
}

describe('the next step receives the generated reply and the performed state (specs/043 V2)', () => {
  const steps = [
    say('first', 'i have done some of this before'),
    say('second', 'what next?', { state: { fields: { prior_experience: 'some' } } }),
  ];

  it('shows the second turn the first reply, word for word, and what was performed', async () => {
    const { run, failures, model } = await once({ steps, expect: { terminal: 'completed' } }, [
      {
        tools: [
          PROSPECT,
          { name: 'set_field', input: { field: 'prior_experience', value: 'some' } },
        ],
        reply: { messages: ['DISTINCTIVE-FIRST-REPLY-7731'] },
      },
      { reply: { messages: ['Here is what comes next.'] } },
    ]);
    expect(failures).toEqual([]);
    expect(run.steps[0]!.messages).toEqual(['DISTINCTIVE-FIRST-REPLY-7731']);
    const second = promptText(model.firsts[1]);
    expect(second).toContain('DISTINCTIVE-FIRST-REPLY-7731');
    expect(second).toContain('set_field prior_experience=some');
    expect(second).toContain('[actions performed:');
    expect(run.steps[1]!.state.fields.prior_experience).toBe('some');
  });

  it('fails the later state assertion when the first turn never wrote it', async () => {
    const { failures } = await once({ steps, expect: { terminal: 'completed' } }, [
      { reply: { messages: ['DISTINCTIVE-FIRST-REPLY-7731'] } },
      { reply: { messages: ['Here is what comes next.'] } },
    ]);
    expect(failures.map(failure => failure.message)).toEqual([
      'field prior_experience expected some, got null',
    ]);
    expect(failures[0]!.step).toBe('second');
  });
});

describe('production rules decide state and action outcomes (specs/043 V3)', () => {
  it('escalates a keyword before the model runs (specs/001 § Escalation)', async () => {
    const { run, failures, model } = await once(
      {
        steps: [say('asks', 'i want a refund now'), say('later', 'hello?')],
        expect: { terminal: 'handoff', handoff: { step: 'asks' } },
      },
      [{ reply: { messages: ['never sent'] } }],
    );
    expect(failures).toEqual([]);
    expect(run.steps[0]!.outcome).toBe('escalated_precheck');
    expect(model.calls).toHaveLength(0);
    expect(run.notReached).toEqual(['later']);
  });

  it('answers the opening trigger with the scripted opening, not the model (specs/001 § Scripted opening)', async () => {
    const rules = RulesSchema.parse({
      ...fixtureTenant.rules,
      openingTrigger: { keywords: ['START-DEMO'], message: 'Welcome, and thanks for writing.' },
    });
    const { run, failures, model } = await once(
      {
        steps: [{ id: 'open', input: { kind: 'opening', text: 'START-DEMO' } }],
        expect: { terminal: 'completed' },
      },
      [{ reply: { messages: ['never sent'] } }],
      { rules },
    );
    expect(failures).toEqual([]);
    expect(run.steps[0]!.outcome).toBe('answered_scripted');
    expect(run.steps[0]!.messages).toEqual(['Welcome, and thanks for writing.']);
    expect(model.calls).toHaveLength(0);
  });

  it('delivers a flow sent in the tool loop before the reply that follows it (specs/029)', async () => {
    const { run, failures } = await once(
      {
        steps: [
          say('asks', 'can you send me something to read about the foundation course?', {
            delivery: { order: [{ flow: 'foundation_brochure' }, { reply: 'syllabus' }] },
            actions: {
              required: [{ tool: 'send_flow', id: 'foundation_brochure', status: 'performed' }],
            },
          }),
        ],
        expect: { terminal: 'completed' },
      },
      [
        {
          tools: [PROSPECT, FOUNDATION, BROCHURE],
          reply: { messages: ['That brochure has the full syllabus.'] },
        },
      ],
    );
    expect(failures).toEqual([]);
    expect(run.deliveries.map(entry => entry.kind)).toEqual(['flow', 'reply']);
  });

  it('never sends a flow twice to the same contact (specs/023)', async () => {
    const { run, failures } = await once(
      {
        steps: [say('first', 'send me the brochure'), say('again', 'send it again please')],
        expect: {
          terminal: 'completed',
          actions: {
            counts: [
              {
                match: { tool: 'send_flow', id: 'foundation_brochure', status: 'performed' },
                count: 1,
              },
            ],
          },
        },
      },
      [
        {
          tools: [PROSPECT, FOUNDATION, BROCHURE],
          reply: { messages: ['That brochure has it all.'] },
        },
        { tools: [BROCHURE], reply: { messages: ['You already have it above.'] } },
      ],
    );
    expect(failures).toEqual([]);
    expect(run.deliveries.filter(entry => entry.kind === 'flow')).toHaveLength(1);
  });

  it('records an escalated turn’s staged write as discarded, never performed (specs/012)', async () => {
    const { run, failures } = await once(
      {
        steps: [
          say('asks', 'i have done some before but i have a question you cannot answer', {
            escalate: true,
            actions: {
              required: [
                { tool: 'set_field', id: 'prior_experience', value: 'some', status: 'discarded' },
              ],
              forbidden: [{ tool: 'set_field', id: 'prior_experience', status: 'performed' }],
            },
            state: { fields: { prior_experience: null } },
          }),
        ],
        expect: { terminal: 'handoff' },
      },
      [
        {
          tools: [
            PROSPECT,
            { name: 'set_field', input: { field: 'prior_experience', value: 'some' } },
          ],
          reply: {
            messages: ['Let me pass you to someone on the team.'],
            escalate: true,
            escalation_reason: 'out_of_scope',
          },
        },
      ],
    );
    expect(failures).toEqual([]);
    expect(run.terminal).toBe('handoff');
  });

  it('keeps the offering once it is offered (specs/028)', async () => {
    const { failures } = await once(
      {
        steps: [
          say('chooses', 'the foundation course please'),
          say('switches', 'actually make it the advanced one', {
            actions: { forbidden: [{ tool: 'set_field', id: 'course', status: 'attempted' }] },
          }),
        ],
        expect: { terminal: 'completed', state: { offering: 'foundation' } },
      },
      [
        {
          tools: [
            PROSPECT,
            { name: 'set_field', input: { field: 'course', value: 'foundation' } },
            { name: 'set_field', input: { field: 'funnel_stage', value: 'offered' } },
          ],
          reply: { messages: ['The Foundation Course it is.'] },
        },
        {
          tools: [{ name: 'set_field', input: { field: 'course', value: 'advanced' } }],
          reply: { messages: ['You are set on the Foundation Course.'] },
        },
      ],
    );
    expect(failures).toEqual([]);
  });

  it('lets the course change before it is offered, so the lock is what refused it (specs/028)', async () => {
    const { failures } = await once(
      {
        steps: [
          say('chooses', 'the foundation course please'),
          say('switches', 'actually make it the advanced one', {
            actions: {
              required: [
                { tool: 'set_field', id: 'course', value: 'advanced', status: 'performed' },
              ],
            },
          }),
        ],
        expect: { terminal: 'completed', state: { offering: 'advanced' } },
      },
      [
        { tools: [PROSPECT, FOUNDATION], reply: { messages: ['The Foundation Course it is.'] } },
        {
          tools: [{ name: 'set_field', input: { field: 'course', value: 'advanced' } }],
          reply: { messages: ['Switched you to the Advanced Course.'] },
        },
      ],
    );
    expect(failures).toEqual([]);
  });

  it('sends the flow tied to a stage when the stage is recorded (specs/032)', async () => {
    const tools = ToolsSchema.parse({
      ...fixtureTenant.tools,
      flows: fixtureTenant.tools!.flows.map(flow =>
        flow.id === 'student_results' ? { ...flow, onStage: 'qualifying' } : flow,
      ),
    });
    const tenant = { ...fixtureTenant, tools };
    const { opts } = runOptions(
      () => [
        {
          tools: [
            PROSPECT,
            { name: 'set_field', input: { field: 'funnel_stage', value: 'qualifying' } },
          ],
          reply: { messages: ['Let us find the right course for you.'] },
        },
      ],
      { tenant, tools },
    );
    const parsed = scenario({
      steps: [say('starts', 'i want to learn, where do i start?')],
      expect: {
        terminal: 'completed',
        actions: {
          required: [
            { tool: 'send_flow', id: 'student_results', status: 'performed', origin: 'stage' },
          ],
        },
      },
    });
    const run = await runRepetition(parsed, 1, { ...opts, runner: opts.runner() });
    expect(failuresOf(parsed, run, { ...ctx, tools })).toEqual([]);
  });
});

describe('escalation, failed sends and lost races settle as in production (specs/043 V4)', () => {
  it('keeps a flow sent in the tool loop when the reply escalates (specs/029)', async () => {
    const { run, failures } = await once(
      {
        steps: [
          say('asks', 'send me the brochure, and also i want to talk about a problem', {
            escalate: true,
            actions: {
              required: [{ tool: 'send_flow', id: 'foundation_brochure', status: 'performed' }],
            },
          }),
        ],
        expect: { terminal: 'handoff' },
      },
      [
        {
          tools: [PROSPECT, FOUNDATION, BROCHURE],
          reply: {
            messages: ['Let me pass you to someone on the team.'],
            escalate: true,
            escalation_reason: 'out_of_scope',
          },
        },
      ],
    );
    expect(failures).toEqual([]);
    expect(run.deliveries.some(entry => entry.kind === 'flow')).toBe(true);
  });

  it('records a refused send as failed and leaves no performed state (specs/012)', async () => {
    const { run, failures } = await once(
      {
        steps: [
          say('asks', 'send me the brochure', {
            actions: {
              required: [{ tool: 'send_flow', id: 'foundation_brochure', status: 'failed' }],
              forbidden: [{ tool: 'send_flow', id: 'foundation_brochure', status: 'performed' }],
            },
          }),
        ],
        expect: { terminal: 'completed' },
      },
      [
        {
          tools: [PROSPECT, FOUNDATION, BROCHURE],
          reply: { messages: ['I could not send it just now.'] },
        },
      ],
      {
        prepare: (channel: SimulatedChannel) =>
          channel.failing.add('send_flow:foundation_brochure'),
      },
    );
    expect(failures).toEqual([]);
    expect(run.deliveries.filter(entry => entry.kind === 'flow')).toEqual([]);
  });

  it('writes an escalation note on a handoff and keeps its text out of the report (specs/024)', async () => {
    const secret = 'INVENTED-NOTE-TEXT-THAT-MUST-NOT-APPEAR';
    const { opts } = runOptions(() => [
      {
        tools: [
          PROSPECT,
          { name: 'write_note', input: { note: 'handoff_summary', text: secret } },
          { name: 'set_field', input: { field: 'prior_experience', value: 'none' } },
        ],
        reply: {
          messages: ['Let me pass you to someone on the team.'],
          escalate: true,
          escalation_reason: 'out_of_scope',
        },
      },
    ]);
    const parsed = scenario({
      steps: [
        say('asks', 'i need help with something unusual', {
          actions: {
            required: [
              { tool: 'write_note', id: 'handoff_summary', status: 'performed' },
              { tool: 'set_field', id: 'prior_experience', status: 'discarded' },
            ],
          },
        }),
      ],
      expect: { terminal: 'handoff' },
    });
    const report = await runSuite(
      {
        dir: 'test',
        scenarios: [parsed],
        fixtures: { flows: {} },
        hashes: { scenarios: 'x', fixtures: null },
      },
      {
        suite: 'test',
        startedAt: '2026-01-15T10:00:00.000Z',
        frameworkVersion: 'test',
        hashes: { config: 'x', scenarios: 'x', fixtures: null },
        agent: { model: 'mock:demo', runner: 'langchain', temperature: 0.3 },
        judge: null,
        playbook: null,
      },
      opts,
    );
    expect(report.scenarios[0]!.repetitions.map(entry => entry.failures)).toEqual([[], []]);
    expect(reportJson(report)).not.toContain(secret);
    // The contact's token never reaches a report either (specs/019).
    expect(reportJson(report)).not.toMatch(/token/i);
  });

  it('settles a lost race into the outbox before the next scripted message starts (ADR-0001)', async () => {
    const { run, failures, model } = await once(
      {
        steps: [
          say('slow', 'tell me about the courses', { must_contain: ['DEFERRED-REPLY-4410'] }),
          say('next', 'and the schedule?'),
        ],
        expect: { terminal: 'completed' },
      },
      [
        { delayMs: 400, reply: { messages: ['DEFERRED-REPLY-4410'] } },
        { reply: { messages: ['Weekday evenings.'] } },
      ],
      { raceDeadlineMs: 100, modelAbortMs: 5000 },
    );
    expect(failures).toEqual([]);
    expect(run.steps[0]!.outcome).toBe('deferred');
    const replies = run.deliveries.filter(entry => entry.kind === 'reply');
    expect(replies.map(entry => [entry.step, entry.via])).toEqual([
      ['slow', 'inline'],
      ['slow', 'outbox'],
      ['next', 'inline'],
    ]);
    expect(promptText(model.firsts[1])).toContain('DEFERRED-REPLY-4410');
  });

  it('ends the run as an execution error when a lost race is then aborted, never a pass', async () => {
    const { run, failures } = await once(
      {
        steps: [say('slow', 'tell me about the courses', { escalate: false }), say('next', 'ok')],
        expect: { terminal: 'completed' },
      },
      [{ delayMs: 5000 }],
      { raceDeadlineMs: 50, modelAbortMs: 150 },
    );
    // Production sent the holding line, which does not escalate...
    expect(run.steps[0]!.outcome).toBe('deferred');
    expect(run.steps[0]!.reply.escalate).toBe(false);
    // ...and the run still names the abort and stops there.
    expect(run.steps[0]!.executionError).toBe('model error: AbortError');
    expect(run.terminal).toBe('error');
    expect(run.notReached).toEqual(['next']);
    expect(failures.map(failure => failure.message)).toContain(
      'terminal expected completed, got error',
    );
  });
});

describe('each scenario runs twice from fresh state, and a split is unstable (specs/043 V6)', () => {
  it('fails a scenario one repetition fails, labels it unstable, and shares no state', async () => {
    const { opts, models } = runOptions(repetition => [
      { reply: { messages: [repetition === 1 ? 'GOOD-ANSWER' : 'OTHER-ANSWER'] } },
      { reply: { messages: ['Anything else?'] } },
    ]);
    const result = await runScenario(
      scenario({
        steps: [say('asks', 'hi', { must_contain: ['GOOD-ANSWER'] }), say('then', 'thanks')],
        expect: { terminal: 'completed' },
      }),
      opts,
    );
    expect(result.status).toBe('failed');
    expect(result.unstable).toBe(true);
    expect(result.repetitions.map(entry => entry.failures.length)).toEqual([0, 1]);
    // The second repetition starts with no history from the first.
    expect(models).toHaveLength(2);
    expect(promptText(models[1]!.firsts[0])).not.toContain('GOOD-ANSWER');
    expect(promptText(models[1]!.firsts[1])).toContain('OTHER-ANSWER');
  });
});

describe('a failed conversation continues to its terminal event (specs/043 V9)', () => {
  it('runs the next step after a failed assertion, and labels later failures downstream', async () => {
    const { run, failures } = await once(
      {
        steps: [
          say('first', 'hi', { must_contain: ['NEVER-SAID'] }),
          say('second', 'hello again', { must_contain: ['ALSO-NEVER-SAID'] }),
        ],
        expect: { terminal: 'completed' },
      },
      [{ reply: { messages: ['Hello.'] } }, { reply: { messages: ['Hello again.'] } }],
    );
    expect(run.steps.map(step => step.id)).toEqual(['first', 'second']);
    expect(failures.map(failure => [failure.step, failure.downstream])).toEqual([
      ['first', false],
      ['second', true],
    ]);
  });

  it('passes a handoff at the expected step, and ends the script there', async () => {
    const { run, failures } = await once(
      {
        steps: [say('first', 'hi'), say('asks', 'a person please'), say('never', 'hello?')],
        expect: { terminal: 'handoff', handoff: { step: 'asks', reason: 'explicit_request' } },
      },
      [
        { reply: { messages: ['Hello.'] } },
        {
          reply: {
            messages: ['Passing you to someone.'],
            escalate: true,
            escalation_reason: 'explicit_request',
          },
        },
      ],
    );
    expect(failures).toEqual([]);
    expect(run.notReached).toEqual(['never']);
  });

  it('fails an early handoff the script did not expect, and reaches nothing after it', async () => {
    const { run, failures } = await once(
      {
        steps: [say('first', 'hi'), say('second', 'tell me more')],
        expect: { terminal: 'completed' },
      },
      [
        {
          reply: {
            messages: ['Passing you to someone.'],
            escalate: true,
            escalation_reason: 'low_confidence',
          },
        },
      ],
    );
    expect(run.terminal).toBe('handoff');
    expect(run.notReached).toEqual(['second']);
    expect(failures.map(failure => failure.message)).toContain(
      'terminal expected completed, got handoff',
    );
  });

  it('names a provider error behind the fallback escalation, even where a handoff was expected', async () => {
    const { run, failures } = await once(
      {
        steps: [say('asks', 'hi')],
        expect: { terminal: 'handoff', handoff: { step: 'asks' } },
      },
      [{ error: new Error('provider unavailable') }],
    );
    // Production answers with its fail-closed handoff (C6)...
    expect(run.steps[0]!.reply.escalate).toBe(true);
    // ...and the run still calls it an execution error, never a passing handoff.
    expect(run.terminal).toBe('error');
    expect(run.executionError).toMatch(/model error/);
    expect(failures.map(failure => failure.message)).toContain(
      'terminal expected handoff, got error',
    );
  });
});
