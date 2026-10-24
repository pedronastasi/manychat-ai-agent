import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRepetition } from '../../src/evals/conversations/harness.ts';
import { failuresOf } from '../../src/evals/conversations/assert.ts';
import { runScenario } from '../../src/evals/conversations/run.ts';
import type { TenantConfig } from '../../src/config/loader.ts';
import { fixtureTenant, promptText, runOptions, say, scenario } from '../helpers/conversations.ts';
import type { TurnScript } from '../helpers/conversations.ts';

/**
 * specs/043-complete-conversation-evals.md § Verification item 5, the
 * suppression half of item 9, and media steps (§ Scripts supply contact
 * messages). Silence moves the repetition's own clock, so a two-hour nudge
 * and a ten-minute flow run in moments; the nudge worker, the outbox, the
 * media resolver and the database are the production ones. The model is
 * faked at the provider boundary and ManyChat at its ports (specs/004).
 * Every message is invented (C1).
 */

const PROSPECT = { name: 'set_field', input: { field: 'intent', value: 'prospect' } };
const FOUNDATION = { name: 'set_field', input: { field: 'course', value: 'foundation' } };
const LINK = { name: 'send_flow', input: { flow: 'enrolment_link', contactAsked: true } };
/** The fixture tenant's 120-minute delay. */
const NUDGE = { name: 'schedule_nudge', input: { delay: 'later_today' } };
const ctx = { catalog: fixtureTenant.catalog, tools: fixtureTenant.tools, latencyBudgetMs: 8000 };

const quiet = (id: string, minutes: number, expect: object = {}) => ({
  id,
  input: { kind: 'silence', advance_minutes: minutes },
  expect,
});

async function once(
  fields: Record<string, unknown>,
  turns: TurnScript[],
  over: Parameters<typeof runOptions>[1] = {},
) {
  const { opts, models } = runOptions(() => turns, over);
  const parsed = scenario(fields);
  const run = await runRepetition(parsed, 1, { ...opts, runner: opts.runner() });
  return { run, failures: failuresOf(parsed, run, ctx), model: models[0]! };
}

describe('a fake clock runs scheduled silence (specs/043 V5)', () => {
  it('sends a due nudge after the reply it follows, and not before it is due', async () => {
    const started = Date.now();
    const { run, failures, model } = await once(
      {
        steps: [
          say('asks', 'what days are the classes?', {
            state: { pending_nudge: 'later_today' },
          }),
          quiet('too-soon', 60, {
            nudge: 'none',
            replies: 0,
            state: { pending_nudge: 'later_today' },
          }),
          quiet('due', 90, { nudge: 'sent', replies: 1, state: { pending_nudge: null } }),
        ],
        expect: { terminal: 'completed' },
      },
      [
        { tools: [PROSPECT, NUDGE], reply: { messages: ['Tuesday and Thursday evenings.'] } },
        { reply: { messages: ['INVENTED-FOLLOW-UP-4412'] } },
      ],
    );
    expect(failures).toEqual([]);
    // Two and a half hours of silence, in moments of real time.
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(run.steps.map(step => step.clockMs)).toEqual([0, 3_600_000, expect.any(Number)]);
    expect(run.steps[2]!.clockMs).toBeGreaterThanOrEqual(150 * 60_000);
    expect(run.steps[2]!.outcome).toBe('nudge_sent');
    expect(run.steps[2]!.messages).toEqual(['INVENTED-FOLLOW-UP-4412']);
    // The reply, then the follow-up: delivery order is recorded across steps.
    const replies = run.deliveries.filter(entry => entry.kind === 'reply');
    expect(replies.map(entry => [entry.step, entry.via])).toEqual([
      ['asks', 'inline'],
      ['due', 'outbox'],
    ]);
    // The nudge turn ran on the conversation as it stood, and said nothing new to it.
    expect(model.firsts).toHaveLength(2);
    expect(promptText(model.firsts[1])).toContain('Tuesday and Thursday evenings.');
  });

  it('cancels the pending nudge when the payment link goes out', async () => {
    const { run, failures, model } = await once(
      {
        steps: [
          say('asks', 'what days are the classes?', { state: { pending_nudge: 'later_today' } }),
          say('enrols', 'send me the link for the foundation course', {
            state: { pending_nudge: null, fields: { funnel_stage: 'link_sent' } },
          }),
          quiet('quiet', 180, { replies: 0 }),
        ],
        expect: { terminal: 'completed' },
      },
      [
        { tools: [PROSPECT, NUDGE], reply: { messages: ['Tuesday and Thursday evenings.'] } },
        { tools: [FOUNDATION, LINK], reply: { messages: ['There is your payment link.'] } },
        { reply: { messages: ['never sent'] } },
      ],
    );
    expect(failures).toEqual([]);
    expect(run.steps[2]!.nudge?.outcome).toBe('none');
    expect(model.firsts).toHaveLength(2);
  });

  it('suppresses a nudge the model declines, without a handoff, and the script goes on (specs/043 V9)', async () => {
    const { run, failures } = await once(
      {
        steps: [
          say('asks', 'what days are the classes?'),
          quiet('due', 150, { nudge: 'suppressed', replies: 0 }),
          say('back', 'sorry, i was out. tuesdays work', { escalate: false, replies: 1 }),
        ],
        expect: { terminal: 'completed' },
      },
      [
        { tools: [PROSPECT, NUDGE], reply: { messages: ['Tuesday and Thursday evenings.'] } },
        {
          reply: { messages: ['never sent'], escalate: true, escalation_reason: 'low_confidence' },
        },
        { reply: { messages: ['Tuesday it is.'] } },
      ],
    );
    expect(failures).toEqual([]);
    expect(run.terminal).toBe('completed');
    expect(run.steps[1]!.outcome).toBe('nudge_skipped');
    expect(run.notReached).toEqual([]);
    expect(run.deliveries.flatMap(entry => (entry.kind === 'reply' ? entry.messages : []))).toEqual(
      ['Tuesday and Thursday evenings.', 'Tuesday it is.'],
    );
  });

  it('makes up no message when no nudge was scheduled', async () => {
    const { run, failures, model } = await once(
      {
        steps: [say('asks', 'hi'), quiet('quiet', 1_200, { nudge: 'none', replies: 0 })],
        expect: { terminal: 'completed' },
      },
      [{ reply: { messages: ['Hello.'] } }, { reply: { messages: ['never sent'] } }],
    );
    expect(failures).toEqual([]);
    expect(run.steps[1]!.outcome).toBe('no_turn');
    expect(run.steps[1]!.messages).toEqual([]);
    expect(model.firsts).toHaveLength(1);
  });

  it('fails a silence step whose expected nudge never comes', async () => {
    const { failures } = await once(
      {
        steps: [say('asks', 'hi'), quiet('quiet', 180, { nudge: 'sent', replies: 1 })],
        expect: { terminal: 'completed' },
      },
      [{ reply: { messages: ['Hello.'] } }],
    );
    expect(failures.map(failure => failure.message)).toEqual([
      'replies expected 1, got 0',
      'nudge expected sent, got none',
    ]);
  });

  it('moves the clock past a playing flow instead of waiting it out (specs/030)', async () => {
    // Ten minutes of flow: production holds the reply in the outbox until it ends.
    const tools = {
      ...fixtureTenant.tools!,
      flows: fixtureTenant.tools!.flows.map(flow =>
        flow.id === 'enrolment_link' ? { ...flow, settleSeconds: 600 } : flow,
      ),
    };
    const tenant: TenantConfig = { ...fixtureTenant, tools };
    const started = Date.now();
    const { run, failures } = await once(
      {
        steps: [
          say('enrols', 'i want to enrol in the foundation course, send me the link', {
            delivery: { order: [{ flow: 'enrolment_link' }, { reply: 'payment link' }] },
          }),
        ],
        expect: { terminal: 'completed' },
      },
      [
        {
          tools: [PROSPECT, FOUNDATION, LINK],
          reply: { messages: ['There is your payment link.'] },
        },
      ],
      { tenant, tools },
    );
    expect(failures).toEqual([]);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(run.steps[0]!.clockMs).toBeGreaterThan(590_000);
    expect(run.deliveries.map(entry => entry.kind)).toEqual(['flow', 'reply']);
  });

  it('gives each repetition its own clock and nudge queue (specs/043 V6)', async () => {
    const { opts } = runOptions(() => [
      { tools: [PROSPECT, NUDGE], reply: { messages: ['Tuesday and Thursday evenings.'] } },
      { reply: { messages: ['Just checking in.'] } },
    ]);
    const result = await runScenario(
      scenario({
        steps: [
          say('asks', 'what days are the classes?', { state: { pending_nudge: 'later_today' } }),
          quiet('due', 150, { nudge: 'sent' }),
        ],
        expect: { terminal: 'completed' },
      }),
      opts,
    );
    expect(result.status).toBe('passed');
    for (const { run } of result.repetitions) {
      expect(run.steps[0]!.clockMs).toBe(0);
      expect(run.steps[1]!.nudge?.results).toEqual(['sent']);
    }
  });
});

