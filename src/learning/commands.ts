import { createInterface } from 'node:readline/promises';
import { loadEnv, loadTenantConfig, reservedNames } from '../config/loader.ts';
import { evalDir, suiteHash } from '../evals/cases.ts';
import { manychatClientFor } from '../channels/manychat/client.ts';
import { resolveModel } from '../agent/registry.ts';
import { openDatabase } from './database.ts';
import { Analyst } from './analyst.ts';
import { LearningJob } from './job.ts';
import type { LearningLogger } from './job.ts';
import { activate, formatReport, report, REPORT_HEADER, review } from './cli.ts';

export const INSIGHT_COMMANDS: Record<string, string> = {
  run: 'Run this week’s learning job now (--force for a second run)',
  review: 'Approve, edit, reject or retire playbook insights',
  activate: 'Put a playbook version live, once its eval shows no regression',
  report: 'Conversion rate by playbook version',
};

/**
 * What a run started from the CLI logs: its warnings and errors, on stderr,
 * so the cause of a `failed` run is printed where it was started. Each line
 * carries only ids, counts and error names (C5).
 */
export const cliLogger: LearningLogger = {
  info: () => {},
  warn: (fields: object, message: string) => console.error(`${message} ${JSON.stringify(fields)}`),
  error: (fields: object, message: string) => console.error(`${message} ${JSON.stringify(fields)}`),
};

/**
 * `agent insights <command>` and `pnpm insights:<command>` (specs/031). Runs
 * against the tenant `CONFIG_DIR` names and the database `DATABASE_URL` names.
 * Resolves to the exit code.
 */
export async function runInsights(args: readonly string[]): Promise<number> {
  const [command, ...rest] = args;
  if (command === undefined || !(command in INSIGHT_COMMANDS)) {
    console.error(
      [
        'Usage: insights <command>',
        ...Object.entries(INSIGHT_COMMANDS).map(([name, what]) => `  ${name.padEnd(10)} ${what}`),
      ].join('\n'),
    );
    return 2;
  }
  const env = loadEnv();
  const config = loadTenantConfig(process.env.CONFIG_DIR ?? 'config', reservedNames(env));
  if (!config.rules.learning) {
    console.error('rules.json has no "learning" block, so there is nothing to learn or review.');
    return 1;
  }
  const db = await openDatabase(env);
  const tenantId = env.TENANT_ID;

  switch (command) {
    case 'run': {
      if (!env.INSIGHT_MODEL) {
        console.error('INSIGHT_MODEL is unset, so the job does not run.');
        return 1;
      }
      const outcome = await new LearningJob({
        db,
        tenantId,
        config: () => config,
        contacts: manychatClientFor(env),
        analyst: new Analyst({
          model: resolveModel(env.INSIGHT_MODEL, 'INSIGHT_MODEL'),
          modelSpec: env.INSIGHT_MODEL,
        }),
        logger: cliLogger,
      }).run(new Date(), { forced: rest.includes('--force') });
      if (outcome.status === 'claimed') {
        console.log('This week’s run already happened. Pass --force to run another.');
        return 0;
      }
      console.log(`run ${'runId' in outcome ? outcome.runId : ''}: ${outcome.status}`);
      if ('converted' in outcome && outcome.converted !== undefined) {
        console.log(`  converted ${outcome.converted}, not converted ${outcome.notConverted ?? 0}`);
      }
      return outcome.status === 'failed' ? 1 : 0;
    }
    case 'review': {
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      try {
        await review(db, tenantId, {
          print: line => console.log(line),
          ask: question => terminal.question(question),
        });
      } finally {
        terminal.close();
      }
      return 0;
    }
    case 'activate': {
      const ref = rest[0];
      if (!ref) {
        console.error('Usage: insights activate <version>');
        return 2;
      }
      const result = await activate(db, tenantId, ref, suiteHash(evalDir()));
      (result.ok ? console.log : console.error)(result.message);
      return result.ok ? 0 : 1;
    }
    default: {
      console.log(REPORT_HEADER);
      const rates = await report(db, tenantId, config, manychatClientFor(env));
      for (const line of formatReport(rates)) console.log(line);
      return 0;
    }
  }
}
