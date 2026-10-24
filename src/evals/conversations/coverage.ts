import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import type { Catalog, Rules, Tools } from '../../contracts/config.ts';
import { NO_TOOLS } from '../../contracts/config.ts';
import type {
  BranchInventory,
  FrameworkSource,
  ManifestSource,
  Scenario,
  SourceRef,
  Witness,
} from '../../contracts/conversations.ts';
import { buildSystemPrompt } from '../../agent/prompt.ts';
import { buildTools } from '../../agent/tools/build.ts';
import { ActionStage } from '../../agent/tools/stage.ts';
import { ContactReads } from '../../agent/contact.ts';
import { FlowSends } from '../../agent/flows.ts';
import type { RepetitionRun } from './harness.ts';
import type { AssertContext } from './assert.ts';
import { checkStepKeys } from './assert.ts';

/**
 * Branch coverage of an authored inventory (specs/043 § Branch coverage
 * requires an executed witness): which sources it was reconciled against,
 * whether they still say the same, and which branches a passing step reached
 * in both repetitions.
 */

export const BRANCHES_FILE = 'branches.json';

const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

export interface SourceTenant {
  /** `CONFIG_DIR`: a tenant source's path is relative to it. */
  configDir: string;
  catalog: Catalog;
  rules: Rules;
  tools?: Tools | undefined;
}

/** How a manifest entry or a branch's `file` names a source. */
export function sourceName(source: ManifestSource): string {
  return 'path' in source ? source.path : `framework:${source.framework}`;
}

/** A tenant path that stays inside `CONFIG_DIR`, or undefined. */
function tenantFile(configDir: string, path: string): string | undefined {
  const relative = normalize(path);
  if (isAbsolute(relative) || relative.startsWith('..')) return undefined;
  return join(configDir, relative);
}

/**
 * The framework's part as this tenant renders it, without the tenant's own
 * words: the prompt's rules with no persona and no section overrides, and
 * the tool descriptions the model is offered on an inbound turn. A framework upgrade that
 * rewords either makes the inventory stale.
 */
export function frameworkText(source: FrameworkSource, tenant: SourceTenant): string {
  const tools = tenant.tools ?? NO_TOOLS;
  if (source === 'operating-rules') {
    return buildSystemPrompt('', tenant.catalog, tenant.rules, tools).staticPrefix;
  }
  // Built as an inbound turn builds them (src/agent/runner.ts): with contact
  // reads, which add `get_contact`, and with flow sends, which word
  // `send_flow` as sent now. Only their presence changes the text, so
  // neither is ever called. A loaded plugin is refused before a run.
  const quiet = { warn: () => {} };
  const reads = new ContactReads({
    reader: { readContact: () => Promise.reject(new Error('never read')) },
    subscriberId: 'eval',
    logger: quiet,
  });
  const flows = new FlowSends({
    performer: { performAction: () => Promise.resolve() },
    subscriberId: 'eval',
    logger: quiet,
    tools,
  });
  const built = buildTools(tools, new ActionStage(), undefined, reads, { flows }) ?? {};
  return Object.entries(built)
    .map(
      ([name, tool]) => `${name}\n${typeof tool.description === 'string' ? tool.description : ''}`,
    )
    .join('\n\n');
}

/** The source's hash now, or undefined when the file does not exist. */
export function currentHash(source: ManifestSource, tenant: SourceTenant): string | undefined {
  if ('framework' in source) return sha256(frameworkText(source.framework, tenant));
  const file = tenantFile(tenant.configDir, source.path);
  return file && existsSync(file) ? sha256(readFileSync(file)) : undefined;
}

export interface StaleSource {
  source: string;
  recorded: string;
  /** Null when the file is gone. */
  current: string | null;
}

