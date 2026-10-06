/**
 * First-run setup: creates the local tenant config and .env from the committed
 * examples. Never overwrites an existing file.
 */
import { copyFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { EXAMPLE_CONFIG, offlineEnv } from '../packages/create/demo-tenant.mjs';

for (const [from, to] of EXAMPLE_CONFIG) {
  if (existsSync(to)) {
    console.log(`  kept     ${to}`);
  } else {
    copyFileSync(from, to);
    console.log(`  created  ${to}`);
  }
}

if (existsSync('.env')) {
  console.log('  kept     .env');
} else {
  const env = offlineEnv(readFileSync('.env.example', 'utf8'), randomBytes(32).toString('hex'));
  writeFileSync('.env', env);
  console.log('  created  .env  (offline defaults: mock model, embedded database)');
}

console.log('\n  Ready. Start with:  pnpm dev\n');
