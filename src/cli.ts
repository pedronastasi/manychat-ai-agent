#!/usr/bin/env node
import { loadEnv, loadTenantConfig, ConfigError, reservedNames } from './config/loader.ts';
import type { Database } from './db/client.ts';

const COMMANDS: Record<string, string> = {
  serve: 'Start the server (applies migrations at boot)',
  worker: 'Run the outbox and nudge workers',
  eval: 'Run the eval suite at EVAL_DIR against CONFIG_DIR',
  simulate: 'Send a Dynamic Block request to a running server',
  'config check': 'Validate config/ and environment, then exit',
  upgrade: 'Migrate config/ to the installed version',
  'tokens backfill': 'Issue contact tokens to existing contacts',
};

function usage(): never {
  const lines = ['Usage: agent <command>', ''];
  for (const [cmd, desc] of Object.entries(COMMANDS)) {
    lines.push(`  ${cmd.padEnd(18)} ${desc}`);
  }
  console.error(lines.join('\n'));
  process.exit(2);
}

function command(argv: string[]): string {
  const args = argv.slice(2);
  if (args.length === 0) usage();
  const two = args.slice(0, 2).join(' ');
  if (two in COMMANDS) return two;
  if (args[0]! in COMMANDS) return args[0]!;
  console.error(`Unknown command: ${args[0]}`);
  usage();
}

function restArgs(argv: string[], cmd: string): string[] {
  return argv.slice(2 + cmd.split(' ').length);
}

async function run() {
  const cmd = command(process.argv);
  const rest = restArgs(process.argv, cmd);

  switch (cmd) {
    case 'serve': {
      const { main } = await import('./main.ts');
      await main();
      break;
    }

    case 'worker': {
      const dbMod = await import('./db/client.ts');
      const { runMigrations } = await import('./db/migrate.ts');
      const { manychatClientFor } = await import('./channels/manychat/client.ts');
      const { OutboxWorker } = await import('./outbox/worker.ts');
      const { NudgeWorker } = await import('./nudge/worker.ts');
      const { GenerateTextRunner } = await import('./agent/runner.ts');
      const { resolveModel } = await import('./agent/registry.ts');
      const { ConfigStore } = await import('./config/loader.ts');

      const env = loadEnv();
      const configStore = new ConfigStore(process.env.CONFIG_DIR ?? 'config', reservedNames(env));

      let db: Database;
      if (dbMod.isEmbedded(env.DATABASE_URL)) {
        const embedded = await dbMod.createEmbeddedDatabase(env.DATABASE_URL);
        db = embedded.db as unknown as Database;
      } else {
        db = dbMod.createDatabase(env.DATABASE_URL);
      }

      const migrated = await runMigrations(db);
      if (migrated.length > 0) console.log(`migrations applied: ${migrated.join(', ')}`);

      const manychat = manychatClientFor(env);

      const runner = new GenerateTextRunner({
        model: resolveModel(env.AGENT_MODEL),
        modelSpec: env.AGENT_MODEL,
        config: () => configStore.get(),
        maxOutputTokens: env.AGENT_MAX_OUTPUT_TOKENS,
        temperature: env.AGENT_TEMPERATURE,
        reasoningEffort: env.AGENT_REASONING_EFFORT,
      });

      const logger = {
        info: (obj: object, msg: string) => console.log(msg, obj),
        warn: (obj: object, msg: string) => console.warn(msg, obj),
        error: (obj: object, msg: string) => console.error(msg, obj),
      };

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
        if (result.ok) console.log('config reloaded');
        else console.error(`config reload failed: ${result.error}`);
      });

      const shutdown = async (signal: string) => {
        console.log(`${signal} received, shutting down`);
        await stopNudges();
        await stopOutbox();
        process.exit(0);
      };
      process.on('SIGTERM', () => void shutdown('SIGTERM'));
      process.on('SIGINT', () => void shutdown('SIGINT'));
      break;
    }

    case 'eval': {
      const { runEval } = await import('./evals/runner.ts');
      await runEval();
      break;
    }

    case 'simulate': {
      process.argv = ['node', 'simulator', ...rest];
      await import('./channels/manychat/simulator.ts');
      break;
    }

    case 'config check': {
      const dir = process.env.CONFIG_DIR ?? 'config';
      try {
        const env = loadEnv();
        loadTenantConfig(dir, reservedNames(env));
        console.log(`config check passed (${dir})`);
      } catch (error) {
        if (error instanceof ConfigError) {
          console.error(error.message);
          process.exit(1);
        }
        throw error;
      }
      break;
    }

    case 'upgrade': {
      const { runMigrations: runConfigMigrations } = await import('./migrations/index.ts');
      const dir = process.env.CONFIG_DIR ?? 'config';
      const { applied, unchanged } = runConfigMigrations(dir);
      if (unchanged) {
        console.log('config is up to date');
      } else {
        console.log(`applied migrations: ${applied.join(', ')}`);
      }
      break;
    }

    case 'tokens backfill': {
      process.argv = ['node', 'backfill', ...rest];
      await import('./backfill.ts');
      break;
    }
  }
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
