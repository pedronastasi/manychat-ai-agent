/**
 * Copies what the scaffolder reads from the repository root into `agent/`
 * before a pack, and removes it after (specs/035). The published scaffolder
 * cannot reach outside its own package, and a copy committed here would be a
 * second source of the demo tenant.
 */
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXAMPLE_CONFIG } from './demo-tenant.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'agent');
rmSync(out, { recursive: true, force: true });

if (!process.argv.includes('--clean')) {
  const files = [...EXAMPLE_CONFIG.map(([from]) => from), '.env.example', 'package.json'];
  for (const file of files) {
    mkdirSync(dirname(join(out, file)), { recursive: true });
    copyFileSync(join(here, '..', '..', file), join(out, file));
  }
}
