/**
 * Process entrypoint: reads the environment, opens the database, applies
 * migrations, starts the worker and wires signal handling.
 *
 * Kept apart from server.ts so the composition root stays testable. Everything
 * here needs a real process - a listening socket, signal handlers, a live
 * database - which is why it is excluded from coverage rather than covered by
 * assertions that would only restate the wiring (specs/004-testing.md).
 */
import { loadEnv, ConfigStore } from './config/loader.ts';
import { createDatabase, createEmbeddedDatabase, isEmbedded } from './db/client.ts';
import type { Database } from './db/client.ts';
import { runMigrations } from './db/migrate.ts';
import { ManyChatHttpClient } from './channels/manychat/client.ts';
import { OutboxWorker } from './outbox/worker.ts';
import { buildServer } from './server.ts';

export async function main() {
  const env = loadEnv();
  const configStore = new ConfigStore();

  let db: Database;
  if (isEmbedded(env.DATABASE_URL)) {
    const embedded = await createEmbeddedDatabase(env.DATABASE_URL);
    db = embedded.db as unknown as Database;
  } else {
    db = createDatabase(env.DATABASE_URL);
  }

  const { app, registerPlugins } = buildServer({ env, db, configStore });
  await registerPlugins();

  const migrated = await runMigrations(db);
  if (migrated.length > 0) app.log.info({ migrations: migrated }, 'migrations applied');

  const stopWorker = new OutboxWorker({
    db,
    client: new ManyChatHttpClient({
      apiToken: env.MANYCHAT_API_TOKEN ?? '',
      baseUrl: env.MANYCHAT_API_BASE,
      replyField: env.MANYCHAT_REPLY_FIELD,
      replyFlowNs: env.MANYCHAT_REPLY_FLOW_NS ?? '',
    }),
    logger: app.log,
  }).start();

  // Prompt edits dominate the first weeks; a restart per wording tweak is the
  // friction that ends with people editing prompts in production (specs/003).
  process.on('SIGHUP', () => {
    const result = configStore.reload();
    if (result.ok) app.log.info('config reloaded');
    else app.log.error({ error: result.error }, 'config reload failed; keeping previous config');
  });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await stopWorker();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

const isEntrypoint = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!);
if (isEntrypoint) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
