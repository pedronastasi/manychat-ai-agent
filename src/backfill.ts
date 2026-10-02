/**
 * Issues contact tokens to existing contacts: step 2 of the rollout in
 * specs/019. With `--check`, reports how many contacts with a turn in the past
 * `historyDays` still lack a token hash and exits non-zero if any do, which is
 * step 4.
 *
 *   pnpm tokens:backfill [--check]           from a checkout
 *   node dist/backfill.js [--check]          inside the image
 *
 * Kept apart from its logic, which is tested in src/conversation/backfill.ts,
 * for the same reason as main.ts. It prints counts only, never a token.
 */
import { loadEnv, loadTenantConfig } from './config/loader.ts';
import { createDatabase, createEmbeddedDatabase, isEmbedded } from './db/client.ts';
import type { Database } from './db/client.ts';
import { manychatClientFor } from './channels/manychat/client.ts';
import { ContactTokens } from './conversation/tokens.ts';
import { backfillContactTokens, countContactsWithoutTokens } from './conversation/backfill.ts';

const DAY_MS = 86_400_000;

async function run() {
  const env = loadEnv();
  const { rules } = loadTenantConfig(process.env.CONFIG_DIR ?? 'config');
  const check = process.argv.includes('--check');

  let db: Database;
  if (isEmbedded(env.DATABASE_URL)) {
    const embedded = await createEmbeddedDatabase(env.DATABASE_URL);
    db = embedded.db as unknown as Database;
  } else {
    db = createDatabase(env.DATABASE_URL, { max: 2 });
  }

  const scope = {
    tenantId: env.TENANT_ID,
    since: new Date(Date.now() - rules.historyDays * DAY_MS),
  };

  if (check) {
    const missing = await countContactsWithoutTokens(db, scope);
    console.log(
      `contacts with a turn in the past ${rules.historyDays} days and no token: ${missing}`,
    );
    return missing === 0 ? 0 : 1;
  }

  if (!env.MANYCHAT_API_TOKEN) {
    console.error('MANYCHAT_API_TOKEN is not set; tokens cannot be written to ManyChat.');
    return 1;
  }

  // A separate process, so its own instance, with the server's options.
  const client = manychatClientFor(env);
  const result = await backfillContactTokens(db, new ContactTokens(db, client), scope);
  console.log(`tokens written: ${result.written}`);
  console.log(`tokens queued for the outbox worker to retry: ${result.queued}`);
  return 0;
}

run().then(
  code => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
