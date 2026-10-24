import type { Catalog, Tools } from '../../contracts/config.ts';
import { NO_TOOLS } from '../../contracts/config.ts';
import type {
  ActionMatcher,
  ConversationExpect,
  DeliveryMatcher,
  Scenario,
  StateAssertion,
  Step,
  TraceRef,
} from '../../contracts/conversations.ts';
import { checkCase } from '../cases.ts';
import type { Delivery } from './channel.ts';
import type { ContactState, RepetitionRun, StepRecord, TraceAction } from './harness.ts';
import { resolveArtifact } from './suite.ts';

/**
 * The deterministic assertions of a conversation run, as pure functions over
 * what the harness recorded (specs/043 § Assertions cover steps, transitions,
 * and terminal outcomes). A judge never overrides them.
 */

export interface Failure {
  /** The step it was found at; absent for a whole-conversation assertion. */
  step?: string | undefined;
  message: string;
  /**
   * Found after the repetition's first failure. Kept and labelled, never
   * blamed on it: causality is not guessed (specs/043 § A failed
   * conversation continues until a terminal event).
   */
  downstream: boolean;
}

export interface AssertContext {
  catalog: Catalog;
  tools?: Tools | undefined;
  latencyBudgetMs: number;
}

/** Whether a recorded action is what a matcher names, status included. */
export function matches(matcher: ActionMatcher, action: TraceAction): boolean {
  if (matcher.tool !== action.tool || matcher.id !== action.id) return false;
  if (matcher.value !== undefined && matcher.value !== action.value) return false;
  if (matcher.origin !== undefined && matcher.origin !== action.origin) return false;
  if (matcher.status === 'attempted') {
    return action.status === 'performed' || action.status === 'failed';
  }
  return matcher.status === action.status;
}

const describe = (matcher: ActionMatcher) =>
  `${matcher.tool} ${matcher.id}${matcher.value ? `=${matcher.value}` : ''} (${matcher.status}${
    matcher.origin ? `, ${matcher.origin}` : ''
  })`;

function checkActions(
  expected:
    | {
        required?: ActionMatcher[] | undefined;
        forbidden?: ActionMatcher[] | undefined;
        exact?: ActionMatcher[] | undefined;
        order?: ActionMatcher[] | undefined;
      }
    | undefined,
  actions: readonly TraceAction[],
): string[] {
  if (!expected) return [];
  const failures: string[] = [];
  for (const matcher of expected.required ?? []) {
    if (!actions.some(action => matches(matcher, action))) {
      failures.push(`required action missing: ${describe(matcher)}`);
    }
  }
  for (const matcher of expected.forbidden ?? []) {
    if (actions.some(action => matches(matcher, action))) {
      failures.push(`forbidden action present: ${describe(matcher)}`);
    }
  }
  if (expected.exact) {
    // Every action is matched by exactly one matcher and every matcher by one action.
    const left = [...actions];
    let exact = true;
    for (const matcher of expected.exact) {
      const index = left.findIndex(action => matches(matcher, action));
      if (index < 0) exact = false;
      else left.splice(index, 1);
    }
    if (!exact || left.length > 0) {
      const got = actions.map(action => `${action.tool} ${action.id} (${action.status})`);
      failures.push(
        `actions expected exactly ${expected.exact.map(describe).join(', ')}; got ${got.join(', ') || 'none'}`,
      );
    }
  }
  if (expected.order) {
    let from = 0;
    for (const matcher of expected.order) {
      const index = actions.findIndex((action, at) => at >= from && matches(matcher, action));
      if (index < 0) {
        failures.push(`actions out of the declared order at ${describe(matcher)}`);
        break;
      }
      from = index + 1;
    }
  }
  return failures;
}

