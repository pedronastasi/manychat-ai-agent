import { describe, it, expect } from 'vitest';
import { EnvSchema, LANGCHAIN_OUTPUTS } from '../../src/contracts/config/env.ts';
import { Tracing } from '../../src/observability/tracing.ts';

/**
 * specs/052-traces-carry-shape-not-text.md § Verification: tracing is on only
 * when this repository's own variable says so, and LangChain's own switches
 * stay refused. Every value here is invented (C1).
 */

/** The variables boot requires, all invented. */
const base = {
  AGENT_MODEL: 'anthropic:claude-haiku-4-5',
  PUBLIC_BASE_URL: 'https://agent.example.com',
  MANYCHAT_SHARED_SECRET: 'a'.repeat(32),
  DATABASE_URL: 'pglite',
};
const traced = {
  ...base,
  TRACE_TURNS: 'langsmith',
  LANGSMITH_API_KEY: 'invented-key',
  LANGSMITH_PROJECT: 'demo-project',
};

const pathsOf = (input: object) =>
  EnvSchema.safeParse(input).error?.issues.map(issue => issue.path.join('.')) ?? [];

describe('the opt-in (specs/052 V4)', () => {
  it('is off by default, and builds no tracing', () => {
    const env = EnvSchema.parse(base);
    expect(env.TRACE_TURNS).toBe('off');
    expect(Tracing.fromEnv(env, { warn: () => {} })).toBeUndefined();
  });

  it.each(['LANGSMITH_API_KEY', 'LANGSMITH_PROJECT'])(
    'stops boot when TRACE_TURNS=langsmith has no %s',
    name => {
      const rest: Record<string, string> = { ...traced };
      delete rest[name];
      expect(pathsOf(rest)).toContain(name);
    },
  );

  it('boots with a key and a project, and builds tracing', () => {
    const env = EnvSchema.parse(traced);
    expect(env.LANGSMITH_ENDPOINT).toBe('https://api.smith.langchain.com');
    expect(Tracing.fromEnv(env, { warn: () => {} })).toBeInstanceOf(Tracing);
  });

  it('refuses any other value', () => {
    expect(pathsOf({ ...base, TRACE_TURNS: 'true' })).toContain('TRACE_TURNS');
  });
});

describe('the refusals stand (specs/052 V5)', () => {
  it.each(LANGCHAIN_OUTPUTS)('refuses %s="true" with TRACE_TURNS=langsmith too', name => {
    expect(pathsOf({ ...traced, [name]: 'true' })).toContain(name);
  });

  it('refuses LANGCHAIN_CALLBACKS_BACKGROUND="false" while tracing is on', () => {
    expect(pathsOf({ ...traced, LANGCHAIN_CALLBACKS_BACKGROUND: 'false' })).toContain(
      'LANGCHAIN_CALLBACKS_BACKGROUND',
    );
  });

  it('leaves LANGCHAIN_CALLBACKS_BACKGROUND alone while tracing is off', () => {
    expect(EnvSchema.safeParse({ ...base, LANGCHAIN_CALLBACKS_BACKGROUND: 'false' }).success).toBe(
      true,
    );
  });
});
