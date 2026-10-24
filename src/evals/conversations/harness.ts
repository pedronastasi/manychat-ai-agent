import { and, asc, eq, gt, min, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { createEmbeddedDatabase } from '../../db/client.ts';
import { runMigrations } from '../../db/migrate.ts';
import { conversations, outbox, turns } from '../../db/schema.ts';
import { TurnHandler } from '../../turn/handler.ts';
import type { TurnLogger } from '../../turn/logger.ts';
import { TurnLanes } from '../../conversation/turns.ts';
import { ConversationStore } from '../../conversation/store.ts';
import { ContactTokens } from '../../conversation/tokens.ts';
import { OutboxWorker } from '../../outbox/worker.ts';
import type { AgentResult, AgentRunner, AgentTurnInput } from '../../agent/runner.ts';
import type {
  ActionRecord,
  AgentReply,
  InboundMessage,
  PerformableAction,
  TurnOutcome,
} from '../../contracts/agent.ts';
import type { Rules, Tools } from '../../contracts/config.ts';
import { NO_TOOLS } from '../../contracts/config.ts';
import type { InitialState, Scenario, Step, Terminal } from '../../contracts/conversations.ts';
import { intentField, offeringField } from '../../agent/tools/lookups.ts';
import { SimulatedChannel } from './channel.ts';
import type { Delivery } from './channel.ts';

/**
 * Runs one repetition of a scenario through the production turn path: the
 * real `TurnHandler`, its race, guardrails, gating, flows and outbox, on a
 * fresh embedded database. Only the model and the channel are replaced, at
 * their ports (specs/004, specs/043 § The production turn path determines
 * state and action outcomes).
 */

/** The contact every repetition invents: no real subscriber reaches a run (C1, C5). */
export const EVAL_TENANT = 'eval';
export const EVAL_SUBSCRIBER = 'contact-1';

/** How long a step's deferred reply, flow wait and outbox may take to settle. */
const SETTLE_LIMIT_MS = 120_000;

const SILENT: TurnLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** An action on the trace, with the step whose turn recorded it. */
export interface TraceAction extends ActionRecord {
  step: string;
}

/** The contact's state after a step settles, with fields by their `tools.json` id. */
export interface ContactState {
  fields: Record<string, string | null>;
  /** Tag ids the contact carries. */
  tags: string[];
  offering: string | null;
}

export interface StepRecord {
  id: string;
  input: Step['input'];
  outcome: TurnOutcome;
  /** The reply the step ended with: the deferred one when the race was lost. */
  reply: AgentReply;
  /** The step's reply messages as delivered, without a holding line. */
  messages: string[];
  actions: TraceAction[];
  state: ContactState;
  /** The agent's own latency, from the model call; absent when the model never ran. */
  latencyMs?: number | undefined;
  costUsd: number;
  interventions: string[];
  /** A provider error the turn hid behind its fail-closed reply (specs/043). */
  executionError?: string | undefined;
}

export interface RepetitionRun {
  repetition: number;
  steps: StepRecord[];
  /** Steps the script did not reach, after a handoff or an execution error. */
  notReached: string[];
  terminal: Terminal;
  deliveries: Delivery[];
  actions: TraceAction[];
  executionError?: string | undefined;
}

export interface HarnessOptions {
  /** A fresh runner for the tenant, wrapped per repetition to record its results. */
  runner: AgentRunner;
  rules: Rules;
  tools?: Tools | undefined;
  raceDeadlineMs: number;
  modelAbortMs: number;
  tokensEnforced: boolean;
  defaultChannel: string;
  /** Configures the channel before the first step, such as a refused flow in a test. */
  prepare?: ((channel: SimulatedChannel) => void) | undefined;
  /** A database for the repetition; defaults to a fresh embedded one. */
  database?: (() => Promise<{ db: Database; close: () => Promise<void> }>) | undefined;
}

/** Records every result the model boundary returns, per step, without changing any. */
class RecordingRunner implements AgentRunner {
  readonly results = new Map<string, AgentResult[]>();
  /** What a call threw, by step: an abort past `MODEL_ABORT_MS` returns no result. */
  readonly thrown = new Map<string, string>();
  step = '';
  private readonly inner: AgentRunner;

  constructor(inner: AgentRunner) {
    this.inner = inner;
  }

  async run(input: AgentTurnInput): Promise<AgentResult> {
    const step = this.step;
    let result: AgentResult;
    try {
      result = await this.inner.run(input);
    } catch (error) {
      // Rethrown, so the turn settles as in production; the step still
      // records that its model call never finished.
      this.thrown.set(step, error instanceof Error ? error.name : String(error));
      throw error;
    }
    const list = this.results.get(step) ?? [];
    list.push(result);
    this.results.set(step, list);
    return result;
  }
}

async function freshDatabase(): Promise<{ db: Database; close: () => Promise<void> }> {
  const { db, client } = await createEmbeddedDatabase('pglite');
  const database = db as unknown as Database;
  await runMigrations(database);
  return { db: database, close: () => client.close() };
}

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Runs one repetition from a fresh state: database, contact, channel and ledger. */
export async function runRepetition(
  scenario: Scenario,
  repetition: number,
  opts: HarnessOptions,
): Promise<RepetitionRun> {
  const tools = opts.tools ?? NO_TOOLS;
  const { db, close } = await (opts.database ?? freshDatabase)();
  const channel = new SimulatedChannel();
  opts.prepare?.(channel);
  const runner = new RecordingRunner(opts.runner);
  const lanes = new TurnLanes(opts.modelAbortMs + opts.raceDeadlineMs);
  const store = new ConversationStore(db);
  const worker = new OutboxWorker({ db, client: channel, logger: SILENT });
  const handler = new TurnHandler({
    db,
    runner,
    rules: opts.rules,
    tools,
    raceDeadlineMs: opts.raceDeadlineMs,
    modelAbortMs: opts.modelAbortMs,
    logger: SILENT,
    tokenWriter: channel,
    tokensEnforced: opts.tokensEnforced,
    actions: channel,
    contacts: channel,
    lanes,
    defaultChannel: opts.defaultChannel,
  });

  const run: RepetitionRun = {
    repetition,
    steps: [],
    notReached: [],
    terminal: 'completed',
    deliveries: channel.deliveries,
    actions: [],
  };

  try {
    if (scenario.initial) {
      await seed(scenario.initial, { db, store, channel, tools, rules: opts.rules, opts });
    }
    let seq = await lastSeq(db);

    for (const [index, step] of scenario.steps.entries()) {
      channel.step = step.id;
      runner.step = step.id;
      const inbound: InboundMessage = {
        tenantId: EVAL_TENANT,
        subscriberId: EVAL_SUBSCRIBER,
        text: step.input.text,
        channel: opts.defaultChannel,
        contactName: null,
        locale: null,
        contactToken: channel.tokenOf(EVAL_SUBSCRIBER),
        offering: step.input.kind === 'message' ? (step.input.advert_offering ?? null) : null,
        receivedAt: new Date(),
      };

      const turn = await handler.handle(inbound);
      // The response goes out first; the actions it staged follow it
      // (specs/012 § Actions follow the text).
      if (!turn.silent) channel.deliverInline(turn.reply.messages);
      await turn.afterResponse?.();
      await settle({ lanes, worker, db });

      const results = runner.results.get(step.id) ?? [];
      const last = results.at(-1);
      // A lost race delivers the model's reply later; the turn's own reply was
      // the holding line (ADR-0001).
      const reply = turn.outcome === 'deferred' && last ? last.reply : turn.reply;
      const delivered = channel.deliveries.filter(
        (entry): entry is Extract<Delivery, { kind: 'reply' }> =>
          entry.kind === 'reply' && entry.step === step.id,
      );
      const messages = delivered
        .filter(entry => turn.outcome !== 'deferred' || entry.via === 'outbox')
        .flatMap(entry => entry.messages);

      const actions = (await actionsSince(db, seq)).map(action => ({ ...action, step: step.id }));
      seq = await lastSeq(db);
      run.actions.push(...actions);

      const modelError =
        results.find(result => result.modelError)?.modelError ?? runner.thrown.get(step.id);
      const executionError =
        modelError !== undefined
          ? `model error: ${modelError}`
          : turn.outcome === 'error'
            ? 'the turn failed and escalated'
            : turn.outcome === 'deferred' && last === undefined
              ? 'the deferred model call did not complete'
              : undefined;

      run.steps.push({
        id: step.id,
        input: step.input,
        outcome: turn.outcome,
        reply,
        messages,
        actions,
        state: await stateOf(db, channel, tools),
        latencyMs: last?.latencyMs,
        costUsd: results.reduce((sum, result) => sum + result.usage.costUsd, 0),
        interventions: results.flatMap(result => result.interventions),
        executionError,
      });

      // An infrastructure failure never passes a behaviour test, even when its
      // fallback escalation looks like an expected handoff (specs/043 § A
      // failed conversation continues until a terminal event).
      if (executionError !== undefined) {
        run.terminal = 'error';
        run.executionError = `${step.id}: ${executionError}`;
      } else if (reply.escalate) {
        run.terminal = 'handoff';
      }
      if (run.terminal !== 'completed') {
        run.notReached = scenario.steps.slice(index + 1).map(next => next.id);
        break;
      }
    }

    if (run.terminal === 'completed') {
      const intent = intentField(tools);
      const final = run.steps.at(-1)?.state;
      if (intent && final?.fields[intent.id] === 'not_prospect') run.terminal = 'declined';
    }
  } catch (error) {
    run.terminal = 'error';
    run.executionError = `harness: ${error instanceof Error ? error.message : String(error)}`;
    const done = new Set(run.steps.map(step => step.id));
    run.notReached = scenario.steps.filter(step => !done.has(step.id)).map(step => step.id);
  } finally {
    await close();
  }
  return run;
}

/**
 * Waits for everything the turn left running: its deferred reply recorded,
 * then every queued reply delivered, flow waits included. The next step
 * starts only after this (specs/043).
 */
async function settle(deps: { lanes: TurnLanes; worker: OutboxWorker; db: Database }) {
  // The contact's lane frees once the turn's background work has settled.
  const slot = deps.lanes.enter(`${EVAL_TENANT}:${EVAL_SUBSCRIBER}`);
  const ready = await slot.ready;
  slot.leave();
  if (ready === 'expired') throw new Error('the turn did not settle within the model abort bound');

  const deadline = Date.now() + SETTLE_LIMIT_MS;
  for (;;) {
    const drained = await deps.worker.drainOnce();
    if (drained.claimed > 0) continue;
    const [pending] = await deps.db
      .select({ due: min(outbox.nextAttemptAt), count: sql<number>`count(*)::int` })
      .from(outbox)
      .where(and(eq(outbox.status, 'pending'), eq(outbox.kind, 'reply')));
    if (!pending || pending.count === 0) return;
    if (Date.now() > deadline) throw new Error('queued replies did not drain');
    // A reply waits for a playing flow in real time until a virtual clock
    // replaces it (specs/043 § The production turn path).
    const due = pending.due ? new Date(pending.due).getTime() : Date.now();
    await pause(Math.min(Math.max(due - Date.now(), 25), 1000));
  }
}

async function lastSeq(db: Database): Promise<number> {
  const [row] = await db
    .select({ seq: sql<number>`coalesce(max(${turns.seq}), 0)::int` })
    .from(turns);
  return row?.seq ?? 0;
}

/** Every action record of an agent turn recorded after `seq`, in order. */
async function actionsSince(db: Database, seq: number): Promise<ActionRecord[]> {
  const rows = await db
    .select({ actions: turns.actions })
    .from(turns)
    .where(and(eq(turns.role, 'agent'), gt(turns.seq, seq)))
    .orderBy(asc(turns.seq));
  return rows.flatMap(row => row.actions ?? []);
}

async function stateOf(
  db: Database,
  channel: SimulatedChannel,
  tools: Tools,
): Promise<ContactState> {
  const fields: Record<string, string | null> = {};
  for (const field of tools.fields) fields[field.id] = channel.field(EVAL_SUBSCRIBER, field.field);
  const tags = tools.tags
    .filter(tag => channel.hasTag(EVAL_SUBSCRIBER, tag.tag))
    .map(tag => tag.id);
  const [row] = await db
    .select({ offering: conversations.offering })
    .from(conversations)
    .where(
      and(eq(conversations.tenantId, EVAL_TENANT), eq(conversations.subscriberId, EVAL_SUBSCRIBER)),
    );
  return { fields, tags, offering: row?.offering ?? null };
}

/**
 * Seeds a returning contact: their conversation and token, their history,
 * and the actions an earlier agent turn performed, in the database and on the
 * channel's record alike. Seeded state earns no coverage (specs/043).
 */
async function seed(
  initial: InitialState,
  deps: {
    db: Database;
    store: ConversationStore;
    channel: SimulatedChannel;
    tools: Tools;
    rules: Rules;
    opts: HarnessOptions;
  },
): Promise<void> {
  const { db, store, channel, tools, rules, opts } = deps;
  const conversation = await store.startTurn({
    tenantId: EVAL_TENANT,
    subscriberId: EVAL_SUBSCRIBER,
    channel: opts.defaultChannel,
    idleResetHours: rules.idleResetHours,
  });
  const issued = await new ContactTokens(db, channel).issue({
    tenantId: EVAL_TENANT,
    subscriberId: EVAL_SUBSCRIBER,
    conversationId: conversation.id,
  });
  await issued?.written;

  const records: ActionRecord[] = [];
  for (const action of initial.actions) {
    const performable = performableOf(action, tools);
    if (performable) await channel.seed(EVAL_SUBSCRIBER, performable);
    records.push({
      tool: action.tool,
      id: action.id,
      ...(action.value === undefined ? {} : { value: action.value }),
      status: 'performed',
    });
  }

  const lastAgent = initial.history.findLastIndex(turn => turn.role === 'agent');
  for (const [index, turn] of initial.history.entries()) {
    const bound = { bound: true, channel: opts.defaultChannel };
    if (turn.role === 'user') await store.recordUserMessage(conversation.id, turn.text, bound);
    else {
      await store.recordAgentReply(conversation.id, turn.text, 'answered_inline', {
        bound: true,
        actions: index === lastAgent ? records : tools.flows.length > 0 ? [] : null,
      });
    }
  }
  const offering = initial.offering ?? offeringValue(initial, tools);
  if (offering !== undefined) await store.setOffering(conversation.id, offering);
}

function offeringValue(initial: InitialState, tools: Tools): string | undefined {
  const field = offeringField(tools);
  return initial.actions.findLast(action => action.tool === 'set_field' && action.id === field?.id)
    ?.value;
}

/** The request a seeded action stands for, as the channel would have received it. */
function performableOf(
  action: InitialState['actions'][number],
  tools: Tools,
): PerformableAction | undefined {
  switch (action.tool) {
    case 'set_field': {
      const field = tools.fields.find(entry => entry.id === action.id);
      return field && action.value !== undefined
        ? { tool: 'set_field', id: action.id, field: field.field, value: action.value }
        : undefined;
    }
    case 'add_tag': {
      const tag = tools.tags.find(entry => entry.id === action.id);
      return tag ? { tool: 'add_tag', id: action.id, tag: tag.tag } : undefined;
    }
    default:
      // A sent flow changes no field, and a note's text is never seeded.
      return undefined;
  }
}
