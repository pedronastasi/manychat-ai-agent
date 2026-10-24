import { describe, expect, it } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4CallOptions, LanguageModelV4Content } from '@ai-sdk/provider';
import { carriesWorkingNotes } from '../../src/agent/guardrails.ts';
import { LangGraphRunner, REWRITE_NOTE } from '../../src/agent/langgraph-runner.ts';
import { buildSystemPrompt } from '../../src/agent/prompt.ts';
import { ActionStage } from '../../src/agent/tools.ts';
import { AgentReplyForModel, NOTES_DESCRIPTION } from '../../src/contracts/agent.ts';
import { RulesSchema } from '../../src/contracts/config.ts';
import type { TenantConfig } from '../../src/config/loader.ts';
import { fixtureTenant, promptText } from '../helpers/conversations.ts';
import { asProspect } from '../helpers/intent.ts';

/**
 * specs/001-agent-behavior.md § Working notes never reach the contact. Every
 * reply and note here is invented (C1), and the notes are the shape of the one
 * that reached a contact: a bracketed aside, the format named, mid-message.
 */

const reply = (messages: string[], over: object = {}) => ({
  messages,
  escalate: false,
  escalation_reason: null,
  confidence: 0.9,
  closing_question: 'Would you like the syllabus?',
  notes: null,
  ...over,
});

const LEAKED = reply([
  'Both courses start from zero.',
  'The group course runs on Fridays. [Correction? Should the start date go here? Avoid it. JSON.',
]);
const CLEAN = reply(['Both courses start from zero.', 'The group course runs on Fridays.']);

const USAGE = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};

type Step = { tool: { name: string; input: object } } | { text: object } | { error: Error };

/** A model that answers each call with the next step, at the provider boundary. */
function sequence(steps: Step[]) {
  const calls: LanguageModelV4CallOptions[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options: LanguageModelV4CallOptions) => {
      calls.push(options);
      const step = steps[calls.length - 1] ?? steps.at(-1)!;
      if ('error' in step) throw step.error;
      const content: LanguageModelV4Content[] =
        'tool' in step
          ? [
              {
                type: 'tool-call',
                toolCallId: `call-${calls.length}`,
                toolName: step.tool.name,
                input: JSON.stringify(step.tool.input),
              },
            ]
          : [{ type: 'text', text: JSON.stringify(step.text) }];
      return {
        content,
        finishReason:
          'tool' in step
            ? { unified: 'tool-calls' as const, raw: 'tool_use' }
            : { unified: 'stop' as const, raw: 'end_turn' },
        usage: USAGE,
        warnings: [],
      };
    },
  });
  return { model, calls };
}

function runner(steps: Step[], tenant: TenantConfig = fixtureTenant) {
  const { model, calls } = sequence(steps);
  const agent = new LangGraphRunner({
    model,
    modelSpec: 'mock:demo',
    config: () => tenant,
    maxOutputTokens: 400,
    temperature: 0.3,
  });
  return { agent, calls };
}

describe('working notes are recognised in what the contact reads (specs/001)', () => {
  it('recognises the format named and a bracketed aside', () => {
    expect(carriesWorkingNotes(reply(['Fridays, 5 to 7pm. JSON.']))).toBe(true);
    expect(carriesWorkingNotes(reply(['Fridays. **[Correction?** keep it']))).toBe(true);
    expect(carriesWorkingNotes(reply(['Fridays. [note: check the date]']))).toBe(true);
  });

  it('reads the closing question too', () => {
    expect(carriesWorkingNotes(reply(['Fridays.'], { closing_question: 'Syllabus? JSON' }))).toBe(
      true,
    );
  });

  it("matches the tenant's markers as case-insensitive substrings", () => {
    const draft = reply(['Fridays. we should avoid the date here.']);
    expect(carriesWorkingNotes(draft)).toBe(false);
    expect(carriesWorkingNotes(draft, ['We should'])).toBe(true);
  });

  it('never reads notes, where working notes belong', () => {
    expect(carriesWorkingNotes(reply(['Fridays.'], { notes: '[Correction] JSON' }))).toBe(false);
  });

  it('leaves a clean reply, a lowercase word and an output that is not a reply', () => {
    expect(carriesWorkingNotes(CLEAN)).toBe(false);
    expect(carriesWorkingNotes(reply(['Send us a json file and we will look.']))).toBe(false);
    expect(carriesWorkingNotes('JSON')).toBe(false);
  });

  it('defaults the tenant list to none', () => {
    const rules = RulesSchema.parse({
      messages: { acknowledgement: 'One moment.', escalation: 'A person will reply.' },
      budget: {},
      rateLimit: {},
    });
    expect(rules.workingNoteMarkers).toEqual([]);
  });
});

