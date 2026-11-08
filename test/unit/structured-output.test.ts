import { describe, it, expect, vi, afterEach } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { Analyst, ANALYST_SETTINGS } from '../../src/learning/analyst.ts';
import type { AnalystInput } from '../../src/learning/analyst.ts';
import { Judge, JUDGE_SETTINGS } from '../../src/evals/judge.ts';
import {
  estimateCostUsd,
  resolveChatModel,
  resolveChatModelOnUse,
  UnknownProviderError,
} from '../../src/agent/registry.ts';

/**
 * specs/053-one-model-library.md § Verification, Structured output: the
 * judges and the analyst parse and validate the model's JSON themselves
 * (§ The judges and the analyst validate their own output). The model is
 * faked at the provider boundary (specs/004); every value is invented (C1).
 */

const SPEC = 'anthropic:claude-haiku-4-5';
const TOKENS = { inputTokens: 10, outputTokens: 5 };
const ONE_CALL = estimateCostUsd(SPEC, TOKENS);

/** A model answering each call with `answers[call]`, reporting 10 in and 5 out. */
function fake(answers: string[]) {
  let call = 0;
  return new MockLanguageModelV4({
    doGenerate: () =>
      Promise.resolve({
        content: [{ type: 'text' as const, text: answers[call++] ?? answers.at(-1)! }],
        finishReason: { unified: 'stop' as const, raw: 'end_turn' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
        warnings: [],
      }),
  });
}

const input: AnalystInput = {
  language: 'English',
  playbook: [],
  rejected: [],
  converted: [],
  notConverted: [],
};

describe('the analyst records an unparseable answer and still bills it (specs/053 V9)', () => {
  it('names NoObjectGeneratedError, without the AI_ prefix, for an answer that is not JSON', async () => {
    const analyst = new Analyst({ model: fake(['not json']), modelSpec: SPEC });
    const result = await analyst.propose(input);
    expect(result).toEqual({
      output: undefined,
      costUsd: ONE_CALL,
      error: 'NoObjectGeneratedError',
    });
  });

  it('names the same error, billed, for JSON that fails AnalystOutput, as Output.object did', async () => {
    const analyst = new Analyst({
      model: fake([JSON.stringify({ proposals: 'not a list' })]),
      modelSpec: SPEC,
    });
    expect(await analyst.propose(input)).toEqual({
      output: undefined,
      costUsd: ONE_CALL,
      error: 'NoObjectGeneratedError',
    });
  });

  it('returns the validated output and its cost when the answer fits', async () => {
    const analyst = new Analyst({
      model: fake([JSON.stringify({ proposals: [] })]),
      modelSpec: SPEC,
    });
    expect(await analyst.propose(input)).toEqual({ output: { proposals: [] }, costUsd: ONE_CALL });
  });
});

describe('a judge counts an unparseable answer as one invalid, unbilled sample (specs/053 V9)', () => {
  const pass = JSON.stringify({ verdict: 'pass', evidence: '', reason: 'Meets it.' });

  it('grades from the other two samples, and bills only the two that parsed', async () => {
    const judge = new Judge({ model: fake(['not json', pass, pass]), modelSpec: SPEC });
    const grade = await judge.grade({
      criterion: 'warm',
      history: [],
      text: 'hi',
      reply: ['Hello, happy to help.'],
      agentPrompt: 'An invented front desk.',
    });
    expect(grade).toMatchObject({ outcome: 'pass' });
    expect(judge.costUsd).toBeCloseTo(2 * ONE_CALL, 12);
  });
});

describe('the judges and the analyst build their model on first use, as before (specs/053 V9)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('boots with no key, and fails the analyst’s first run instead', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const handle = resolveChatModelOnUse(SPEC, ANALYST_SETTINGS, 'INSIGHT_MODEL');
    const result = await new Analyst({ model: handle, modelSpec: SPEC }).propose(input);
    expect(result.output).toBeUndefined();
    expect(result.error).toBe('UnknownProviderError');
  });

  it('grades nothing, rather than stopping the run, when the judge has no key', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const judge = new Judge({
      model: resolveChatModelOnUse(SPEC, JUDGE_SETTINGS, 'EVAL_JUDGE_MODEL'),
      modelSpec: SPEC,
    });
    expect(
      await judge.grade({
        criterion: 'warm',
        history: [],
        text: 'hi',
        reply: ['Hello, happy to help.'],
        agentPrompt: 'An invented front desk.',
      }),
    ).toEqual({ outcome: 'ungraded', split: false });
  });

  it('still fails boot on a provider it does not know, naming the variable', () => {
    expect(() => resolveChatModelOnUse('typo:model', ANALYST_SETTINGS, 'INSIGHT_MODEL')).toThrow(
      UnknownProviderError,
    );
    expect(() => resolveChatModelOnUse('typo:model', ANALYST_SETTINGS, 'INSIGHT_MODEL')).toThrow(
      /INSIGHT_MODEL/,
    );
  });

  it('builds Gemini from GOOGLE_GENERATIVE_AI_API_KEY, the key .env.example documents', () => {
    vi.stubEnv('GOOGLE_API_KEY', '');
    vi.stubEnv('GEMINI_API_KEY', '');
    vi.stubEnv('GOOGLE_GENERATIVE_AI_API_KEY', 'invented-key-for-tests');
    expect(() => resolveChatModel('google:gemini-2.5-flash', JUDGE_SETTINGS)).not.toThrow();
  });
});
