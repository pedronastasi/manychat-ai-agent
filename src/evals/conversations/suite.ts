import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { BranchInventory, ChannelFixtures, Scenario } from '../../contracts/conversations.ts';
import type {
  ActionMatcher,
  ArtifactSelector,
  StateAssertion,
  TraceRef,
} from '../../contracts/conversations.ts';
import type { Catalog, Rules, Tools } from '../../contracts/config.ts';
import { NO_TOOLS } from '../../contracts/config.ts';
import { formatMoney } from '../../agent/prompt.ts';
import { offeringField } from '../../agent/tools/lookups.ts';
import { BRANCHES_FILE, validateInventory } from './coverage.ts';

/**
 * Loading and validating a conversation suite: `conversations.jsonl`, its
 * branch inventory `branches.json` and an optional `fixtures.json` beside a
 * suite's `cases.jsonl` (specs/043 §
 * Scripts supply contact messages and never supply the agent's answers).
 * Everything here runs before any provider call.
 */

export const SCENARIOS_FILE = 'conversations.jsonl';
export const FIXTURES_FILE = 'fixtures.json';

export interface Suite {
  dir: string;
  scenarios: Scenario[];
  fixtures: ChannelFixtures;
  /** Absent when the suite has no `branches.json`: then coverage cannot be complete. */
  inventory?: BranchInventory | undefined;
  /** Identifies the scripts, fixtures and inventory, so a report says what it ran (specs/043). */
  hashes: { scenarios: string; fixtures: string | null; branches: string | null };
}

const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Parses the suite, collecting every error rather than stopping at the first. */
export function loadSuite(dir: string): { suite?: Suite; errors: string[] } {
  const file = join(dir, SCENARIOS_FILE);
  if (!existsSync(file)) return { errors: [`no ${SCENARIOS_FILE} in ${dir}`] };
  const raw = readFileSync(file, 'utf8');
  const errors: string[] = [];
  const scenarios: Scenario[] = [];
  raw.split('\n').forEach((line, index) => {
    if (!line.trim()) return;
    const where = `${SCENARIOS_FILE}:${index + 1}`;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      errors.push(`${where}: not valid JSON`);
      return;
    }
    const parsed = Scenario.safeParse(json);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        errors.push(`${where}: ${issue.path.join('.') || '(line)'}: ${issue.message}`);
      }
      return;
    }
    scenarios.push(parsed.data);
  });
  if (scenarios.length === 0 && errors.length === 0) {
    errors.push(`${SCENARIOS_FILE} holds no scenario`);
  }

  const fixturesFile = join(dir, FIXTURES_FILE);
  let fixtures: ChannelFixtures = { flows: {} };
  let fixturesHash: string | null = null;
  if (existsSync(fixturesFile)) {
    const rawFixtures = readFileSync(fixturesFile, 'utf8');
    fixturesHash = sha256(rawFixtures);
    try {
      const parsed = ChannelFixtures.safeParse(JSON.parse(rawFixtures));
      if (parsed.success) fixtures = parsed.data;
      else {
        for (const issue of parsed.error.issues) {
          errors.push(`${FIXTURES_FILE}: ${issue.path.join('.') || '(file)'}: ${issue.message}`);
        }
      }
    } catch {
      errors.push(`${FIXTURES_FILE}: not valid JSON`);
    }
  }

  const branchesFile = join(dir, BRANCHES_FILE);
  let inventory: BranchInventory | undefined;
  let branchesHash: string | null = null;
  if (existsSync(branchesFile)) {
    const rawBranches = readFileSync(branchesFile, 'utf8');
    branchesHash = sha256(rawBranches);
    try {
      const parsed = BranchInventory.safeParse(JSON.parse(rawBranches));
      if (parsed.success) inventory = parsed.data;
      else {
        for (const issue of parsed.error.issues) {
          errors.push(`${BRANCHES_FILE}: ${issue.path.join('.') || '(file)'}: ${issue.message}`);
        }
      }
    } catch {
      errors.push(`${BRANCHES_FILE}: not valid JSON`);
    }
  }

  if (errors.length > 0) return { errors };
  return {
    suite: {
      dir,
      scenarios,
      fixtures,
      inventory,
      hashes: { scenarios: sha256(raw), fixtures: fixturesHash, branches: branchesHash },
    },
    errors,
  };
}

export interface SuiteTenant {
  catalog: Catalog;
  rules: Rules;
  tools?: Tools | undefined;
}

/** The catalogue value a selector names, rendered as the prompt renders it. */
export function resolveArtifact(selector: ArtifactSelector, catalog: Catalog): string | undefined {
  const offering = catalog.offerings.find(entry => entry.id === selector.offering);
  if (!offering) return undefined;
  switch (selector.field) {
    case 'name':
      return offering.name;
    case 'price':
      return formatMoney(offering.price.amount, offering.price.currency);
    case 'url':
      return offering.url ?? undefined;
    case 'schedule':
      return offering.schedule ?? undefined;
  }
}