describe('a draft carrying working notes is written again, once (specs/001)', () => {
  it('sends the rewrite, and records both the draft and the rewrite', async () => {
    const { agent, calls } = runner([{ text: LEAKED }, { text: CLEAN }]);
    const result = await agent.run({ text: 'I am starting from zero', history: [] });
    expect(result.reply.escalate).toBe(false);
    expect(result.reply.messages).toEqual([...CLEAN.messages, CLEAN.closing_question]);
    expect(result.interventions).toEqual(
      expect.arrayContaining(['working_notes_detected', 'working_notes_rewritten']),
    );
    expect(calls).toHaveLength(2);
    expect(result.usage.outputTokens).toBe(40);
  });

  it('asks for the rewrite with no tools, and quotes nothing from the draft', async () => {
    const { agent, calls } = runner([{ text: LEAKED }, { text: CLEAN }]);
    await agent.run({ text: 'I am starting from zero', history: [] });
    const rewrite = calls[1]!;
    expect(rewrite.tools ?? []).toEqual([]);
    expect(promptText(rewrite)).toContain(REWRITE_NOTE);
    expect(promptText(rewrite)).not.toContain('Correction');
  });

  it('keeps what the turn staged, and stages nothing twice', async () => {
    const stage = new ActionStage();
    const { agent, calls } = runner([
      { tool: { name: 'add_tag', input: { tag: 'interested_foundation' } } },
      { text: LEAKED },
      { text: CLEAN },
    ]);
    const result = await agent.run({
      text: 'I am starting from zero',
      history: [],
      stage,
      contact: asProspect(),
    });
    expect(result.reply.escalate).toBe(false);
    expect(stage.staged.filter(action => action.tool === 'add_tag')).toHaveLength(1);
    expect(calls).toHaveLength(3);
    expect(calls[2]!.tools ?? []).toEqual([]);
  });

  it('hands off when the rewrite carries working notes too (C6)', async () => {
    const { agent } = runner([{ text: LEAKED }, { text: LEAKED }]);
    const result = await agent.run({ text: 'I am starting from zero', history: [] });
    expect(result.reply.escalate).toBe(true);
    expect(result.reply.messages.join(' ')).not.toContain('Correction');
    expect(result.escalatedBy).toBe('leak');
    expect(result.interventions).toEqual(['working_notes_detected', 'working_notes_handed_off']);
  });

  it("hands off with the tenant's own marker, and leaves it alone without it", async () => {
    const draft = reply(['Fridays. We should leave the date out.']);
    const tenant = {
      ...fixtureTenant,
      rules: { ...fixtureTenant.rules, workingNoteMarkers: ['we should'] },
    };
    expect(
      (await runner([{ text: draft }], tenant).agent.run({ text: 'hi', history: [] })).reply
        .escalate,
    ).toBe(true);
    const plain = await runner([{ text: draft }]).agent.run({ text: 'hi', history: [] });
    expect(plain.reply.escalate).toBe(false);
    expect(plain.interventions).not.toContain('working_notes_detected');
  });

  it('hands off when the rewrite fails (C6)', async () => {
    const { agent } = runner([{ text: LEAKED }, { error: new Error('provider down') }]);
    const result = await agent.run({ text: 'I am starting from zero', history: [] });
    expect(result.reply.escalate).toBe(true);
    expect(result.escalatedBy).toBe('leak');
  });

  it('rethrows an abort during the rewrite, as it does during the draft (C7)', async () => {
    const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { agent } = runner([{ text: LEAKED }, { error: aborted }]);
    await expect(agent.run({ text: 'I am starting from zero', history: [] })).rejects.toThrow(
      'aborted',
    );
  });
});

describe('notes are where the model weighs a rule (specs/001)', () => {
  it('asks for notes in the schema and in the prompt, in the same words', () => {
    expect(Object.keys(AgentReplyForModel.shape)).toContain('notes');
    const { staticPrefix } = buildSystemPrompt(
      fixtureTenant.persona,
      fixtureTenant.catalog,
      fixtureTenant.rules,
    );
    expect(staticPrefix).toContain(NOTES_DESCRIPTION);
  });

  it('never sends notes, and accepts a reply written without them', async () => {
    const withNotes = await runner([
      { text: reply(['Fridays.'], { notes: 'The date is not asked for yet.' }) },
    ]).agent.run({ text: 'hi', history: [] });
    expect(withNotes.reply.messages.join(' ')).not.toContain('not asked for');
    expect(withNotes.interventions).not.toContain('working_notes_detected');

    const without: Record<string, unknown> = reply(['Fridays.']);
    delete without.notes;
    const older = await runner([{ text: without }]).agent.run({ text: 'hi', history: [] });
    expect(older.reply.escalate).toBe(false);
  });

  it('strips a notes field written into a message, as any reply field (specs/001)', async () => {
    const result = await runner([
      { text: reply(['Fridays, 5 to 7pm.\nnotes: date left out']) },
    ]).agent.run({ text: 'hi', history: [] });
    expect(result.reply.messages[0]).toBe('Fridays, 5 to 7pm.');
    expect(result.interventions).toContain('field_echo_stripped');
  });
});