function checkState(expected: StateAssertion | undefined, state: ContactState): string[] {
  if (!expected) return [];
  const failures: string[] = [];
  for (const [id, value] of Object.entries(expected.fields ?? {})) {
    const got = state.fields[id] ?? null;
    if (got !== value) failures.push(`field ${id} expected ${value}, got ${got}`);
  }
  for (const id of expected.tags?.present ?? []) {
    if (!state.tags.includes(id)) failures.push(`tag ${id} expected, absent`);
  }
  for (const id of expected.tags?.absent ?? []) {
    if (state.tags.includes(id)) failures.push(`tag ${id} present, expected absent`);
  }
  if (expected.offering !== undefined && expected.offering !== state.offering) {
    failures.push(`offering expected ${expected.offering}, got ${state.offering}`);
  }
  return failures;
}

function deliveryMatches(matcher: DeliveryMatcher, delivery: Delivery): boolean {
  if ('flow' in matcher) return delivery.kind === 'flow' && delivery.id === matcher.flow;
  return delivery.kind === 'reply' && delivery.messages.join(' ').includes(matcher.reply);
}

/** Every assertion of one step against what that step recorded. */
export function checkStep(
  step: Step,
  record: StepRecord,
  deliveries: readonly Delivery[],
  ctx: AssertContext,
): string[] {
  const { expect } = step;
  const reply = {
    ...record.reply,
    messages: record.messages.length > 0 ? record.messages : record.reply.messages,
  };
  const failures = checkCase({
    testCase: {
      id: step.id,
      history: [],
      text: step.input.text,
      expect: { escalate: expect.escalate ?? reply.escalate, reason: expect.reason },
      must_not_invent_prices: expect.must_not_invent_prices,
      must_end_with_question: expect.must_end_with_question,
      must_contain: expect.must_contain,
      must_not_contain: expect.must_not_contain,
      max_lines: expect.max_lines,
    },
    reply,
    catalog: ctx.catalog,
    // A turn the model never ran has no agent latency to charge.
    latencyMs: record.latencyMs ?? 0,
    latencyBudgetMs: ctx.latencyBudgetMs,
    interventions: record.interventions,
  });

  failures.push(...checkState(expect.state, record.state));
  failures.push(...checkActions(expect.actions, record.actions));

  if (expect.delivery) {
    const own = deliveries.filter(entry => entry.step === step.id);
    let from = 0;
    for (const matcher of expect.delivery.order) {
      const index = own.findIndex((entry, at) => at >= from && deliveryMatches(matcher, entry));
      if (index < 0) {
        failures.push(`delivery out of the declared order at ${JSON.stringify(matcher)}`);
        break;
      }
      from = index + 1;
    }
  }

  const closing = expect.closing_question;
  if (closing !== undefined) {
    const asked = record.reply.closing_question;
    if (closing === 'required' && asked === null) failures.push('closing question required');
    if (closing === 'absent' && asked !== null) failures.push(`closing question present: ${asked}`);
    if (typeof closing === 'object' && asked !== closing.exact) {
      failures.push(`closing question expected ${closing.exact}, got ${asked}`);
    }
  }
  return failures;
}

/** Where a reference first and last occurs on the run's timeline, or undefined. */
function positions(ref: TraceRef, timeline: Timeline, ctx: AssertContext): number[] {
  const out: number[] = [];
  timeline.forEach((entry, index) => {
    if ('step' in ref) {
      if (entry.step === ref.step) out.push(index);
    } else if ('flow' in ref) {
      if (entry.delivery?.kind === 'flow' && entry.delivery.id === ref.flow) out.push(index);
    } else if ('action' in ref) {
      if (entry.action && matches(ref.action, entry.action)) out.push(index);
    } else {
      const value = resolveArtifact(ref.artifact, ctx.catalog);
      const delivery = entry.delivery;
      if (value && delivery?.kind === 'reply' && delivery.messages.join(' ').includes(value)) {
        out.push(index);
      }
    }
  });
  return out;
}

type Timeline = { step: string; delivery?: Delivery; action?: TraceAction }[];

/**
 * The run as one ordered timeline: within a step, what the contact saw, then
 * the actions its turn recorded.
 */
function timelineOf(run: RepetitionRun): Timeline {
  const timeline: Timeline = [];
  for (const step of run.steps) {
    for (const delivery of run.deliveries) {
      if (delivery.step === step.id) timeline.push({ step: step.id, delivery });
    }
    for (const action of step.actions) timeline.push({ step: step.id, action });
  }
  return timeline;
}

