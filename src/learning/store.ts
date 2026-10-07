import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { evalRecords, insightProposals, learningRuns, playbookVersions } from '../db/schema.ts';
import type { AnalystProposal, RunStatus } from '../contracts/learning.ts';
import { playbookHash, playbookRefusal } from './playbook.ts';
import type { ActivePlaybook, PlaybookReader } from './playbook.ts';
import { insightRefusal } from './proposals.ts';

/** How many rejected proposals the analyst is told not to propose again. */
export const REJECTED_SHOWN = 20;

export type CaseStatus = 'passed' | 'failed' | 'reviewed';

export interface PlaybookVersion extends ActivePlaybook {
  active: boolean;
  activatedAt: Date | null;
  createdAt: Date;
}

export interface EvalRecord {
  playbookHash: string;
  suiteHash: string;
  model: string;
  outcomes: Record<string, CaseStatus>;
  createdAt: Date;
}

export interface PendingProposal {
  id: string;
  text: string;
  rationale: string;
  enrolledCount: number;
  notEnrolledCount: number;
  turnIds: string[];
}

/** A change a reviewer asked for that the rules refuse. */
export class ReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewError';
  }
}

/** The ISO week a date falls in, as `2026-W41`: the key of the weekly claim. */
export function isoWeek(date: Date): string {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Thursday decides the week's year (ISO 8601).
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((day.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function toVersion(row: typeof playbookVersions.$inferSelect): PlaybookVersion {
  return {
    id: row.id,
    contentHash: row.contentHash,
    insights: row.insights,
    active: row.active,
    activatedAt: row.activatedAt,
    createdAt: row.createdAt,
  };
}

/**
 * Runs, proposals, playbook versions and eval records, each scoped to its
 * tenant (specs/031). A lesson learned from one tenant's contacts is never
 * read for another's.
 */
export class LearningStore implements PlaybookReader {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /* ---------------------------------------------------------------- runs */

  /**
   * Claims this week's run. The unique index decides: the replica whose
   * insert succeeds gets the id, and every other gets undefined. A forced run
   * is outside the index, and recorded as forced.
   */
  async claimRun(tenantId: string, week: string, forced = false): Promise<string | undefined> {
    const rows = await this.db
      .insert(learningRuns)
      .values({ tenantId, week, forced })
      .onConflictDoNothing()
      .returning({ id: learningRuns.id });
    return rows[0]?.id;
  }

  async finishRun(
    runId: string,
    result: {
      status: RunStatus;
      enrolled?: number;
      notEnrolled?: number;
      costUsd?: number;
    },
  ): Promise<void> {
    await this.db
      .update(learningRuns)
      .set({
        status: result.status,
        enrolledCount: result.enrolled ?? null,
        notEnrolledCount: result.notEnrolled ?? null,
        costUsd: result.costUsd !== undefined ? result.costUsd.toFixed(6) : null,
        finishedAt: new Date(),
      })
      .where(eq(learningRuns.id, runId));
  }

  async run(runId: string) {
    const [row] = await this.db.select().from(learningRuns).where(eq(learningRuns.id, runId));
    return row;
  }

  /* ----------------------------------------------------------- proposals */

  async addProposals(tenantId: string, runId: string, proposals: readonly AnalystProposal[]) {
    if (proposals.length === 0) return;
    await this.db.insert(insightProposals).values(
      proposals.map(proposal => ({
        tenantId,
        runId,
        text: proposal.text,
        rationale: proposal.rationale,
        enrolledCount: proposal.enrolledCount,
        notEnrolledCount: proposal.notEnrolledCount,
        turnIds: proposal.turnIds,
      })),
    );
  }

  async pendingProposals(tenantId: string): Promise<PendingProposal[]> {
    return this.db
      .select({
        id: insightProposals.id,
        text: insightProposals.text,
        rationale: insightProposals.rationale,
        enrolledCount: insightProposals.enrolledCount,
        notEnrolledCount: insightProposals.notEnrolledCount,
        turnIds: insightProposals.turnIds,
      })
      .from(insightProposals)
      .where(and(eq(insightProposals.tenantId, tenantId), eq(insightProposals.status, 'pending')))
      .orderBy(insightProposals.createdAt);
  }

  /** The texts the analyst is told not to propose again, newest first. */
  async rejectedTexts(tenantId: string, limit = REJECTED_SHOWN): Promise<string[]> {
    const rows = await this.db
      .select({ text: insightProposals.text })
      .from(insightProposals)
      .where(and(eq(insightProposals.tenantId, tenantId), eq(insightProposals.status, 'rejected')))
      .orderBy(desc(insightProposals.reviewedAt))
      .limit(limit);
    return rows.map(row => row.text);
  }

  async reject(tenantId: string, proposalId: string): Promise<void> {
    await this.pending(tenantId, proposalId);
    await this.db
      .update(insightProposals)
      .set({ status: 'rejected', reviewedAt: new Date() })
      .where(eq(insightProposals.id, proposalId));
  }

  /**
   * Approves a proposal, as written or with `edited` text, and creates the
   * version that adds it. Edited text passes the analyst's refusals. The new
   * version is not active: activation is its own step, behind the eval gate.
   */
  async approve(tenantId: string, proposalId: string, edited?: string): Promise<PlaybookVersion> {
    const proposal = await this.pending(tenantId, proposalId);
    const text = edited ?? proposal.text;
    const refused = insightRefusal(text);
    if (refused) throw new ReviewError(`not approved: ${refused}`);
    const base = await this.reviewBase(tenantId);
    const version = await this.createVersion(tenantId, [...(base?.insights ?? []), text]);
    await this.db
      .update(insightProposals)
      .set({ status: 'approved', text, reviewedAt: new Date() })
      .where(eq(insightProposals.id, proposalId));
    return version;
  }

  /** Creates the version without the insight at `index` of the review base. */
  async retire(tenantId: string, index: number): Promise<PlaybookVersion> {
    const base = await this.reviewBase(tenantId);
    if (!base || index < 0 || index >= base.insights.length) {
      throw new ReviewError(`no insight ${index + 1} in the playbook`);
    }
    return this.createVersion(
      tenantId,
      base.insights.filter((_insight, at) => at !== index),
    );
  }

  private async pending(tenantId: string, proposalId: string) {
    const [row] = await this.db
      .select()
      .from(insightProposals)
      .where(and(eq(insightProposals.tenantId, tenantId), eq(insightProposals.id, proposalId)));
    if (!row || row.status !== 'pending') throw new ReviewError('no such pending proposal');
    return row;
  }

  /* ------------------------------------------------------------ versions */

  /**
   * What a review changes: the newest version created since the active one
   * was activated, so several approvals in one review build one candidate;
   * otherwise the active version.
   */
  async reviewBase(tenantId: string): Promise<PlaybookVersion | undefined> {
    const active = await this.activeVersion(tenantId);
    const [newest] = await this.db
      .select()
      .from(playbookVersions)
      .where(eq(playbookVersions.tenantId, tenantId))
      .orderBy(desc(playbookVersions.createdAt))
      .limit(1);
    if (!newest) return undefined;
    const candidate = toVersion(newest);
    if (!active?.activatedAt) return candidate;
    return candidate.createdAt > active.activatedAt ? candidate : active;
  }

  /**
   * An immutable version. The same insights are the same version: creating
   * one that exists returns it. A version over the bounds is refused.
   */
  async createVersion(tenantId: string, insights: readonly string[]): Promise<PlaybookVersion> {
    const refused = playbookRefusal(insights);
    if (refused) throw new ReviewError(`not created: ${refused}`);
    const contentHash = playbookHash(insights);
    await this.db
      .insert(playbookVersions)
      .values({ tenantId, contentHash, insights: [...insights] })
      .onConflictDoNothing();
    const [row] = await this.db
      .select()
      .from(playbookVersions)
      .where(
        and(eq(playbookVersions.tenantId, tenantId), eq(playbookVersions.contentHash, contentHash)),
      );
    if (!row) throw new Error('createVersion: no row');
    return toVersion(row);
  }

  async versions(tenantId: string): Promise<PlaybookVersion[]> {
    const rows = await this.db
      .select()
      .from(playbookVersions)
      .where(eq(playbookVersions.tenantId, tenantId))
      .orderBy(playbookVersions.createdAt);
    return rows.map(toVersion);
  }

  /** A version by its id or a unique prefix of its id or content hash. */
  async findVersion(tenantId: string, ref: string): Promise<PlaybookVersion | undefined> {
    const matches = (await this.versions(tenantId)).filter(
      version => version.id.startsWith(ref) || version.contentHash.startsWith(ref),
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  async activeVersion(tenantId: string): Promise<PlaybookVersion | undefined> {
    const [row] = await this.db
      .select()
      .from(playbookVersions)
      .where(and(eq(playbookVersions.tenantId, tenantId), eq(playbookVersions.active, true)));
    return row ? toVersion(row) : undefined;
  }

  async activePlaybook(tenantId: string): Promise<ActivePlaybook | undefined> {
    const version = await this.activeVersion(tenantId);
    return version
      ? { id: version.id, contentHash: version.contentHash, insights: version.insights }
      : undefined;
  }

  /** Makes `versionId` the one active version. The gate is the caller's. */
  async activate(tenantId: string, versionId: string): Promise<void> {
    await this.db.transaction(async tx => {
      await tx
        .update(playbookVersions)
        .set({ active: false })
        .where(and(eq(playbookVersions.tenantId, tenantId), eq(playbookVersions.active, true)));
      await tx
        .update(playbookVersions)
        .set({ active: true, activatedAt: new Date() })
        .where(and(eq(playbookVersions.tenantId, tenantId), eq(playbookVersions.id, versionId)));
    });
  }

  /* --------------------------------------------------------- eval records */

  async recordEval(tenantId: string, record: Omit<EvalRecord, 'createdAt'>): Promise<void> {
    await this.db.insert(evalRecords).values({ tenantId, ...record });
  }

  /** Every record for a playbook against a suite, newest first. */
  async evalRecordsFor(tenantId: string, playbookHashes: readonly string[]): Promise<EvalRecord[]> {
    if (playbookHashes.length === 0) return [];
    return this.db
      .select({
        playbookHash: evalRecords.playbookHash,
        suiteHash: evalRecords.suiteHash,
        model: evalRecords.model,
        outcomes: evalRecords.outcomes,
        createdAt: evalRecords.createdAt,
      })
      .from(evalRecords)
      .where(
        and(
          eq(evalRecords.tenantId, tenantId),
          inArray(evalRecords.playbookHash, [...playbookHashes]),
        ),
      )
      .orderBy(desc(evalRecords.createdAt));
  }
}
