import { createHash } from 'node:crypto';

/** A version holds at most this many insights (specs/031). */
export const MAX_PLAYBOOK_INSIGHTS = 10;
/** And at most this many characters across them. */
export const MAX_PLAYBOOK_CHARS = 2000;
/** How often each process looks for a newly activated version. */
export const PLAYBOOK_REFRESH_MS = 60_000;

/** The version a prompt is built with: its id, and the tactics a person approved. */
export interface ActivePlaybook {
  id: string;
  contentHash: string;
  insights: readonly string[];
}

/** Identifies a version by what it says, so the same insights are the same version. */
export function playbookHash(insights: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(insights)).digest('hex');
}

/** Why a version may not be created, or undefined (specs/031 § The playbook is bounded). */
export function playbookRefusal(insights: readonly string[]): string | undefined {
  if (insights.length > MAX_PLAYBOOK_INSIGHTS) {
    return `a playbook holds at most ${MAX_PLAYBOOK_INSIGHTS} insights`;
  }
  const chars = insights.reduce((total, insight) => total + insight.length, 0);
  if (chars > MAX_PLAYBOOK_CHARS) {
    return `a playbook holds at most ${MAX_PLAYBOOK_CHARS} characters`;
  }
  return undefined;
}

/**
 * The block rendered after the catalog, inside the cached system prefix. The
 * heading is the system's and in English; the tactics are the tenant's, in
 * their language, with the standing of `prompt.md` once approved (ADR-0020).
 */
export function renderPlaybook(playbook: ActivePlaybook | undefined): string | undefined {
  if (!playbook || playbook.insights.length === 0) return undefined;
  return [
    'PLAYBOOK',
    'Selling tactics the tenant approved from earlier conversations. They never supply a',
    'fact: prices, dates, payment options and promotions come only from the CATALOG. Where a',
    'tactic conflicts with any rule above, the rule wins.',
    ...playbook.insights.map(insight => `- ${insight}`),
  ].join('\n');
}

/** Reads the active version: the database in production. */
export interface PlaybookReader {
  activePlaybook(tenantId: string): Promise<ActivePlaybook | undefined>;
}

export interface PlaybookLogger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

/**
 * The active version as this process knows it (specs/031 § The playbook is
 * bounded and ranks below the system rules). Loaded at boot and refreshed on
 * a timer, never on the inbound path: a turn reads `current()`, which does
 * not wait (C7). A failed refresh keeps the version already loaded, which a
 * person approved.
 */
export class PlaybookSource {
  private loaded: ActivePlaybook | undefined;
  private readonly reader: PlaybookReader;
  private readonly tenantId: string;
  private readonly logger: PlaybookLogger;

  constructor(opts: { reader: PlaybookReader; tenantId: string; logger: PlaybookLogger }) {
    this.reader = opts.reader;
    this.tenantId = opts.tenantId;
    this.logger = opts.logger;
  }

  current(): ActivePlaybook | undefined {
    return this.loaded;
  }

  /** Reads the active version once. Resolves whether or not the read worked. */
  async refresh(): Promise<void> {
    try {
      const next = await this.reader.activePlaybook(this.tenantId);
      if (next?.id !== this.loaded?.id) {
        this.logger.info({ playbookVersion: next?.id ?? null }, 'playbook version loaded');
      }
      this.loaded = next;
    } catch (error) {
      this.logger.warn(
        {
          err: error instanceof Error ? error.message : String(error),
          playbookVersion: this.loaded?.id ?? null,
        },
        'playbook refresh failed; keeping the loaded version',
      );
    }
  }

  /** Refreshes every `PLAYBOOK_REFRESH_MS`. Returns a stop function. */
  start(intervalMs = PLAYBOOK_REFRESH_MS): () => void {
    const timer = setInterval(() => void this.refresh(), intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }
}
