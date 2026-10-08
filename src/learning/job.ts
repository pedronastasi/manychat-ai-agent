import type { Database } from '../db/client.ts';
import type { TenantConfig } from '../config/loader.ts';
import type { ContactReader } from '../channels/manychat/client.ts';
import type { RunStatus } from '../contracts/learning.ts';
import { funnelField } from '../agent/tools.ts';
import { NO_TOOLS } from '../contracts/config.ts';
import { findCohort, labelCohort, transcriptTurns } from './cohort.ts';
import type { LabelledContact } from './cohort.ts';
import { fitToBudget, MAX_PER_SIDE, MIN_PER_SIDE, renderTranscript } from './analyst.ts';
import type { Analyst } from './analyst.ts';
import { acceptProposals } from './proposals.ts';
import { isoWeek, LearningStore } from './store.ts';

/** How often each process checks whether this week's run is still to claim. */
export const LEARNING_CHECK_MS = 3_600_000;

export interface LearningLogger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

export interface LearningJobOptions {
  db: Database;
  tenantId: string;
  /** Read per run, so a SIGHUP reload reaches it. */
  config: () => TenantConfig;
  contacts: ContactReader;
  /** Undefined when INSIGHT_MODEL is unset: the job does not run. */
  analyst: Analyst | undefined;
  logger: LearningLogger;
  /** Paces the tag reads; replaced by tests. */
  pace?: (ms: number) => Promise<void>;
}

export type RunOutcome =
  | { status: 'disabled' | 'claimed' }
  | {
      status: RunStatus;
      runId: string;
      converted?: number | undefined;
      notConverted?: number | undefined;
    };

/**
 * One run of the learning job (specs/031): claim the week, read the cohort's
 * outcomes, price the worst case, ask the analyst, keep the proposals that
 * pass the refusals. Every run ends in one recorded status. Logs carry the run
 * id, counts and statuses, never transcript or proposal text (C5).
 */
export class LearningJob {
  private readonly opts: LearningJobOptions;
  private readonly store: LearningStore;

  constructor(opts: LearningJobOptions) {
    this.opts = opts;
    this.store = new LearningStore(opts.db);
  }

  async run(
    now = new Date(),
    options: { forced?: boolean; signal?: AbortSignal } = {},
  ): Promise<RunOutcome> {
    const { rules, tools = NO_TOOLS } = this.opts.config();
    const learning = rules.learning;
    const funnel = funnelField(tools);
    const analyst = this.opts.analyst;
    if (!learning || !funnel || !analyst) return { status: 'disabled' };

    const forced = options.forced ?? false;
    const runId = await this.store.claimRun(this.opts.tenantId, isoWeek(now), forced);
    if (!runId) return { status: 'claimed' };
    const log = (fields: object, message: string) =>
      this.opts.logger.info({ run: runId, forced, ...fields }, message);
    log({}, 'learning run started');

    const finish = async (
      status: RunStatus,
      counts: { converted?: number; notConverted?: number; costUsd?: number } = {},
    ): Promise<RunOutcome> => {
      await this.store.finishRun(runId, { status, ...counts });
      log({ status, ...counts }, 'learning run finished');
      // The row is the week's claim, so a stopped run forfeits the week
      // rather than leave it for another replica (specs/031).
      if (status === 'failed' && options.signal?.aborted) {
        this.opts.logger.warn(
          { run: runId, forced },
          'learning run stopped by shutdown; this week has no run until insights:run --force',
        );
      }
      return { status, runId, converted: counts.converted, notConverted: counts.notConverted };
    };

    try {
      const cohort = await findCohort(this.opts.db, this.opts.tenantId, funnel.id, now);
      const { labelled, dropped } = await labelCohort(
        cohort,
        this.opts.contacts,
        learning.convertedTag,
        this.opts.pace,
        options.signal,
      );
      const side = (label: LabelledContact['label']) =>
        labelled.filter(contact => contact.label === label);
      const convertedContacts = side('converted');
      const notConvertedContacts = side('not_converted');
      const counts = {
        converted: convertedContacts.length,
        notConverted: notConvertedContacts.length,
      };
      if (dropped > 0) log({ dropped }, 'learning run dropped contacts whose read failed');
      if (counts.converted < MIN_PER_SIDE || counts.notConverted < MIN_PER_SIDE) {
        return await finish('insufficient', counts);
      }

      // Newest first, as findCohort orders them.
      const chosen = [
        ...convertedContacts.slice(0, MAX_PER_SIDE),
        ...notConvertedContacts.slice(0, MAX_PER_SIDE),
      ];
      const turns = await transcriptTurns(
        this.opts.db,
        chosen.map(contact => contact.conversationId),
        now,
      );
      const transcriptsOf = (contacts: LabelledContact[]) =>
        contacts
          .slice(0, MAX_PER_SIDE)
          .map(contact => renderTranscript(contact.label, turns.get(contact.conversationId) ?? []));

      const active = await this.store.activeVersion(this.opts.tenantId);
      const input = fitToBudget(
        analyst.spec,
        {
          language: learning.language,
          playbook: active?.insights ?? [],
          rejected: await this.store.rejectedTexts(this.opts.tenantId),
          converted: transcriptsOf(convertedContacts),
          notConverted: transcriptsOf(notConvertedContacts),
        },
        learning.maxRunCostUsd,
      );
      if (!input) return await finish('skipped_budget', counts);

      // The run's cost is its own: it never reaches budget_counters, so no
      // run moves a live turn closer to the daily cap.
      const result = await analyst.propose(input, options.signal);
      if (!result.output) {
        this.opts.logger.warn(
          { run: runId, error: result.error ?? 'unknown' },
          'learning run failed: the analyst gave no valid answer',
        );
        return await finish('failed', { ...counts, costUsd: result.costUsd });
      }

      const known = new Set(
        [...input.converted, ...input.notConverted].flatMap(transcript => transcript.turnIds),
      );
      const { accepted, refused, dropped: over } = acceptProposals(result.output.proposals, known);
      await this.store.addProposals(this.opts.tenantId, runId, accepted);
      log({ proposals: accepted.length, refused, overCap: over }, 'learning run proposals');
      return await finish('completed', { ...counts, costUsd: result.costUsd });
    } catch (error) {
      this.opts.logger.error(
        { run: runId, err: error instanceof Error ? error.name : 'unknown' },
        'learning run failed',
      );
      return finish('failed');
    }
  }

  /**
   * Checks every `LEARNING_CHECK_MS` whether this week's run is still to
   * claim, and runs it if so. The claim, not the timer, makes it weekly and
   * on one replica. Returns a stop function that aborts a run in flight and
   * waits for it to record `failed`: a run left to finish could outlast the
   * process's grace period and stay `running`, its week claimed, for good.
   */
  start(intervalMs = LEARNING_CHECK_MS): () => Promise<void> {
    const stopping = new AbortController();
    let inFlight: Promise<unknown> = Promise.resolve();
    const tick = () => {
      inFlight = this.run(new Date(), { signal: stopping.signal }).catch((error: unknown) => {
        this.opts.logger.error(
          { err: error instanceof Error ? error.name : 'unknown' },
          'learning check failed',
        );
      });
    };
    const timer = setInterval(tick, intervalMs);
    timer.unref();
    return async () => {
      clearInterval(timer);
      stopping.abort();
      await inFlight;
    };
  }
}