const describeRef = (ref: TraceRef) => JSON.stringify(ref);

/** The scenario's whole-conversation assertions against a repetition. */
export function checkConversation(
  expect: ConversationExpect,
  run: RepetitionRun,
  ctx: AssertContext,
): string[] {
  const failures: string[] = [];
  if (run.terminal !== expect.terminal) {
    failures.push(`terminal expected ${expect.terminal}, got ${run.terminal}`);
  }
  if (expect.handoff && run.terminal === 'handoff') {
    const last = run.steps.at(-1);
    if (last?.id !== expect.handoff.step) {
      failures.push(`handoff expected at ${expect.handoff.step}, happened at ${last?.id}`);
    }
    if (expect.handoff.reason && last?.reply.escalation_reason !== expect.handoff.reason) {
      failures.push(
        `handoff reason expected ${expect.handoff.reason}, got ${last?.reply.escalation_reason}`,
      );
    }
  }
  const final = run.steps.at(-1)?.state;
  if (expect.state && final) failures.push(...checkState(expect.state, final));
  failures.push(...checkActions(expect.actions, run.actions));
  for (const count of expect.actions?.counts ?? []) {
    const got = run.actions.filter(action => matches(count.match, action)).length;
    if (got !== count.count) {
      failures.push(`${describe(count.match)} expected ${count.count} times, got ${got}`);
    }
  }

  const said = run.deliveries
    .filter((entry): entry is Extract<Delivery, { kind: 'reply' }> => entry.kind === 'reply')
    .map(entry => entry.messages.join(' '))
    .join(' ');
  for (const selector of expect.artifacts?.required ?? []) {
    const value = resolveArtifact(selector, ctx.catalog);
    if (value && !said.includes(value)) {
      failures.push(`required ${selector.offering}.${selector.field} never delivered: ${value}`);
    }
  }
  for (const selector of expect.artifacts?.forbidden ?? []) {
    const value = resolveArtifact(selector, ctx.catalog);
    if (value && said.includes(value)) {
      failures.push(`forbidden ${selector.offering}.${selector.field} delivered: ${value}`);
    }
  }

  const timeline = timelineOf(run);
  for (const { first, then } of expect.order ?? []) {
    const before = positions(first, timeline, ctx);
    const after = positions(then, timeline, ctx);
    if (before.length === 0) failures.push(`${describeRef(first)} never happened`);
    else if (after.length === 0) failures.push(`${describeRef(then)} never happened`);
    else if (Math.min(...before) > Math.min(...after)) {
      failures.push(`${describeRef(then)} happened before ${describeRef(first)}`);
    }
  }
  for (const { ref, after } of expect.never_after ?? []) {
    const anchor = positions(after, timeline, ctx);
    if (anchor.length === 0) continue;
    const start = Math.min(...anchor);
    if (positions(ref, timeline, ctx).some(at => at > start)) {
      failures.push(`${describeRef(ref)} happened after ${describeRef(after)}`);
    }
  }
  return failures;
}

/**
 * Every failure of a repetition, in the order found: each reached step's,
 * then the conversation's. Everything after the first is downstream.
 */
export function failuresOf(scenario: Scenario, run: RepetitionRun, ctx: AssertContext): Failure[] {
  const ctxTools = { ...ctx, tools: ctx.tools ?? NO_TOOLS };
  const found: { step?: string; message: string }[] = [];
  for (const record of run.steps) {
    const step = scenario.steps.find(entry => entry.id === record.id);
    if (!step) continue;
    for (const message of checkStep(step, record, run.deliveries, ctxTools)) {
      found.push({ step: record.id, message });
    }
  }
  if (run.executionError) found.push({ message: `execution error: ${run.executionError}` });
  for (const message of checkConversation(scenario.expect, run, ctxTools)) found.push({ message });
  return found.map((failure, index) => ({ ...failure, downstream: index > 0 }));
}