/** Every manifest source whose content changed since the inventory was reconciled. */
export function staleSources(inventory: BranchInventory, tenant: SourceTenant): StaleSource[] {
  return inventory.sources.flatMap(source => {
    const current = currentHash(source, tenant);
    return current === source.sha256
      ? []
      : [{ source: sourceName(source), recorded: source.sha256, current: current ?? null }];
  });
}

/**
 * The inventory's own consistency, and its references to the suite's
 * scenarios, steps and assertions. Empty means it may be used.
 */
export function validateInventory(
  inventory: BranchInventory,
  scenarios: readonly Scenario[],
  tenant: SourceTenant,
): string[] {
  const errors: string[] = [];
  const names = new Set<string>();
  for (const source of inventory.sources) {
    const name = sourceName(source);
    if (names.has(name)) errors.push(`${BRANCHES_FILE}: source ${name} is listed twice`);
    names.add(name);
    if ('path' in source && !tenantFile(tenant.configDir, source.path)) {
      errors.push(`${BRANCHES_FILE}: source ${name} is outside CONFIG_DIR`);
    }
  }
  const checkRef = (where: string, ref: SourceRef) => {
    if (!names.has(ref.file)) errors.push(`${where}: source ${ref.file} is not in the manifest`);
  };
  const byId = new Map(scenarios.map(scenario => [scenario.id, scenario]));
  const ids = new Set<string>();
  for (const branch of inventory.branches) {
    const where = `${BRANCHES_FILE}: branch ${branch.id}`;
    if (ids.has(branch.id)) errors.push(`${where}: duplicate branch id`);
    ids.add(branch.id);
    checkRef(where, branch.source);
    for (const ref of branch.conflict?.sources ?? []) checkRef(where, ref);
    for (const id of branch.scenarios) {
      if (!byId.has(id)) errors.push(`${where}: scenario ${id} is not in the suite`);
    }
  }
  const branches = new Map(inventory.branches.map(branch => [branch.id, branch]));
  for (const scenario of scenarios) {
    for (const step of scenario.steps) {
      for (const witness of step.expect.witnesses ?? []) {
        const where = `scenario ${scenario.id} step ${step.id} witness ${witness.branch}`;
        const branch = branches.get(witness.branch);
        if (!branch) {
          errors.push(`${where}: no such branch in ${BRANCHES_FILE}`);
          continue;
        }
        if (!branch.scenarios.includes(scenario.id)) {
          errors.push(`${where}: the branch does not list this scenario`);
        }
        for (const key of witness.assertions) {
          if (step.expect[key] === undefined) {
            errors.push(`${where}: the step declares no ${key} assertion`);
          }
        }
        for (const index of witness.criteria) {
          if (index >= (step.review?.length ?? 0)) {
            errors.push(`${where}: the step has no review criterion ${index}`);
          }
        }
      }
    }
  }
  return errors;
}

/**
 * Where a branch stands. `verified` needs a witness that ran and passed in
 * both repetitions; `unreviewed` passed its assertions but cites a criterion
 * no one has graded; `stale` and `conflicted` never turn green until the
 * inventory is reconciled.
 */
export type BranchStatus =
  'verified' | 'failed' | 'unreviewed' | 'not_reached' | 'stale' | 'conflicted';

type WitnessVerdict = 'passed' | 'failed' | 'unreviewed' | 'not_reached';

export interface BranchCoverage {
  id: string;
  status: BranchStatus;
  /** A witness step ran in at least one repetition. */
  attempted: boolean;
  witnesses: { scenario: string; step: string; repetitions: WitnessVerdict[] }[];
  /** A conflicted branch's competing sources, and the scenarios it affects. */
  conflict?: { sources: SourceRef[]; note: string; scenarios: string[] } | undefined;
}

export interface Coverage {
  /** No `branches.json`: coverage cannot be complete. */
  inventory: boolean;
  stale: StaleSource[];
  branches: BranchCoverage[];
  /** Each count names its denominator: `declared`. */
  counts: Record<'declared' | 'attempted' | BranchStatus, number>;
  /** Every branch verified and every source current. */
  complete: boolean;
}

