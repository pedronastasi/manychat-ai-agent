#!/usr/bin/env node
/**
 * `npm create manychat-ai-agent@latest my-agent` (specs/035).
 *
 * Generates a tenant project from the fictional demo tenant and nothing else.
 * Never from a live deployment, and never over an existing directory.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXAMPLE_CONFIG, offlineEnv } from './demo-tenant.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Where the demo tenant is read from. Published, `prepack` has copied it into
 * `agent/`; in this repository it is the root, so the scaffolder and
 * `pnpm bootstrap` read the same committed files (C1, C9).
 */
const agentRoot = existsSync(join(here, 'agent')) ? join(here, 'agent') : join(here, '..', '..');

const { version } = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
const agent = JSON.parse(readFileSync(join(agentRoot, 'package.json'), 'utf8'));

const target = process.argv[2];
if (target === undefined || target.startsWith('-')) {
  console.error('Usage: npm create manychat-ai-agent@latest <directory>');
  process.exit(2);
}

const root = resolve(target);
const name = basename(root);
// The name becomes the package name and the eval suite's directory.
if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
  console.error(`"${name}" is not a valid name: use lowercase letters, digits, ".", "_" or "-".`);
  process.exit(2);
}
if (existsSync(root) && readdirSync(root).length > 0) {
  console.error(`${root} is not empty. Nothing was written.`);
  process.exit(1);
}

const template = file => readFileSync(join(here, 'template', file), 'utf8');

function write(path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
  console.log(`  created  ${path}`);
}

for (const [from, to] of EXAMPLE_CONFIG) {
  write(to, readFileSync(join(agentRoot, from)));
}
write(
  '.env',
  offlineEnv(
    readFileSync(join(agentRoot, '.env.example'), 'utf8'),
    randomBytes(32).toString('hex'),
  ),
);
write(`evals/${name}/cases.jsonl`, template('cases.jsonl'));
write(
  'package.json',
  `${JSON.stringify(
    {
      name,
      // config/ is real tenant data once the tenant replaces the demo, so this
      // project is never published.
      private: true,
      type: 'module',
      packageManager: agent.packageManager,
      scripts: {
        check: 'agent config check',
        eval: `EVAL_DIR=evals/${name} agent eval`,
        test: 'vitest run --passWithNoTests',
      },
      dependencies: { 'manychat-ai-agent': `^${version}` },
      devDependencies: {
        // The embedded database the offline .env selects; the agent leaves it
        // to the tenant as an optional peer, so the image does not carry it.
        '@electric-sql/pglite': agent.peerDependencies['@electric-sql/pglite'],
        vitest: agent.devDependencies.vitest,
      },
    },
    null,
    2,
  )}\n`,
);
write('docker-compose.yml', template('docker-compose.yml').replaceAll('{{version}}', version));
write('.github/workflows/ci.yml', template('ci.yml'));
write('renovate.json', template('renovate.json'));
write('.gitignore', template('gitignore'));

console.log(`
  Ready. Next:

    cd ${target}
    pnpm install
    pnpm check && pnpm eval

  config/ is the fictional demo tenant: replace it with your own. Keep this
  repository private; its CI fails when it is public.
`);
