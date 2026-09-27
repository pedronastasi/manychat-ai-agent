/**
 * First-run setup: creates the local tenant config and .env from the committed
 * examples. Never overwrites an existing file.
 */
import { copyFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const pairs = [
  ['config/prompt.md.example', 'config/prompt.md'],
  ['config/catalog.json.example', 'config/catalog.json'],
  ['config/rules.json.example', 'config/rules.json'],
];

for (const [from, to] of pairs) {
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
  const env = readFileSync('.env.example', 'utf8')
    .replace(
      'MANYCHAT_SHARED_SECRET=change-me-to-a-long-random-string',
      `MANYCHAT_SHARED_SECRET=${randomBytes(32).toString('hex')}`,
    )
    // Default to a runnable offline setup: no API key, no database to install.
    .replace('AGENT_MODEL=anthropic:claude-haiku-4-5', 'AGENT_MODEL=mock:demo')
    .replace('DATABASE_URL=postgres://agent:agent@localhost:5432/agent', 'DATABASE_URL=pglite')
    // With no ManyChat account there is no field to hold a contact's token, so
    // `pnpm simulate` could never present one and would get no history.
    .replace('CONTACT_TOKENS_ENFORCED=true', 'CONTACT_TOKENS_ENFORCED=false');
  writeFileSync('.env', env);
  console.log('  created  .env  (offline defaults: mock model, embedded database)');
}

console.log('\n  Ready. Start with:  pnpm dev\n');
