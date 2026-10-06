/**
 * specs/035-create-scaffolds-a-tenant-project.md § Verification.
 *
 * V1: the scaffolder, run into a temporary directory, writes a config/ equal to
 *     config/*.example byte for byte; the generated CI fails on a public
 *     repository; `agent config check` and `agent eval` against the mock model
 *     pass on the generated project; nothing it writes sets
 *     allowUnusedPatches.
 * V2: the release-please configuration releases `.` and `packages/create/` at
 *     one linked version.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';

const CREATE = 'packages/create';
const SCAFFOLDER = join(process.cwd(), CREATE, 'index.mjs');
const CLI = join(process.cwd(), 'src/cli.ts');

/** What `pnpm bootstrap` copies (packages/create/demo-tenant.mjs). */
const BOOTSTRAPPED = ['catalog.json', 'prompt.md', 'rules.json'];

const createPkg = JSON.parse(readFileSync(join(CREATE, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
};
const agentPkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  name: string;
  version: string;
};

function scaffold(target: string, scaffolder = SCAFFOLDER) {
  return spawnSync('node', [scaffolder, target], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });
}

/** An `agent` command run as a tenant runs it: from the project, with its .env. */
function agent(cwd: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(
    'node',
    ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', CLI, ...args],
    { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, ...env } },
  );
}

function filesUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else found.push(relative(root, path));
    }
  };
  walk(root);
  return found.sort();
}

interface Step {
  name?: string;
  run?: string;
  env?: Record<string, string>;
}

describe('create scaffolds a tenant project from the demo tenant (specs/035 V1)', () => {
  let tmp: string;
  let root: string;
  let result: ReturnType<typeof scaffold>;
  const read = (file: string) => readFileSync(join(root, file), 'utf8');

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'agent-create-'));
    root = join(tmp, 'my-agent');
    result = scaffold(root);
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('writes the files the spec lists, and nothing else', () => {
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(filesUnder(root)).toEqual(
      [
        '.env',
        '.github/workflows/ci.yml',
        '.gitignore',
        ...BOOTSTRAPPED.map(name => `config/${name}`),
        'docker-compose.yml',
        'evals/my-agent/cases.jsonl',
        'package.json',
        'renovate.json',
      ].sort(),
    );
  });

  it.each(BOOTSTRAPPED)('config/%s equals its committed example byte for byte', name => {
    // One source for the demo tenant, so no second copy of it can drift (C1).
    expect(
      readFileSync(join(root, 'config', name)).equals(readFileSync(`config/${name}.example`)),
    ).toBe(true);
  });

  it('writes .env with the offline defaults and a fresh secret', () => {
    const env = read('.env');
    expect(env).toMatch(/^AGENT_MODEL=mock:demo$/m);
    expect(env).toMatch(/^DATABASE_URL=pglite$/m);
    expect(env).toMatch(/^CONTACT_TOKENS_ENFORCED=false$/m);
    expect(env).toMatch(/^MANYCHAT_SHARED_SECRET=[0-9a-f]{64}$/m);
  });

  it('depends on the agent, and runs its image, at the version of the scaffolder', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.dependencies).toEqual({ [agentPkg.name]: `^${createPkg.version}` });
    // Tenant config is never published, whatever the tenant later adds.
    expect(pkg.private).toBe(true);
    expect(read('docker-compose.yml')).toContain(
      `image: ghcr.io/pedronastasi/manychat-ai-agent:${createPkg.version}\n`,
    );
  });

  it('enforces contact tokens in the Compose deployment, whatever the offline .env says', () => {
    // .env turns them off for `simulate`; Compose loads that same file, so the
    // service's own environment, which wins over env_file, turns them back on.
    const compose = parse(read('docker-compose.yml')) as {
      services: { agent: { env_file: string[]; environment: Record<string, string> } };
    };
    expect(compose.services.agent.env_file).toContain('.env');
    expect(compose.services.agent.environment.CONTACT_TOKENS_ENFORCED).toBe('true');
  });

  it('groups the package and the image into one Renovate pull request', () => {
    const renovate = JSON.parse(read('renovate.json'));
    expect(renovate.packageRules).toContainEqual(
      expect.objectContaining({
        matchPackageNames: [agentPkg.name, 'ghcr.io/pedronastasi/manychat-ai-agent'],
        automerge: false,
      }),
    );
  });

  it('ignores .env and tracks config/', () => {
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    const ignored = (path: string) =>
      spawnSync('git', ['check-ignore', '--quiet', path], { cwd: root }).status === 0;
    expect(ignored('.env')).toBe(true);
    expect(ignored('node_modules/x')).toBe(true);
    for (const name of BOOTSTRAPPED) expect(ignored(`config/${name}`)).toBe(false);
  });

  describe('the generated CI', () => {
    let steps: Step[];
    beforeAll(() => {
      const ci = parse(read('.github/workflows/ci.yml')) as {
        jobs: Record<string, { steps: Step[] }>;
      };
      steps = Object.values(ci.jobs)[0]!.steps;
    });

    it('fails on a public repository at its first step', () => {
      // The step's own script, run as the runner runs it, with what GitHub
      // puts in its environment for each case.
      const first = steps[0]!;
      expect(first.env?.PRIVATE).toBe('${{ github.event.repository.private }}');
      const exit = (value: string) =>
        spawnSync('bash', ['-e', '-c', first.run!], {
          encoding: 'utf8',
          env: { PATH: process.env.PATH, PRIVATE: value },
        }).status;
      expect(exit('false')).not.toBe(0);
      // A missing field fails too, rather than passing a public repository (C6).
      expect(exit('')).not.toBe(0);
      expect(exit('true')).toBe(0);
    });

    it('runs the config check, the eval suite against the mock model and the tests', () => {
      const runs = steps.map(step => step.run?.trim());
      expect(runs).toEqual(expect.arrayContaining(['pnpm check', 'pnpm eval', 'pnpm test']));
      const evalStep = steps.find(step => step.run?.trim() === 'pnpm eval');
      expect(evalStep?.env?.AGENT_MODEL).toBe('mock:demo');
    });
  });

  it('passes agent config check', () => {
    const check = agent(root, ['config', 'check']);
    expect(check.stderr).toBe('');
    expect(check.status).toBe(0);
  });

  it('passes agent eval against the mock model on the generated suite', () => {
    const script = JSON.parse(read('package.json')).scripts.eval as string;
    const suite = /^EVAL_DIR=(\S+) agent eval$/.exec(script)?.[1];
    expect(suite).toBe('evals/my-agent');
    const run = agent(root, ['eval'], { EVAL_DIR: suite! });
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/\b5 passed\s+0 failed/);
  });

  it('never sets allowUnusedPatches', () => {
    // specs/033 § An urgent fix: set, an upgrade silently keeps a stale patch.
    for (const file of filesUnder(root).filter(path => !path.startsWith('.git/'))) {
      expect(read(file), file).not.toContain('allowUnusedPatches');
    }
  });

  it('refuses a directory that is not empty, and writes nothing', () => {
    const before = read('.env');
    const again = scaffold(root);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain('is not empty');
    expect(read('.env')).toBe(before);
  });

  it('exits with usage when given no directory', () => {
    const none = spawnSync('node', [SCAFFOLDER], { encoding: 'utf8' });
    expect(none.status).toBe(2);
    expect(none.stderr).toContain('Usage');
  });
});

