import type { Env } from '../contracts/config.ts';
import type { Database } from '../db/client.ts';
import type { TenantConfig } from '../config/loader.ts';
import type { ContactReader } from '../channels/manychat/client.ts';
import { resolveModel } from '../agent/registry.ts';
import { Analyst } from './analyst.ts';
import { LearningJob } from './job.ts';
import type { LearningLogger } from './job.ts';
import { PlaybookSource } from './playbook.ts';
import { LearningStore } from './store.ts';

/**
 * The playbook a process's runner reads (specs/031). Undefined without a
 * `learning` block at boot: no playbook is loaded, and the prompt is what it
 * was before that spec.
 */
export function playbookSource(
  db: Database,
  env: Env,
  config: TenantConfig,
  logger: LearningLogger,
): PlaybookSource | undefined {
  if (!config.rules.learning) return undefined;
  return new PlaybookSource({ reader: new LearningStore(db), tenantId: env.TENANT_ID, logger });
}

/**
 * Loads the playbook, then starts its refresh and the weekly job. Called once
 * migrations are applied. The analyst is resolved here, at boot, so an
 * INSIGHT_MODEL typo fails the deploy rather than the first run. Returns a
 * stop function.
 */
export async function startLearning(opts: {
  db: Database;
  env: Env;
  config: () => TenantConfig;
  contacts: ContactReader;
  logger: LearningLogger;
  playbook: PlaybookSource | undefined;
}): Promise<() => Promise<void>> {
  const { env } = opts;
  if (opts.playbook) await opts.playbook.refresh();
  const stopRefresh = opts.playbook?.start();
  const analyst = env.INSIGHT_MODEL
    ? new Analyst({
        model: resolveModel(env.INSIGHT_MODEL, 'INSIGHT_MODEL'),
        modelSpec: env.INSIGHT_MODEL,
      })
    : undefined;
  const stopJob = new LearningJob({
    db: opts.db,
    tenantId: env.TENANT_ID,
    config: opts.config,
    contacts: opts.contacts,
    analyst,
    logger: opts.logger,
  }).start();
  return async () => {
    stopRefresh?.();
    await stopJob();
  };
}
