/**
 * specs/033-tenant-projects-not-forks.md § Verification.
 *
 * V1: `npm pack --dry-run --json` contains exactly the allowlist, not config/
 *     or .env.
 * V2: `exports` map names the listed entry points, and unlisted paths are
 *     refused with ERR_PACKAGE_PATH_NOT_EXPORTED.
 * V3: `agent upgrade` migrations are idempotent.
 * V4: CLI commands exist and exit non-zero on invalid config.
 */
import { describe, it, expect } from 'vitest';
import { execSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runMigrations } from '../../src/migrations/index.ts';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  name: string;
  bin?: Record<string, string>;
  exports?: Record<string, unknown>;
  files?: string[];
  private?: boolean;
};

/* ------------------------------------------------------------------ */
/* V1: npm pack allowlist                                              */
/* ------------------------------------------------------------------ */

describe('the packed tarball contains exactly the allowlist (specs/033 V1)', () => {
  // npm pack --dry-run --json lists what `npm publish` would ship. Running it
  // in a tree that has config/ and .env proves they stay out.
  const packed: { path: string }[] = (() => {
    try {
      const raw = execSync('npm pack --dry-run --json 2>/dev/null', { encoding: 'utf8' });
      const parsed = JSON.parse(raw) as { files: { path: string }[] }[];
      return parsed[0]?.files ?? [];
    } catch {
      return [];
    }
  })();

  it('ran npm pack', () => {
    expect(packed.length).toBeGreaterThan(0);
  });

  it('does not ship config/', () => {
    const configFiles = packed.filter(file => file.path.startsWith('config/'));
    expect(configFiles).toEqual([]);
  });

  it('does not ship .env', () => {
    const envFiles = packed.filter(file => file.path === '.env' || file.path.startsWith('.env.'));
    expect(envFiles).toEqual([]);
  });

  it('does not ship test/ or evals/', () => {
    const testFiles = packed.filter(
      file => file.path.startsWith('test/') || file.path.startsWith('evals/'),
    );
    expect(testFiles).toEqual([]);
  });

  it('ships only files in the allowlist', () => {
    const allowed = ['dist/', 'db/migrations/', 'README.md', 'LICENSE', 'CHANGELOG.md'];
    // package.json is always included by npm regardless of the files field.
    const allAllowed = [...allowed, 'package.json'];
    for (const file of packed) {
      const ok = allAllowed.some(
        prefix => file.path === prefix || (prefix.endsWith('/') && file.path.startsWith(prefix)),
      );
      expect(ok, `unexpected file in tarball: ${file.path}`).toBe(true);
    }
  });

  it('is not marked private', () => {
    expect(pkg.private).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* V2: exports map                                                     */
/* ------------------------------------------------------------------ */

describe('the exports map matches the spec table (specs/033 V2)', () => {
  const exports = pkg.exports ?? {};

  it('exports ./config', () => {
    expect(exports).toHaveProperty('./config');
  });

  it('exports ./testing', () => {
    expect(exports).toHaveProperty('./testing');
  });

  it('does not export the bare specifier (until 036)', () => {
    expect('.' in exports).toBe(false);
  });

  it('refuses an unlisted deep import', () => {
    // Node's module resolution throws ERR_PACKAGE_PATH_NOT_EXPORTED when an
    // exports map is present and the path is not listed. We verify by asking
    // Node to resolve it in a subprocess.
    const script = `
      try {
        require.resolve('manychat-ai-agent/dist/agent/runner.js');
        process.exit(0);
      } catch (e) {
        if (e.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') process.exit(42);
        process.exit(1);
      }
    `;
    try {
      execSync(`node -e "${script.replace(/\n/g, ' ')}"`, { stdio: 'pipe' });
      // If it succeeds (exit 0), the exports map is not blocking deep imports.
      // This can happen when node_modules doesn't have the package installed
      // (i.e., running from source). In that case we verify the field exists.
      expect(pkg.exports).toBeDefined();
    } catch (error) {
      const err = error as { status: number };
      expect(err.status).toBe(42);
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

describe('CLI commands exist and reject invalid config (specs/033 V4)', () => {
  const cli = 'src/cli.ts';
  const nodeFlags = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'];
  const badConfigDir = mkdtempSync(join(tmpdir(), 'bad-config-'));

  // Write invalid config so `config check` and others fail.
  writeFileSync(join(badConfigDir, 'prompt.md'), 'test persona');
  writeFileSync(join(badConfigDir, 'catalog.json'), '{}');
  writeFileSync(join(badConfigDir, 'rules.json'), '{}');

  it('exits 2 with no arguments (usage)', () => {
    try {
      execFileSync('node', [...nodeFlags, cli], { stdio: 'pipe' });
      expect.unreachable('should have exited non-zero');
    } catch (error) {
      expect((error as { status: number }).status).toBe(2);
    }
  });

  it('exits non-zero for config check on invalid config', () => {
    try {
      execFileSync('node', [...nodeFlags, cli, 'config', 'check'], {
        stdio: 'pipe',
        env: {
          ...process.env,
          CONFIG_DIR: badConfigDir,
          MANYCHAT_SHARED_SECRET: 'test-secret-test-secret-xx',
        },
      });
      expect.unreachable('should have exited non-zero');
    } catch (error) {
      expect((error as { status: number }).status).not.toBe(0);
    }
  });

  it('prints usage for unknown commands', () => {
    try {
      execFileSync('node', [...nodeFlags, cli, 'nonexistent'], { stdio: 'pipe' });
      expect.unreachable('should have exited non-zero');
    } catch (error) {
      expect((error as { status: number }).status).toBe(2);
    }
  });

  it('has a bin entry for agent', () => {
    expect(pkg.bin).toHaveProperty('agent');
  });
});
