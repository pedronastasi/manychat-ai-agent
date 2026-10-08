import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { conversations, turns } from '../db/schema.ts';
import type { ContactReader } from '../channels/manychat/client.ts';
import type { TenantConfig } from '../config/loader.ts';
import { funnelField } from '../agent/tools.ts';
import { NO_TOOLS } from '../contracts/config.ts';
import { findCohort, labelCohort, offeredOn } from './cohort.ts';
import { activationGate } from './gate.ts';
import { LearningStore, ReviewError } from './store.ts';
import type { PlaybookVersion } from './store.ts';

/** Where a command reads answers and prints. A terminal, or a script in tests. */
export interface ReviewIo {
  print(line: string): void;
  ask(question: string): Promise<string>;
}

const short = (id: string) => id.slice(0, 8);

function printPlaybook(io: ReviewIo, title: string, version: PlaybookVersion | undefined) {
  io.print(`\n${title}${version ? ` (version ${short(version.id)})` : ''}`);
  if (!version || version.insights.length === 0) {
    io.print('  (empty)');
    return;
  }
  version.insights.forEach((insight, index) => io.print(`  ${index + 1}. ${insight}`));
}

/**
 * `insights:review` (specs/031 § Approval is what makes derived text an
 * instruction). Lists pending proposals with their cited turns, read from the
 * database to this terminal only, and approves, edits, rejects or skips each;
 * then offers to retire an insight. A version it creates is not active.
 */
export async function review(
  db: Database,
  tenantId: string,
  io: ReviewIo,
): Promise<{ approved: number; rejected: number; retired: number }> {
  const store = new LearningStore(db);
  const counts = { approved: 0, rejected: 0, retired: 0 };
  const pending = await store.pendingProposals(tenantId);
  io.print(`${pending.length} pending proposal(s)`);

  for (const proposal of pending) {
    io.print(`\nPROPOSAL ${short(proposal.id)}`);
    io.print(`  ${proposal.text}`);
    io.print(`  why: ${proposal.rationale}`);
    io.print(
      `  seen in ${proposal.convertedCount} converted and ${proposal.notConvertedCount} not converted ` +
        'transcripts, by the analyst’s count: check the turns below',
    );
    const cited = proposal.turnIds.length
      ? await db
          .select({ id: turns.id, role: turns.role, text: turns.text })
          .from(turns)
          .innerJoin(conversations, eq(conversations.id, turns.conversationId))
          .where(and(eq(conversations.tenantId, tenantId), inArray(turns.id, proposal.turnIds)))
          .orderBy(asc(turns.seq))
      : [];
    for (const turn of cited) io.print(`    [${short(turn.id)}] ${turn.role}: ${turn.text}`);

    for (;;) {
      const answer = (await io.ask('[a]pprove, [e]dit and approve, [r]eject, [s]kip? '))
        .trim()
        .toLowerCase();
      try {
        if (answer === 'a' || answer === 'e') {
          const edited = answer === 'e' ? (await io.ask('text: ')).trim() : undefined;
          const version = await store.approve(tenantId, proposal.id, edited);
          io.print(`approved; candidate version ${short(version.id)} (not active)`);
          counts.approved += 1;
        } else if (answer === 'r') {
          await store.reject(tenantId, proposal.id);
          io.print('rejected; the analyst will not propose it again');
          counts.rejected += 1;
        } else if (answer !== 's') {
          continue;
        }
        break;
      } catch (error) {
        if (!(error instanceof ReviewError)) throw error;
        io.print(error.message);
      }
    }
  }

  for (;;) {
    const base = await store.reviewBase(tenantId);
    printPlaybook(io, 'PLAYBOOK UNDER REVIEW', base);
    if (!base || base.insights.length === 0) break;
    const answer = (await io.ask('retire which insight? (number, or enter to finish) ')).trim();
    if (answer === '') break;
    try {
      const version = await store.retire(tenantId, Number(answer) - 1);
      io.print(`retired; candidate version ${short(version.id)} (not active)`);
      counts.retired += 1;
    } catch (error) {
      if (!(error instanceof ReviewError)) throw error;
      io.print(error.message);
    }
  }
  const candidate = await store.reviewBase(tenantId);
  const active = await store.activeVersion(tenantId);
  if (candidate && candidate.id !== active?.id) {
    io.print(
      `\nTo put version ${short(candidate.id)} live: PLAYBOOK_VERSION=${candidate.id} pnpm eval, ` +
        `then pnpm insights:activate ${candidate.id}`,
    );
  }
  return counts;
}