describe('a media step crosses the production media boundary (specs/043, specs/020)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'conversation-media-'));
  // Invented bytes: transcription answers from the step's fixture, not the file.
  writeFileSync(join(dir, 'voice.ogg'), Buffer.from('invented voice note'));
  writeFileSync(join(dir, 'photo.jpg'), Buffer.from('invented photo'));
  const voice = (expect: object = {}) => ({
    id: 'voice',
    input: {
      kind: 'media',
      media: 'audio',
      file: 'voice.ogg',
      content_type: 'audio/ogg',
      transcript: 'how much is the foundation course',
    },
    expect,
  });

  it('gives the model the transcript as the contact message, and records it as theirs', async () => {
    const { run, failures, model } = await once(
      {
        steps: [voice({ escalate: false }), say('next', 'ok thanks')],
        expect: { terminal: 'completed' },
      },
      [{ tools: [PROSPECT], reply: { messages: ['It is 450.00 USD.'] } }, {}],
      { suiteDir: dir },
    );
    expect(failures).toEqual([]);
    expect(run.steps[0]!.outcome).toBe('answered_inline');
    expect(promptText(model.firsts[0])).toContain('how much is the foundation course');
    // The next turn's history holds the transcript, never the media URL.
    expect(promptText(model.firsts[1])).toContain('how much is the foundation course');
    expect(promptText(model.firsts[1])).not.toContain('media.eval.invalid');
  });

  it('asks the contact to type when the deployment cannot read the file', async () => {
    const { run, failures, model } = await once(
      {
        steps: [
          voice({ must_contain: ['type your question'] }),
          {
            id: 'photo',
            input: { kind: 'media', media: 'image', file: 'photo.jpg', content_type: 'image/jpeg' },
            expect: { must_contain: ['type your question'] },
          },
        ],
        expect: { terminal: 'completed' },
      },
      [{ reply: { messages: ['never sent'] } }],
      {
        suiteDir: dir,
        media: { acceptsImages: false, transcription: false, splitter: null },
      },
    );
    expect(failures).toEqual([]);
    expect(run.steps.map(step => step.outcome)).toEqual(['media_fallback', 'media_fallback']);
    expect(model.firsts).toHaveLength(0);
  });
});