/** One repetition's verdict on one witness. */
function witnessVerdict(
  scenario: Scenario,
  stepId: string,
  witness: Witness,
  run: RepetitionRun,
  ctx: AssertContext,
): WitnessVerdict {
  const record = run.steps.find(step => step.id === stepId);
  const step = scenario.steps.find(entry => entry.id === stepId);
  if (!record || !step) return 'not_reached';
  if (record.executionError !== undefined) return 'failed';
  const keys = checkStepKeys(step, record, run.deliveries, ctx);
  if (witness.assertions.some(key => (keys.get(key) ?? []).length > 0)) return 'failed';
  // No judge grades a criterion yet, so one cited leaves the witness unreviewed.
  return witness.criteria.length > 0 ? 'unreviewed' : 'passed';
}

const RANK: Record<WitnessVerdict, number> = {
  passed: 0,
  unreviewed: 1,
  failed: 2,
  not_reached: 3,
};

/**
 * Coverage of the inventory by a run. `runs` holds each scenario's
 * repetitions; a scenario that did not run has none, and its witnesses are
 * not reached. Seeded state is never a witness: only a step that ran is.
 */
export function coverageOf(
  inventory: BranchInventory | undefined,
  scenarios: readonly Scenario[],
  runs: ReadonlyMap<string, readonly RepetitionRun[]>,
  stale: readonly StaleSource[],
  ctx: AssertContext,
): Coverage {
  const counts: Coverage['counts'] = {
    declared: 0,
    attempted: 0,
    verified: 0,
    failed: 0,
    unreviewed: 0,
    not_reached: 0,
    stale: 0,
    conflicted: 0,
  };
  if (!inventory) return { inventory: false, stale: [], branches: [], counts, complete: false };
  const staleNames = new Set(stale.map(entry => entry.source));

  const branches = inventory.branches.map((branch): BranchCoverage => {
    const witnesses: BranchCoverage['witnesses'] = [];
    for (const scenario of scenarios) {
      if (!branch.scenarios.includes(scenario.id)) continue;
      for (const step of scenario.steps) {
        for (const witness of step.expect.witnesses ?? []) {
          if (witness.branch !== branch.id) continue;
          const repetitions = (runs.get(scenario.id) ?? []).map(run =>
            witnessVerdict(scenario, step.id, witness, run, ctx),
          );
          witnesses.push({ scenario: scenario.id, step: step.id, repetitions });
        }
      }
    }
    // A witness counts only when it ran in two repetitions and passed in both.
    const verdicts = witnesses.map(witness =>
      witness.repetitions.length < 2
        ? 'not_reached'
        : witness.repetitions.reduce<WitnessVerdict>(
            (worst, verdict) => (RANK[verdict] > RANK[worst] ? verdict : worst),
            'passed',
          ),
    );
    const attempted = witnesses.some(witness =>
      witness.repetitions.some(verdict => verdict !== 'not_reached'),
    );
    let status: BranchStatus;
    if (branch.conflict) status = 'conflicted';
    else if (staleNames.has(branch.source.file)) status = 'stale';
    else if (verdicts.includes('passed')) status = 'verified';
    else if (verdicts.includes('failed')) status = 'failed';
    else if (verdicts.includes('unreviewed')) status = 'unreviewed';
    else status = 'not_reached';
    return {
      id: branch.id,
      status,
      attempted,
      witnesses,
      conflict: branch.conflict && {
        ...branch.conflict,
        scenarios: branch.scenarios,
      },
    };
  });

  for (const branch of branches) {
    counts.declared++;
    if (branch.attempted) counts.attempted++;
    counts[branch.status]++;
  }
  return {
    inventory: true,
    stale: [...stale],
    branches,
    counts,
    complete: stale.length === 0 && branches.every(branch => branch.status === 'verified'),
  };
}