describe('the published scaffolder carries the demo tenant it reads (specs/035 V1)', () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'agent-create-pack-'));
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('scaffolds the same config/ from the packed tarball, outside this repository', () => {
    // prepack copies the examples in; postpack removes them, so a stale copy
    // can never shadow the committed files in this checkout.
    const tarball = execFileSync('npm', ['pack', '--silent', '--pack-destination', tmp], {
      cwd: CREATE,
      encoding: 'utf8',
    }).trim();
    expect(existsSync(join(CREATE, 'agent'))).toBe(false);
    execFileSync('tar', ['-xzf', join(tmp, tarball), '-C', tmp]);

    const root = join(tmp, 'packed-agent');
    const packed = scaffold(root, join(tmp, 'package', 'index.mjs'));
    expect(packed.stderr).toBe('');
    expect(packed.status).toBe(0);
    for (const name of BOOTSTRAPPED) {
      expect(
        readFileSync(join(root, 'config', name)).equals(readFileSync(`config/${name}.example`)),
      ).toBe(true);
    }
  });
});

describe('the agent and the scaffolder are released as one version (specs/035 V2)', () => {
  const config = JSON.parse(readFileSync('release-please-config.json', 'utf8')) as {
    'separate-pull-requests'?: boolean;
    packages: Record<
      string,
      {
        component?: string;
        'include-component-in-tag'?: boolean;
        'extra-files'?: { type: string; path: string; jsonpath?: string }[];
      }
    >;
    plugins?: unknown[];
  };
  const manifest = JSON.parse(readFileSync('.release-please-manifest.json', 'utf8')) as Record<
    string,
    string
  >;

  it('releases one package, the agent, so there is one version and one tag', () => {
    expect(Object.keys(config.packages)).toEqual(['.']);
    expect(Object.keys(manifest)).toEqual(['.']);
    expect(config.packages['.']?.component).toBe(agentPkg.name);
    expect(config).not.toHaveProperty('plugins');
  });

  it("sets the scaffolder's version with the agent's on every release", () => {
    expect(config.packages['.']?.['extra-files']).toContainEqual({
      type: 'json',
      path: `${CREATE}/package.json`,
      jsonpath: '$.version',
    });
    // The scaffolder writes `^<its version>` and the image tag `<its version>`
    // into a new project, so a version behind the agent starts it a release
    // behind.
    expect(createPkg.version).toBe(agentPkg.version);
    expect(createPkg.version).toBe(manifest['.']);
  });

  it('opens a release pull request per package, which release-please can match on merge', () => {
    // With the merged pull request of a multi-package manifest, a release of
    // the agent alone was never tagged: release-please matched it to no
    // package (release-please 17.6.0, strategies/base.js), and 0.17.0 went
    // out only after its release pull request was edited by hand.
    expect(config['separate-pull-requests']).toBe(true);
  });

  it('keeps the agent tagged v<version>, as its image tags and installed tenants expect', () => {
    expect(config.packages['.']?.['include-component-in-tag']).toBe(false);
  });

  it('publishes the scaffolder from the same tag, after the agent', () => {
    const release = parse(readFileSync('.github/workflows/release.yml', 'utf8')) as {
      jobs: Record<string, { steps: { run?: string; 'working-directory'?: string }[] }>;
    };
    const steps = release.jobs['publish-npm']!.steps;
    const publishes = steps.filter(step => step.run?.startsWith('npm publish'));
    expect(publishes.map(step => step['working-directory'])).toEqual([undefined, CREATE]);
  });
});
