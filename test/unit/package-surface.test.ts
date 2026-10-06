/**
 * specs/033-tenant-projects-not-forks.md § Verification.
 *
 * V1: `npm pack --dry-run --json`, in a tree holding a config/prompt.md and a
 *     .env, packs exactly the allowlist.
 * V2: the `exports` map names exactly the listed entry points, and an unlisted
 *     path fails with ERR_PACKAGE_PATH_NOT_EXPORTED.
 * V3: `agent upgrade` migrations are idempotent.
 * V4: each CLI command in the spec's table exists and exits non-zero on an
 *     invalid config/.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { runMigrations } from '../../src/migrations/index.ts';
import { COMMANDS, run } from '../../src/cli/run.ts';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  name: string;
  bin?: Record<string, string>;
  exports?: Record<string, unknown>;
  files?: string[];
  private?: boolean;
};

function plant(root: string, files: string[]) {
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), 'invented\n');
  }
}

/* ------------------------------------------------------------------ */
/* V1: npm pack allowlist                                              */
/* ------------------------------------------------------------------ */

describe('the packed tarball contains exactly the allowlist (specs/033 V1)', () => {
  const shipped = [
    'dist/cli.js',
    'dist/config/index.js',
    'db/migrations/0000_invented.sql',
    'README.md',
    'LICENSE',
    'CHANGELOG.md',
  ];
  const withheld = [
    'config/prompt.md',
    '.env',
    'src/main.ts',
    'test/unit/invented.test.ts',
    'evals/golden/cases.jsonl',
  ];
  let root: string;
  let packed: string[];

  beforeAll(() => {
    // A copy of the real package.json in a tree that holds what must stay out:
    // the `files` field under test, and nothing in CI that happens to be absent.
    root = mkdtempSync(join(tmpdir(), 'agent-pack-'));
    writeFileSync(join(root, 'package.json'), readFileSync('package.json'));
    plant(root, [...shipped, ...withheld]);
    const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    packed = (JSON.parse(raw) as { files: { path: string }[] }[])[0]!.files.map(file => file.path);
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('packs the allowlist and package.json, and nothing else', () => {
    expect(packed.sort()).toEqual([...shipped, 'package.json'].sort());
  });

  it('leaves config/prompt.md and .env out', () => {
    expect(packed).not.toContain('config/prompt.md');
    expect(packed).not.toContain('.env');
  });

  it('is not marked private', () => {
    expect(pkg.private).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* V2: exports map                                                     */
/* ------------------------------------------------------------------ */

describe('the exports map matches the spec table (specs/033 V2)', () => {
  it('names exactly the bare entry point, ./config and ./testing (specs/036)', () => {
    expect(Object.keys(pkg.exports ?? {}).sort()).toEqual(['.', './config', './testing']);
  });

  it('resolves a listed entry point and refuses an unlisted deep import', () => {
    // Installed under node_modules of a stand-in tenant project, so Node's own
    // resolver applies the exports map.
    const tenant = mkdtempSync(join(tmpdir(), 'agent-tenant-'));
    try {
      const installed = join(tenant, 'node_modules', pkg.name);
      mkdirSync(installed, { recursive: true });
      writeFileSync(join(installed, 'package.json'), readFileSync('package.json'));
      plant(installed, [
        'dist/index.js',
        'dist/config/index.js',
        'dist/testing/index.js',
        'dist/agent/runner.js',
      ]);

      const script = `
        const outcome = specifier => {
          try { require.resolve(specifier); return 'resolved'; }
          catch (error) { return error.code; }
        };
        console.log(JSON.stringify({
          bare: outcome('${pkg.name}'),
          config: outcome('${pkg.name}/config'),
          testing: outcome('${pkg.name}/testing'),
          deep: outcome('${pkg.name}/dist/agent/runner.js'),
        }));
      `;
      const out = execFileSync('node', ['-e', script], { cwd: tenant, encoding: 'utf8' });
      expect(JSON.parse(out)).toEqual({
        bare: 'resolved',
        config: 'resolved',
        testing: 'resolved',
        deep: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
      });
    } finally {
      rmSync(tenant, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ */
/* V3: agent upgrade migration idempotency                             */
/* ------------------------------------------------------------------ */

describe('agent upgrade migrations are idempotent (specs/033 V3)', () => {
  it('runs on fixture config and a second pass changes nothing', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agent-upgrade-'));
    try {
      cpSync('test/fixtures/config', tmp, { recursive: true });

      const first = runMigrations(tmp);
      const snapshotAfterFirst = readConfig(tmp);

      const second = runMigrations(tmp);
      const snapshotAfterSecond = readConfig(tmp);

      expect(snapshotAfterSecond).toEqual(snapshotAfterFirst);
      expect(second.unchanged).toBe(true);

      // With no migrations yet, both runs should be no-ops.
      expect(first.unchanged).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

function readConfig(dir: string): Record<string, string> {
  const files = ['prompt.md', 'catalog.json', 'rules.json', 'tools.json'];
  const result: Record<string, string> = {};
  for (const file of files) {
    try {
      result[file] = readFileSync(join(dir, file), 'utf8');
    } catch {
      // file may not exist
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* V4: CLI commands exist and fail on invalid config                    */
/* ------------------------------------------------------------------ */

/** The commands in the spec's own table, so a row added there is tested here. */
const specCommands = [
  ...readFileSync('specs/033-tenant-projects-not-forks.md', 'utf8').matchAll(
    /^\|\s*`agent ([a-z ]+?)(?: "[^"]*")?`\s*\|/gm,
  ),
].map(row => row[1]!);

describe('CLI commands exist and reject invalid config (specs/033 V4)', () => {
  // The values ci.yml sets, so only config/ can be what is wrong.
  const ciEnv = {
    AGENT_MODEL: 'mock:demo',
    PUBLIC_BASE_URL: 'https://ci.example.com',
    MANYCHAT_SHARED_SECRET: 'ci-secret-ci-secret-ci-secret-xx',
    DATABASE_URL: 'pglite',
  };

  let badConfig: string;
  let stderr: ReturnType<typeof vi.spyOn>;
  beforeAll(() => {
    badConfig = mkdtempSync(join(tmpdir(), 'bad-config-'));
    writeFileSync(join(badConfig, 'prompt.md'), 'invented persona');
    writeFileSync(join(badConfig, 'catalog.json'), '{}');
    writeFileSync(join(badConfig, 'rules.json'), '{}');
  });
  afterAll(() => rmSync(badConfig, { recursive: true, force: true }));
  beforeEach(() => {
    for (const [name, value] of Object.entries(ciEnv)) vi.stubEnv(name, value);
    vi.stubEnv('CONFIG_DIR', badConfig);
    stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('read the command table from the spec, and the CLI declares the same', () => {
    expect(specCommands).toEqual([
      'serve',
      'worker',
      'eval',
      'simulate',
      'config check',
      'upgrade',
      'tokens backfill',
    ]);
    expect(Object.keys(COMMANDS)).toEqual(specCommands);
  });

  it('passes config check on a valid config, so the environment is not the failure', async () => {
    vi.stubEnv('CONFIG_DIR', 'test/fixtures/config');
    expect(await run(['node', 'agent', 'config', 'check'])).toBe(0);
    expect(stderr).not.toHaveBeenCalled();
  });

  it.each(specCommands)('agent %s exits non-zero on an invalid config/', async command => {
    expect(await run(['node', 'agent', ...command.split(' ')])).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(`invalid config (${badConfig})`));
  });

  it('exits 2 with usage for no command or an unknown one', async () => {
    expect(await run(['node', 'agent'])).toBe(2);
    expect(await run(['node', 'agent', 'nonexistent'])).toBe(2);
  });

  it('reports a missing variable as the environment, not as config/', async () => {
    vi.stubEnv('CONFIG_DIR', 'test/fixtures/config');
    vi.stubEnv('MANYCHAT_SHARED_SECRET', undefined);
    expect(await run(['node', 'agent', 'config', 'check'])).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('invalid environment'));
    expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining('invalid config'));
  });

  it("the bin reads the tenant's .env from the directory it runs in", () => {
    // The tenant project's root holds config/ and .env and nothing else; no
    // variable comes from the shell (specs/033 § the tenant contract).
    const tenant = mkdtempSync(join(tmpdir(), 'agent-tenant-root-'));
    try {
      cpSync('test/fixtures/config', join(tenant, 'config'), { recursive: true });
      writeFileSync(
        join(tenant, '.env'),
        Object.entries(ciEnv)
          .map(([name, value]) => `${name}=${value}`)
          .join('\n'),
      );
      const result = spawnSync(
        'node',
        [
          '--experimental-strip-types',
          '--disable-warning=ExperimentalWarning',
          join(process.cwd(), 'src/cli.ts'),
          'config',
          'check',
        ],
        { cwd: tenant, encoding: 'utf8', env: { PATH: process.env.PATH } },
      );
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    } finally {
      rmSync(tenant, { recursive: true, force: true });
    }
  });

  it('the bin passes the exit code to the process', () => {
    // Two real processes, not one per command: each spawn competes for CPU
    // with the timing assertions elsewhere in the suite.
    const bin = (args: string[]) =>
      spawnSync(
        'node',
        [
          '--experimental-strip-types',
          '--disable-warning=ExperimentalWarning',
          'src/cli.ts',
          ...args,
        ],
        { encoding: 'utf8', env: { ...process.env, ...ciEnv, CONFIG_DIR: badConfig } },
      );
    expect(bin([]).status).toBe(2);
    const upgrade = bin(['upgrade']);
    expect(upgrade.status).toBe(1);
    expect(upgrade.stderr).toContain(`invalid config (${badConfig})`);
  });

  it('has a bin entry for agent', () => {
    expect(pkg.bin).toEqual({ agent: 'dist/cli.js' });
  });
});
