import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';

/**
 * specs/016-model-graded-evals.md § Verification item 4: the golden suite
 * through the real `eval` entry point, offline, without a judge and with the
 * mock judge that passes everything.
 */

const CI_ENV = {
  AGENT_MODEL: 'mock:demo',
  PUBLIC_BASE_URL: 'https://ci.example.com',
  MANYCHAT_SHARED_SECRET: 'ci-secret-ci-secret-ci-secret-xx',
  DATABASE_URL: 'pglite',
  CONFIG_DIR: 'test/fixtures/config',
};

/** Runs the suite as `pnpm eval:mock` does, and returns its exit code and plain output. */
function evalMock(extra: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...CI_ENV, ...extra };
  for (const name of ['EVAL_JUDGE_MODEL', 'EVAL_DIR', 'AGENT_RUNNER']) {
    if (!(name in extra)) delete env[name];
  }
  const run = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', 'evals/run.ts'],
    { env, encoding: 'utf8', timeout: 240_000 },
  );
  // eslint-disable-next-line no-control-regex
  const output = `${run.stdout}${run.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
  return { status: run.status, output };
}

describe('the golden suite with and without the mock judge (specs/016 V4)', () => {
  it('runs as specs/009 defines without a judge: no calibration, three counts', () => {
    const { status, output } = evalMock();
    expect(status).toBe(0);
    expect(output).not.toContain('calibration');
    expect(output).not.toMatch(/judged|ungraded/);
    expect(output).toMatch(/\d+ passed {3}0 failed {3}\d+ to review {3}p95/);
  }, 300_000);

  it('refuses the mock judge: exit 0, every group uncalibrated, zero judged-pass', () => {
    const { status, output } = evalMock({ EVAL_JUDGE_MODEL: 'mock:judge' });
    expect(status).toBe(0);
    for (const group of [
      'implicit_concession',
      'semantic_repetition',
      'answers_the_question',
      'free_text',
    ]) {
      expect(output).toMatch(new RegExp(`${group} +\\d+ items .*uncalibrated`));
    }
    expect(output).not.toMatch(/ calibrated$/m);
    expect(output).toMatch(/ 0 judged-fail {3}0 judged-pass /);
  }, 300_000);
});
