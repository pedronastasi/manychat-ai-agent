/**
 * Process entrypoint: reads the environment, opens the database, applies
 * migrations, starts the worker and wires signal handling.
 *
 * Kept apart from server.ts so the composition root stays testable. Everything
 * here needs a real process - a listening socket, signal handlers, a live
 * database - which is why it is excluded from coverage rather than covered by
 * assertions that would only restate the wiring (specs/004-testing.md).
 */
import { loadEnv, ConfigStore, reservedNames } from './config/loader.ts';
import { createDatabase, createEmbeddedDatabase, isEmbedded } from './db/client.ts';
import type { Database } from './db/client.ts';
import { runMigrations } from './db/migrate.ts';
import { manychatClientFor } from './channels/manychat/client.ts';
import { OutboxWorker } from './outbox/worker.ts';
import { NudgeWorker } from './nudge/worker.ts';
import { buildServer } from './server.ts';
import { loadPlugins } from './plugins/loader.ts';
import { playbookSource, startLearning } from './learning/wiring.ts';

export async function main() {
  const env = loadEnv();
  // A tool aimed at the reply flow or field fails the boot, and a reload that
  // introduces one is refused (specs/012).
  const configDir = process.env.CONFIG_DIR ?? 'config';
  const configStore = new ConfigStore(configDir, reservedNames(env));
  // Code, loaded once: a plugin that does not load stops the boot (specs/036).
  const plugins = await loadPlugins(configDir);

  let db: Database;
  if (isEmbedded(env.DATABASE_URL)) {
    const embedded = await createEmbeddedDatabase(env.DATABASE_URL);
    db = embedded.db as unknown as Database;
  } else {
    db = createDatabase(env.DATABASE_URL);
  }

  // One client, and so one rate limiter, for the server and the worker alike:
  // one each would send at twice the configured rate (specs/022).
  const manychat = manychatClientFor(env);
  // Logs through the server's logger once it exists; nothing logs before.
  const logs = {
    info: (obj: object, msg: string) => app.log.info(obj, msg),
    warn: (obj: object, msg: string) => app.log.warn(obj, msg),
    error: (obj: object, msg: string) => app.log.error(obj, msg),
  };
  const playbook = playbookSource(db, env, configStore.get(), logs);
  const { app, runner } = await buildServer({
    env,
    db,
    configStore,
    manychat,
    contacts: manychat,
    plugins,
    playbook,
  });

  const migrated = await runMigrations(db);
  if (migrated.length > 0) app.log.info({ migrations: migrated }, 'migrations applied');

  const stopWorker = new OutboxWorker({
    db,
    client: manychat,
    logger: app.log,
    plugins,
  }).start();

  // Follow-ups the agent scheduled (specs/025). Idle for a tenant without a
  // `nudge` section: nothing schedules one.
  const stopNudges = new NudgeWorker({
    db,
    runner,
    config: () => configStore.get(),
    contacts: manychat,
    logger: app.log,
    modelAbortMs: env.MODEL_ABORT_MS,
  }).start();

  // The playbook and the weekly learning job (specs/031). Idle without a
  // `learning` block or INSIGHT_MODEL.
  const stopLearning = await startLearning({
    db,
    env,
    config: () => configStore.get(),
    contacts: manychat,
    logger: logs,
    playbook,
  });

  // Prompt edits dominate the first weeks; a restart per wording tweak is the
  // friction that ends with people editing prompts in production (specs/003).
  process.on('SIGHUP', () => {
    const result = configStore.reload();
    if (result.ok) app.log.info('config reloaded');
    else app.log.error({ error: result.error }, 'config reload failed; keeping previous config');
  });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await stopLearning();
    await stopNudges();
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