/** The ids a matcher's tool may name in this tenant's `tools.json`. */
function configuredIds(tools: Tools, tool: ActionMatcher['tool']): string[] | undefined {
  switch (tool) {
    case 'send_flow':
      return tools.flows.map(flow => flow.id);
    case 'add_tag':
    case 'remove_tag':
      return tools.tags.map(tag => tag.id);
    case 'set_field':
      return tools.fields.map(field => field.id);
    case 'write_note':
      return tools.notes.map(note => note.id);
    case 'schedule_nudge':
      return (tools.nudge?.delays ?? []).map(delay => delay.id);
    case 'send_event':
      return tools.events.map(event => event.id);
    default:
      // A plugin's tools need fixture adapters, which this harness does not run.
      return undefined;
  }
}

/**
 * Checks a parsed suite against the tenant it runs on. Returns every problem,
 * each naming the scenario and step it is in; empty means the suite may run.
 */
export function validateSuite(
  suite: Suite,
  tenant: SuiteTenant,
  opts: { plugins: string[]; configDir?: string | undefined },
): string[] {
  const tools = tenant.tools ?? NO_TOOLS;
  const { catalog, rules } = tenant;
  const errors: string[] = [];

  // A live plugin would make external reads and writes from an eval
  // (specs/043 § The production turn path determines state and action outcomes).
  if (opts.plugins.length > 0) {
    errors.push(
      `plugins ${opts.plugins.join(', ')} are loaded: a conversation run needs fixture adapters for them, and none exist yet`,
    );
  }

  const keywords = rules.openingTrigger?.keywords ?? [];
  const isKeyword = (text: string) =>
    keywords.some(keyword => keyword.trim().toLowerCase() === text.trim().toLowerCase());
  const offeringIds = new Set(catalog.offerings.map(offering => offering.id));
  const flowIds = new Set(tools.flows.map(flow => flow.id));

  const checkMatcher = (where: string, matcher: Omit<ActionMatcher, 'status' | 'origin'>) => {
    const ids = configuredIds(tools, matcher.tool);
    if (ids === undefined) {
      errors.push(`${where}: tool ${matcher.tool} cannot be matched in a conversation run`);
      return;
    }
    if (!ids.includes(matcher.id)) {
      errors.push(`${where}: ${matcher.tool} ${matcher.id} is not configured in tools.json`);
      return;
    }
    if (matcher.tool === 'set_field' && matcher.value !== undefined) {
      const field = tools.fields.find(entry => entry.id === matcher.id);
      if (field && !field.values.includes(matcher.value)) {
        errors.push(`${where}: ${matcher.value} is not a value of field ${matcher.id}`);
      }
    }
  };
  const checkSelector = (where: string, selector: ArtifactSelector) => {
    if (resolveArtifact(selector, catalog) === undefined) {
      errors.push(
        `${where}: ${selector.offering}.${selector.field} does not resolve against the catalog`,
      );
    }
  };
  const checkState = (where: string, state: StateAssertion | undefined) => {
    if (!state) return;
    for (const [id, value] of Object.entries(state.fields ?? {})) {
      const field = tools.fields.find(entry => entry.id === id);
      if (!field) errors.push(`${where}: field ${id} is not configured in tools.json`);
      else if (value !== null && !field.values.includes(value)) {
        errors.push(`${where}: ${value} is not a value of field ${id}`);
      }
    }
    for (const id of [...(state.tags?.present ?? []), ...(state.tags?.absent ?? [])]) {
      if (!tools.tags.some(tag => tag.id === id)) {
        errors.push(`${where}: tag ${id} is not configured in tools.json`);
      }
    }
    if (typeof state.offering === 'string' && !offeringIds.has(state.offering)) {
      errors.push(`${where}: offering ${state.offering} is not in the catalog`);
    }
    const delay = state.pending_nudge;
    if (typeof delay === 'string' && !tools.nudge?.delays.some(entry => entry.id === delay)) {
      errors.push(`${where}: nudge delay ${delay} is not configured in tools.json`);
    }
  };

  const seen = new Set<string>();
  for (const scenario of suite.scenarios) {
    const at = `scenario ${scenario.id}`;
    if (seen.has(scenario.id)) errors.push(`${at}: duplicate scenario id`);
    seen.add(scenario.id);

    const stepIds = new Set<string>();
    for (const step of scenario.steps) {
      const where = `${at} step ${step.id}`;
      if (stepIds.has(step.id)) errors.push(`${where}: duplicate step id`);
      stepIds.add(step.id);
      const { input, expect } = step;
      if (input.kind === 'opening' && !isKeyword(input.text)) {
        errors.push(`${where}: ${JSON.stringify(input.text)} is not a configured opening trigger`);
      }
      // Production cannot tell a typed keyword from the flow's event, so a
      // script says which it means (specs/043 § Scripts supply contact messages).
      if (input.kind === 'message' && isKeyword(input.text)) {
        errors.push(`${where}: a message that is an opening trigger must use input.kind "opening"`);
      }
      if (input.kind === 'media') {
        // An invented file inside the suite, never the tenant's live media.
        const relative = normalize(input.file);
        if (isAbsolute(relative) || relative.startsWith('..')) {
          errors.push(`${where}: media file ${input.file} is outside the suite`);
        } else if (!existsSync(join(suite.dir, relative))) {
          errors.push(`${where}: media file ${input.file} does not exist`);
        }
      }
      if (expect.nudge !== undefined && input.kind !== 'silence') {
        errors.push(`${where}: a nudge expectation needs a silence step`);
      }
      if (input.kind === 'message' && input.advert_offering !== undefined) {
        if (!offeringIds.has(input.advert_offering)) {
          errors.push(`${where}: advert offering ${input.advert_offering} is not in the catalog`);
        }
      }
      checkState(where, expect.state);
      const actions = expect.actions ?? {};
      for (const matcher of [
        ...(actions.required ?? []),
        ...(actions.forbidden ?? []),
        ...(actions.exact ?? []),
        ...(actions.order ?? []),
      ]) {
        checkMatcher(where, matcher);
      }
      for (const entry of expect.delivery?.order ?? []) {
        if ('flow' in entry && !flowIds.has(entry.flow)) {
          errors.push(`${where}: flow ${entry.flow} is not configured in tools.json`);
        }
      }
    }

    const { expect, initial } = scenario;
    const where = `${at} expect`;
    if (expect.handoff && !stepIds.has(expect.handoff.step)) {
      errors.push(`${where}: handoff step ${expect.handoff.step} is not a step of the scenario`);
    }
    if (expect.handoff && expect.terminal !== 'handoff') {
      errors.push(`${where}: a handoff step is declared but the terminal is ${expect.terminal}`);
    }
    checkState(where, expect.state);
    const actions = expect.actions ?? {};
    for (const matcher of [
      ...(actions.required ?? []),
      ...(actions.forbidden ?? []),
      ...(actions.exact ?? []),
      ...(actions.order ?? []),
      ...(actions.counts ?? []).map(count => count.match),
    ]) {
      checkMatcher(where, matcher);
    }
    for (const selector of [
      ...(expect.artifacts?.required ?? []),
      ...(expect.artifacts?.forbidden ?? []),
    ]) {
      checkSelector(where, selector);
    }
    const checkRef = (ref: TraceRef) => {
      if ('step' in ref && !stepIds.has(ref.step)) {
        errors.push(`${where}: step ${ref.step} is not a step of the scenario`);
      }
      if ('flow' in ref && !flowIds.has(ref.flow)) {
        errors.push(`${where}: flow ${ref.flow} is not configured in tools.json`);
      }
      if ('action' in ref) checkMatcher(where, ref.action);
      if ('artifact' in ref) checkSelector(where, ref.artifact);
    };
    for (const entry of expect.order ?? []) [entry.first, entry.then].forEach(checkRef);
    for (const entry of expect.never_after ?? []) [entry.ref, entry.after].forEach(checkRef);

    if (initial) {
      const seed = `${at} initial`;
      for (const action of initial.actions) checkMatcher(seed, action);
      if (initial.offering !== undefined && !offeringIds.has(initial.offering)) {
        errors.push(`${seed}: offering ${initial.offering} is not in the catalog`);
      }
      // A performed offering write and the stored offering cannot disagree.
      const field = offeringField(tools);
      const written = initial.actions.filter(
        action => action.tool === 'set_field' && action.id === field?.id,
      );
      const last = written.at(-1)?.value;
      if (last !== undefined && initial.offering !== undefined && last !== initial.offering) {
        errors.push(
          `${seed}: the offering field was written ${last} but the offering is ${initial.offering}`,
        );
      }
      // Performed actions belong to an agent turn; seeding never invents one.
      if (initial.actions.length > 0 && !initial.history.some(turn => turn.role === 'agent')) {
        errors.push(`${seed}: seeded actions need an agent turn in the seeded history`);
      }
      if (initial.actions.some(action => action.tool === 'set_field' && !action.value)) {
        errors.push(`${seed}: a seeded set_field needs a value`);
      }
    }
  }

  if (suite.inventory) {
    errors.push(
      ...validateInventory(suite.inventory, suite.scenarios, {
        ...tenant,
        configDir: opts.configDir ?? 'config',
      }),
    );
  } else if (suite.scenarios.some(scenario => scenario.steps.some(step => step.expect.witnesses))) {
    errors.push(`a step names a witness, but the suite has no ${BRANCHES_FILE}`);
  }

  // A criterion about what the contact saw needs to know what each flow
  // shows; a silent flow shows nothing (specs/043).
  const reviewed = suite.scenarios.some(
    scenario => (scenario.review?.length ?? 0) > 0 || scenario.steps.some(step => step.review),
  );
  for (const id of Object.keys(suite.fixtures.flows)) {
    if (!flowIds.has(id)) errors.push(`${FIXTURES_FILE}: flow ${id} is not configured`);
  }
  if (reviewed) {
    for (const flow of tools.flows) {
      if (!flow.silent && suite.fixtures.flows[flow.id] === undefined) {
        errors.push(
          `${FIXTURES_FILE}: flow ${flow.id} has no fixture, and the suite has review criteria`,
        );
      }
    }
  }
  return errors;
}
