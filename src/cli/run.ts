import { loadEnv, loadTenantConfig, ConfigError, reservedNames } from '../config/loader.ts';
import type { Env } from '../contracts/config.ts';
import type { Database } from '../db/client.ts';

export const COMMANDS: Record<string, string> = {
  serve: 'Start the server (applies migrations at boot)',
  worker: 'Run the outbox and nudge workers',
  eval: 'Run the eval suite at EVAL_DIR against CONFIG_DIR',
  simulate: 'Send a Dynamic Block request to a running server',
  'config check': 'Validate config/ and environment, then exit',
  upgrade: 'Migrate config/ to the installed version',
  'tokens backfill': 'Issue contact tokens to existing contacts',
};

function usage(): number {
  const lines = ['Usage: agent <command>', ''];
  for (const [cmd, desc] of Object.entries(COMMANDS)) {
    lines.push(`  ${cmd.padEnd(18)} ${desc}`);
  }
  console.error(lines.join('\n'));
  return 2;
}

function command(args: string[]): string | undefined {
  const two = args.slice(0, 2).join(' ');
  if (two in COMMANDS) return two;
  if (args[0] !== undefined && args[0] in COMMANDS) return args[0];
  return undefined;
}

/** Every command fails closed on a config/ that `agent serve` would refuse (C6). */
function configIsValid(dir: string): boolean {
  // Checked apart, so a missing variable is not reported as a broken config/.
  let env: Env;
  try {
    env = loadEnv();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`invalid environment: ${error.message}`);
      return false;
    }
    throw error;
  }
  try {
    loadTenantConfig(dir, reservedNames(env));
    return true;
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`invalid config (${dir}): ${error.message}`);
      return false;
    }
    throw error;
  }
}

/**
 * Runs `agent <command>`. Resolves to the exit code, or to undefined for a
 * command that keeps the process alive or exits on its own terms.
 */
export async function run(argv: string[]): Promise<number | undefined> {
  const args = argv.slice(2);
  if (args.length === 0) return usage();
  const cmd = command(args);
  if (cmd === undefined) {
    console.error(`Unknown command: ${args[0]}`);
    return usage();
  }
  const rest = args.slice(cmd.split(' ').length);
  const configDir = process.env.CONFIG_DIR ?? 'config';

  // `upgrade` exists to rewrite a config the installed version cannot parse
  // yet, so it checks after migrating rather than before.
  if (cmd !== 'upgrade' && !configIsValid(configDir)) return 1;

  switch (cmd) {
    case 'serve': {
      const { main } = await import('../main.ts');
      await main();
      return undefined;
    }

    case 'worker': {
      await startWorkers(configDir);
      return undefined;
    }

    case 'eval': {
      const { runEval } = await import('../evals/runner.ts');
      await runEval();
      return undefined;
    }

    case 'simulate': {
      process.argv = ['node', 'simulator', ...rest];
      await import('../channels/manychat/simulator.ts');
      return undefined;
    }

    case 'config check': {
      console.log(`config check passed (${configDir})`);
      return 0;
    }

    case 'upgrade': {
      const { runMigrations: runConfigMigrations } = await import('../migrations/index.ts');
      const { applied, unchanged } = runConfigMigrations(configDir);
      console.log(unchanged ? 'config is up to date' : `applied migrations: ${applied.join(', ')}`);
      // A migration never invents tenant values; what it leaves out fails here.
      return configIsValid(configDir) ? 0 : 1;
    }

    case 'tokens backfill': {
      process.argv = ['node', 'backfill', ...rest];
      await import('../backfill.ts');
      return undefined;
    }
  }
  return usage();
}

/** The outbox and nudge workers without the HTTP server (specs/033). */
async function startWorkers(configDir: string) {
  const dbMod = await import('../db/client.ts');
  const { runMigrations } = await import('../db/migrate.ts');
  const { manychatClientFor } = await import('../channels/manychat/client.ts');
  const { OutboxWorker } = await import('../outbox/worker.ts');
  const { NudgeWorker } = await import('../nudge/worker.ts');
  const { GenerateTextRunner } = await import('../agent/runner.ts');
  const { resolveModel } = await import('../agent/registry.ts');
  const { ConfigStore } = await import('../config/loader.ts');
  const { createLogger } = await import('../observability/logger.ts');

  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);
  const configStore = new ConfigStore(configDir, reservedNames(env));

  let db: Database;
  if (dbMod.isEmbedded(env.DATABASE_URL)) {
    const embedded = await dbMod.createEmbeddedDatabase(env.DATABASE_URL);
    db = embedded.db as unknown as Database;
  } else {
    db = dbMod.createDatabase(env.DATABASE_URL);
  }

  const migrated = await runMigrations(db);
  if (migrated.length > 0) logger.info({ migrations: migrated }, 'migrations applied');

  const manychat = manychatClientFor(env);

  const runner = new GenerateTextRunner({
    model: resolveModel(env.AGENT_MODEL),
    modelSpec: env.AGENT_MODEL,
    config: () => configStore.get(),
    maxOutputTokens: env.AGENT_MAX_OUTPUT_TOKENS,
    temperature: env.AGENT_TEMPERATURE,
    reasoningEffort: env.AGENT_REASONING_EFFORT,
  });

  const stopOutbox = new OutboxWorker({ db, client: manychat, logger }).start();
  const stopNudges = new NudgeWorker({
    db,
    runner,
    config: () => configStore.get(),
    contacts: manychat,
    logger,
    modelAbortMs: env.MODEL_ABORT_MS,
  }).start();

  process.on('SIGHUP', () => {
    const result = configStore.reload();
    if (result.ok) logger.info('config reloaded');
    else logger.error({ error: result.error }, 'config reload failed; keeping previous config');
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    await stopNudges();
    await stopOutbox();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