/**
 * `insights:activate <version>`: makes a version live once the gate allows
 * it. Returns the gate's reason, printed by the caller.
 */
export async function activate(
  db: Database,
  tenantId: string,
  ref: string,
  suiteHash: string,
): Promise<{ ok: boolean; message: string }> {
  const store = new LearningStore(db);
  const candidate = await store.findVersion(tenantId, ref);
  if (!candidate) return { ok: false, message: `no single playbook version matches ${ref}` };
  const active = await store.activeVersion(tenantId);
  const records = await store.evalRecordsFor(tenantId, [
    candidate.contentHash,
    active?.contentHash ?? '',
  ]);
  const decision = activationGate({ candidate, active, suiteHash, records });
  if (!decision.ok) return { ok: false, message: `refused: ${decision.reason}` };
  await store.activate(tenantId, candidate.id);
  const how = decision.reason === 'rollback' ? 'rolled back to' : 'activated';
  return {
    ok: true,
    message: `${how} version ${short(candidate.id)}; every process picks it up within a minute`,
  };
}

export interface VersionRate {
  version: string | null;
  contacts: number;
  converted: number;
}

/**
 * `insights:report` (specs/031 § Every turn records the playbook version it
 * ran with): per version, the conversion rate of contacts whose first `offered`
 * write was performed on a turn that ran with it, read with the cohort's
 * settle period and tag read.
 */
export async function report(
  db: Database,
  tenantId: string,
  config: TenantConfig,
  contacts: ContactReader,
  now = new Date(),
  pace?: (ms: number) => Promise<void>,
): Promise<VersionRate[]> {
  const funnel = funnelField(config.tools ?? NO_TOOLS);
  const learning = config.rules.learning;
  if (!funnel || !learning) return [];
  const cohort = await findCohort(db, tenantId, funnel.id, now);
  const { labelled } = await labelCohort(cohort, contacts, learning.convertedTag, pace);
  if (labelled.length === 0) return [];

  const rows = await db
    .select({
      conversationId: turns.conversationId,
      actions: turns.actions,
      playbookVersion: turns.playbookVersion,
    })
    .from(turns)
    .where(
      inArray(
        turns.conversationId,
        labelled.map(contact => contact.conversationId),
      ),
    )
    .orderBy(asc(turns.seq));
  const firstOffered = new Map<string, string | null>();
  for (const row of rows) {
    if (!firstOffered.has(row.conversationId) && offeredOn(row.actions, funnel.id)) {
      firstOffered.set(row.conversationId, row.playbookVersion);
    }
  }

  const rates = new Map<string | null, VersionRate>();
  for (const contact of labelled) {
    const version = firstOffered.get(contact.conversationId) ?? null;
    const rate = rates.get(version) ?? { version, contacts: 0, converted: 0 };
    rate.contacts += 1;
    if (contact.label === 'converted') rate.converted += 1;
    rates.set(version, rate);
  }
  return [...rates.values()];
}

/** The header the report opens with, so nobody reads it as a controlled test. */
export const REPORT_HEADER = [
  'Conversion rate by the playbook version a contact was first offered under.',
  'Before and after, not controlled: a version is credited with whatever else changed',
  'in the same weeks (an advert, a season, a price). Read beside the link-sent and',
  'conversion rates of specs/023, never combined with them.',
].join('\n');

export function formatReport(rates: readonly VersionRate[]): string[] {
  if (rates.length === 0) return ['No settled contacts were offered in the past 90 days.'];
  return rates.map(rate => {
    const percent = rate.contacts === 0 ? 0 : (100 * rate.converted) / rate.contacts;
    const label = rate.version ? `version ${short(rate.version)}` : 'no playbook';
    return `  ${label.padEnd(20)} ${rate.converted}/${rate.contacts} converted (${percent.toFixed(1)}%)`;
  });
}
