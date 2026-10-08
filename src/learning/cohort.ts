import { and, asc, eq, gte, inArray, isNotNull, max } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { conversations, turns } from '../db/schema.ts';
import type { ActionRecord } from '../contracts/agent.ts';
import { FUNNEL_STAGES } from '../contracts/config.ts';
import type { OutcomeLabel } from '../contracts/learning.ts';
import type { ContactReader } from '../channels/manychat/client.ts';

const DAY_MS = 86_400_000;
/** How far back an `offered` write puts a contact in the cohort (specs/031). */
export const COHORT_DAYS = 90;
/** How long a contact's last bound turn must be past: time to pay. */
export const SETTLE_DAYS = 14;
/** Below the limiter's burst, so a run never takes capacity from live turns. */
export const READ_INTERVAL_MS = 1_000;
/** As the nudge worker's tag read: no race here to protect. */
const READ_TIMEOUT_MS = 10_000;

/** The stages a cohort contact's funnel reached: offered, or later. */
const OFFERED_OR_LATER = new Set<string>(FUNNEL_STAGES.slice(FUNNEL_STAGES.indexOf('offered')));

/** Whether a turn's record holds a performed funnel write to offered or later. */
export function offeredOn(actions: readonly ActionRecord[] | null, funnelId: string): boolean {
  return (actions ?? []).some(
    action =>
      action.tool === 'set_field' &&
      action.id === funnelId &&
      action.status === 'performed' &&
      action.value !== undefined &&
      OFFERED_OR_LATER.has(action.value),
  );
}

export interface CohortContact {
  conversationId: string;
  subscriberId: string;
  /** The contact's latest bound turn: newer contacts are kept when a side is capped. */
  lastTurnAt: Date;
}

/**
 * The contacts a run may learn from (specs/031 § The cohort is contacts who
 * were offered, given time to pay): a funnel write to `offered` or later
 * performed in the past 90 days, and a latest bound turn at least 14 days old.
 * Newest first.
 */
export async function findCohort(
  db: Database,
  tenantId: string,
  funnelId: string,
  now: Date,
): Promise<CohortContact[]> {
  const since = new Date(now.getTime() - COHORT_DAYS * DAY_MS);
  const settled = new Date(now.getTime() - SETTLE_DAYS * DAY_MS);

  const recorded = await db
    .select({ conversationId: turns.conversationId, actions: turns.actions })
    .from(turns)
    .innerJoin(conversations, eq(conversations.id, turns.conversationId))
    .where(
      and(
        eq(conversations.tenantId, tenantId),
        eq(turns.role, 'agent'),
        isNotNull(turns.actions),
        gte(turns.createdAt, since),
      ),
    );
  const offered = [
    ...new Set(
      recorded.filter(row => offeredOn(row.actions, funnelId)).map(row => row.conversationId),
    ),
  ];
  if (offered.length === 0) return [];

  const latest = await db
    .select({
      conversationId: turns.conversationId,
      subscriberId: conversations.subscriberId,
      lastTurnAt: max(turns.createdAt),
    })
    .from(turns)
    .innerJoin(conversations, eq(conversations.id, turns.conversationId))
    .where(and(inArray(turns.conversationId, offered), eq(turns.bound, true)))
    .groupBy(turns.conversationId, conversations.subscriberId);

  return latest
    .filter((row): row is CohortContact => row.lastTurnAt !== null && row.lastTurnAt <= settled)
    .sort((first, second) => second.lastTurnAt.getTime() - first.lastTurnAt.getTime());
}

export interface LabelledContact extends CohortContact {
  label: OutcomeLabel;
}

/**
 * Reads each contact's tags and labels them by `convertedTag`. A read that
 * fails drops the contact: never labelled `not_converted` by default. Reads are
 * paced at one per `READ_INTERVAL_MS`.
 */
export async function labelCohort(
  cohort: readonly CohortContact[],
  reader: ContactReader,
  convertedTag: string,
  pace: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
  signal?: AbortSignal,
): Promise<{ labelled: LabelledContact[]; dropped: number }> {
  const labelled: LabelledContact[] = [];
  let dropped = 0;
  for (const [index, contact] of cohort.entries()) {
    if (index > 0) await pace(READ_INTERVAL_MS);
    // A stopping process ends the run here, not after a hundred more reads.
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(READ_TIMEOUT_MS);
    try {
      const record = await reader.readContact(
        contact.subscriberId,
        signal ? AbortSignal.any([timeout, signal]) : timeout,
      );
      labelled.push({
        ...contact,
        label: record.tags.includes(convertedTag) ? 'converted' : 'not_converted',
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      dropped += 1;
    }
  }
  return { labelled, dropped };
}

/** One bound turn as the analyst reads it, before cleaning. */
export interface TranscriptTurn {
  id: string;
  role: 'user' | 'agent';
  text: string;
  actions: ActionRecord[] | null;
}

/** Each contact's bound turns since the cohort window opened, in order. */
export async function transcriptTurns(
  db: Database,
  conversationIds: readonly string[],
  now: Date,
): Promise<Map<string, TranscriptTurn[]>> {
  const byConversation = new Map<string, TranscriptTurn[]>();
  if (conversationIds.length === 0) return byConversation;
  const since = new Date(now.getTime() - COHORT_DAYS * DAY_MS);
  const rows = await db
    .select({
      conversationId: turns.conversationId,
      id: turns.id,
      role: turns.role,
      text: turns.text,
      actions: turns.actions,
    })
    .from(turns)
    .where(
      and(
        inArray(turns.conversationId, [...conversationIds]),
        eq(turns.bound, true),
        gte(turns.createdAt, since),
      ),
    )
    .orderBy(asc(turns.seq));
  for (const row of rows) {
    const list = byConversation.get(row.conversationId) ?? [];
    list.push({ id: row.id, role: row.role, text: row.text, actions: row.actions });
    byConversation.set(row.conversationId, list);
  }
  return byConversation;
}
