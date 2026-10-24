import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../../src/cli/run.ts';

/**
 * specs/043-complete-conversation-evals.md § Verification item 11: the
 * offline validation and the two-repetition run through the real
 * `agent eval conversations` entry point, on the mock model, the simulated
 * channel and an embedded database, so neither reaches a provider or
 * ManyChat. The golden conversations are English and invented (C1, C9).
 */

const CI_ENV = {
  AGENT_MODEL: 'mock:demo',
  PUBLIC_BASE_URL: 'https://ci.example.com',
  MANYCHAT_SHARED_SECRET: 'ci-secret-ci-secret-ci-secret-xx',
  DATABASE_URL: 'pglite',
  CONFIG_DIR: 'test/fixtures/config',
};

/** Runs the command as `pnpm eval:conversations` does, and returns its exit code and output. */
function conversations(args: string[], extra: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...CI_ENV, ...extra };
  for (const name of ['EVAL_JUDGE_MODEL', 'EVAL_DIR', 'AGENT_RUNNER', 'PLAYBOOK_VERSION']) {
    if (!(name in extra)) delete env[name];
  }
  const run = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--disable-warning=ExperimentalWarning',
      'src/cli.ts',
      'eval',
      'conversations',
      ...args,
    ],
    { env, encoding: 'utf8', timeout: 240_000 },
  );
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

describe('the conversation command runs offline (specs/043 V11)', () => {
  it('validates the golden suite without running a turn', () => {
    const { status, output } = conversations(['--validate']);
    expect(output).toContain(
      'conversation suite evals/golden is valid: 4 scenarios, 9 steps, 7 branches, 4 calibration conversations',
    );
    expect(status).toBe(0);
  });

  // specs/043 V7: a changed source leaves the inventory stale until it is
  // reconciled, and the command says which and what it hashes to now.
  it('exits nonzero on a stale inventory and names the changed source (specs/043 V7)', () => {
    const config = mkdtempSync(join(tmpdir(), 'tenant-'));
    cpSync('test/fixtures/config', config, { recursive: true });
    writeFileSync(
      join(config, 'prompt.md'),
      `${readFileSync(join(config, 'prompt.md'), 'utf8')}\nOne new invented instruction.\n`,
    );
    const { status, output } = conversations(['--validate'], { CONFIG_DIR: config });
    expect(output).toMatch(
      /stale: prompt\.md was reconciled at [0-9a-f]{64}; it is now [0-9a-f]{64}/,
    );
    expect(status).toBe(1);
  });

  it('exits nonzero when the suite has no branch inventory (specs/043 V7)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conversations-'));
    cpSync('evals/golden/conversations.jsonl', join(dir, 'conversations.jsonl'));
    // Witnesses need an inventory to point at; strip them.
    const lines = readFileSync(join(dir, 'conversations.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line =>
        JSON.stringify(JSON.parse(line), (key, value: unknown) =>
          key === 'witnesses' ? undefined : value,
        ),
      );
    writeFileSync(join(dir, 'conversations.jsonl'), `${lines.join('\n')}\n`);
    const { status, output } = conversations(['--validate'], { EVAL_DIR: dir });
    expect(output).toContain('no branches.json: branch coverage cannot be complete');
    expect(status).toBe(1);
  });

  it('fails validation, and runs nothing, on a suite that does not hold', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conversations-'));
    writeFileSync(
      join(dir, 'conversations.jsonl'),
      JSON.stringify({ id: 'x', description: 'x', steps: [], expect: { terminal: 'completed' } }),
    );
    const { status, output } = conversations([], { EVAL_DIR: dir });
    expect(status).toBe(1);
    expect(output).toContain('is invalid');
    expect(output).not.toContain('agent turns');
  });

  // In process, through the same dispatcher `agent` uses, so what the run
  // executes is measured as well as asserted.
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('runs every golden scenario twice and writes both reports', async () => {
    const artifacts = mkdtempSync(join(tmpdir(), 'conversation-reports-'));
    for (const [name, value] of Object.entries({ ...CI_ENV, EVAL_ARTIFACTS_DIR: artifacts })) {
      vi.stubEnv(name, value);
    }
    for (const name of ['EVAL_JUDGE_MODEL', 'EVAL_DIR', 'AGENT_RUNNER', 'PLAYBOOK_VERSION']) {
      vi.stubEnv(name, undefined);
    }
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const status = await run(['node', 'agent', 'eval', 'conversations']);
    const output = lines.join('\n');
    expect(output).toContain('agent turns: up to 18 (2 repetitions)');
    expect(output).toMatch(
      /4 passed {3}0 failed {3}0 judged-fail {3}0 pending review {3}0 unstable {3}0 execution errors/,
    );
    expect(output).toContain('coverage: 7 of 7 branches verified, 0 stale sources, 0 conflicted');
    expect(status).toBe(0);

    const files = readdirSync(artifacts);
    const json = files.find(name => name.endsWith('.json'));
    expect(files.some(name => name.endsWith('.md'))).toBe(true);
    const report = JSON.parse(readFileSync(join(artifacts, json!), 'utf8')) as {
      hashes: { config: string; scenarios: string; branches: string };
      coverage: { complete: boolean };
      agent: { model: string };
      judge: null;
      scenarios: { repetitions: unknown[] }[];
    };
    expect(report.hashes.config).toMatch(/^[0-9a-f]{64}$/);
    expect(report.hashes.scenarios).toMatch(/^[0-9a-f]{64}$/);
    expect(report.agent.model).toBe('mock:demo');
    expect(report.judge).toBeNull();
    expect(report.hashes.branches).toMatch(/^[0-9a-f]{64}$/);
    expect(report.coverage.complete).toBe(true);
    expect(report.scenarios.map(scenario => scenario.repetitions.length)).toEqual([2, 2, 2, 2]);

    // specs/043 V10: the gate reads the written run and decides beside it,
    // without rewriting it. The golden suite has no criteria to review.
    lines.length = 0;
    const before = readFileSync(join(artifacts, json!), 'utf8');
    expect(
      await run(['node', 'agent', 'eval', 'conversations', '--gate', join(artifacts, json!)]),
    ).toBe(0);
    expect(lines.join('\n')).toContain('passes the gate');
    expect(readFileSync(join(artifacts, json!), 'utf8')).toBe(before);
    const decision = JSON.parse(
      readFileSync(join(artifacts, json!.replace(/\.json$/, '.gate.json')), 'utf8'),
    ) as { passed: boolean; stale: boolean };
    expect(decision).toMatchObject({ passed: true, stale: false });

    // The same run, judged against an edited tenant, is stale.
    const config = mkdtempSync(join(tmpdir(), 'tenant-'));
    cpSync('test/fixtures/config', config, { recursive: true });
    writeFileSync(
      join(config, 'catalog.json'),
      readFileSync(join(config, 'catalog.json'), 'utf8').replace('450', '451'),
    );
    vi.stubEnv('CONFIG_DIR', config);
    lines.length = 0;
    expect(
      await run(['node', 'agent', 'eval', 'conversations', '--gate', join(artifacts, json!)]),
    ).toBe(1);
    expect(lines.join('\n')).toMatch(/the run is stale/);
  }, 240_000);
});
