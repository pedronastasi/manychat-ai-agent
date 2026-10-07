import type { EvalRecord, PlaybookVersion } from './store.ts';

/** The hash a record without `PLAYBOOK_VERSION` carries: the prompt with no playbook. */
export const NO_PLAYBOOK = '';

/** The mock model ignores the prompt, so its pass says nothing about a playbook. */
export function isRealModel(model: string): boolean {
  return !model.startsWith('mock:');
}

export type GateDecision =
  { ok: true; reason: 'rollback' | 'no_regression' } | { ok: false; reason: string };

/** The newest real-model record for `hash` against `suiteHash`. */
function latest(records: readonly EvalRecord[], hash: string, suiteHash: string) {
  return records.find(
    record =>
      record.playbookHash === hash && record.suiteHash === suiteHash && isRealModel(record.model),
  );
}

/**
 * Whether `candidate` may go live (specs/031 § A version goes live only after
 * a real-model eval shows no regression). Pure: the caller reads the records
 * for the candidate and its baseline, and the current suite's hash.
 */
export function activationGate(input: {
  candidate: PlaybookVersion;
  active: PlaybookVersion | undefined;
  suiteHash: string;
  records: readonly EvalRecord[];
}): GateDecision {
  const { candidate, active, suiteHash, records } = input;
  if (candidate.active) return { ok: false, reason: 'that version is already active' };
  // Once live, always a valid rollback target: a bad playbook comes off in
  // one command, without paying for an eval first.
  if (candidate.activatedAt) return { ok: true, reason: 'rollback' };

  const ownRecords = records.filter(record => record.playbookHash === candidate.contentHash);
  const own = latest(records, candidate.contentHash, suiteHash);
  if (!own) {
    if (ownRecords.length === 0) {
      return {
        ok: false,
        reason: `no eval record for this version: run PLAYBOOK_VERSION=${candidate.id} pnpm eval`,
      };
    }
    if (ownRecords.every(record => !isRealModel(record.model))) {
      return {
        ok: false,
        reason:
          'only a mock-model eval record exists for this version, and the mock ignores the ' +
          `prompt: run PLAYBOOK_VERSION=${candidate.id} pnpm eval with a real model`,
      };
    }
    return {
      ok: false,
      reason:
        'no real-model eval record for this version against the current suite: run ' +
        `PLAYBOOK_VERSION=${candidate.id} pnpm eval`,
    };
  }

  const baselineHash = active?.contentHash ?? NO_PLAYBOOK;
  const baseline = latest(records, baselineHash, suiteHash);
  if (!baseline) {
    const run = active ? `PLAYBOOK_VERSION=${active.id} pnpm eval` : 'pnpm eval';
    const what = active ? `the active version ${active.id}` : 'the prompt with no playbook';
    return {
      ok: false,
      reason: `no real-model eval record for ${what} against the current suite, the baseline: run ${run}`,
    };
  }

  // A case that also fails under the baseline is not this version's.
  const regressions = Object.entries(own.outcomes)
    .filter(([id, status]) => status === 'failed' && baseline.outcomes[id] !== 'failed')
    .map(([id]) => id);
  if (regressions.length > 0) {
    return {
      ok: false,
      reason: `asserted cases fail that pass under the baseline: ${regressions.join(', ')}`,
    };
  }
  return { ok: true, reason: 'no_regression' };
}
