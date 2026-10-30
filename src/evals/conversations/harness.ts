import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, asc, eq, gt, min, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { createEmbeddedDatabase } from '../../db/client.ts';
import { runMigrations } from '../../db/migrate.ts';
import { conversations, nudges, outbox, turns } from '../../db/schema.ts';
import { TurnHandler } from '../../turn/handler.ts';
import type { Tracing } from '../../observability/tracing.ts';
import type { TurnLogger } from '../../turn/logger.ts';
import { TurnLanes } from '../../conversation/turns.ts';
import { ConversationStore } from '../../conversation/store.ts';
import { ContactTokens } from '../../conversation/tokens.ts';
import { OutboxWorker } from '../../outbox/worker.ts';
import { NudgeWorker } from '../../nudge/worker.ts';
import type { NudgeResult } from '../../nudge/worker.ts';
import { MediaResolver } from '../../media/resolver.ts';
import type {
  MediaDownload,
  MediaFetcher,
  Transcriber,
  Transcript,
  VideoSplitter,
} from '../../media/port.ts';
import { plainReply } from '../../turn/replies.ts';
import type { AgentResult, AgentRunner, AgentTurnInput } from '../../agent/runner.ts';
import type {
  ActionRecord,
  AgentReply,
  InboundMessage,
  PerformableAction,
  TurnOutcome,
} from '../../contracts/agent.ts';
import type { Catalog, Rules, Tools } from '../../contracts/config.ts';
import { NO_TOOLS } from '../../contracts/config.ts';
import type {
  InitialState,
  NudgeOutcome,
  Scenario,
  Step,
  Terminal,
} from '../../contracts/conversations.ts';
import { intentField, offeringField } from '../../agent/tools/lookups.ts';
import { SimulatedChannel } from './channel.ts';
import type { Delivery } from './channel.ts';
import { VirtualClock } from './clock.ts';

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

/** How long a step's deferred reply and outbox may take to settle, in real time. */
const SETTLE_LIMIT_MS = 120_000;

/** How many nudges one silence step may run: one comes due, and may schedule the next. */
const MAX_NUDGES_PER_SILENCE = 20;

/** Where a media step's file is said to be. Never fetched: the fixture fetcher answers it. */
const MEDIA_HOST = 'https://media.eval.invalid';

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
  /** The pending nudge, by its `tools.json` delay id (or its minutes when none matches). */
  pendingNudge: string | null;
}

export interface StepRecord {
  id: string;
  input: Step['input'];
  /** The turn's outcome; `no_turn` for a silence step in which no model ran. */
  outcome: TurnOutcome | 'no_turn';
  /** The reply the step ended with: the deferred one when the race was lost. */
  reply: AgentReply;
  /** The step's reply messages as delivered, without a holding line. */
  messages: string[];
  /** How many replies reached the contact in the step, without a holding line. */
  replies: number;
  /** Silence steps: what became of the nudge, and what the worker reported. */
  nudge?: { outcome: NudgeOutcome; results: NudgeResult[] } | undefined;
  /** How far the repetition's clock had moved past real time when the step settled. */
  clockMs: number;
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
  catalog: Catalog;
  raceDeadlineMs: number;
  modelAbortMs: number;
  tokensEnforced: boolean;
  defaultChannel: string;
  /** Configures the channel before the first step, such as a refused flow in a test. */
  prepare?: ((channel: SimulatedChannel) => void) | undefined;
  /** Where a media step's file is read from: the suite's directory. */
  suiteDir?: string | undefined;
  /**
   * What the deployment can read (specs/020): whether the agent model takes
   * images, whether a transcription model is set, and the video splitter, if
   * ffmpeg is installed. Transcription answers from the step's fixture, never
   * a provider. Defaults: no images, transcription, no splitter.
   */
  media?: { acceptsImages: boolean; transcription: boolean; splitter: VideoSplitter | null };
  /** A database for the repetition; defaults to a fresh embedded one. */
  database?: (() => Promise<{ db: Database; close: () => Promise<void> }>) | undefined;
  /** Turn traces, when `TRACE_TURNS` names LangSmith (specs/052). */
  tracing?: Tracing | undefined;
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

/**
 * The ManyChat media host, for a conversation run: a step's media URL answers
 * with the step's own invented file, as the channel would serve it (specs/004,
 * specs/043). It makes no request.
 */
class FixtureFetcher implements MediaFetcher {
  private readonly files = new Map<string, MediaDownload>();

  serve(url: string, download: MediaDownload): void {
    this.files.set(url, download);
  }

  fetch(media: { url: string }): Promise<MediaDownload> {
    const file = this.files.get(media.url);
    return file ? Promise.resolve(file) : Promise.reject(new Error('no fixture for this media'));
  }
}

/** Transcription at the model boundary: the step's declared transcript, at no cost. */
class FixtureTranscriber implements Transcriber {
  current = '';

  transcribe(): Promise<Transcript> {
    return Promise.resolve({ text: this.current, model: 'fixture', costUsd: 0 });
  }
}

/** A step's input as the transcript shows it. A media file is named, never read out. */
export function inputText(input: Step['input']): string {
  switch (input.kind) {
    case 'media':
      return `[${input.media}: ${input.file}]${input.transcript === undefined ? '' : ` "${input.transcript}"`}`;
    case 'silence':
      return `[silence: ${input.advance_minutes} minutes]`;
    default:
      return input.text;
  }
}

/** One outcome for the step from everything the nudge worker reported over it. */
function nudgeOutcome(results: readonly NudgeResult[]): NudgeOutcome {
  if (results.includes('sent')) return 'sent';
  if (results.includes('skipped')) return 'suppressed';
  return results.length > 0 ? 'cancelled' : 'none';
}

/** Runs one repetition from a fresh state: database, contact, clock, channel and ledger. */
export async function runRepetition(
  scenario: Scenario,
  repetition: number,
  opts: HarnessOptions,
): Promise<RepetitionRun> {
  const tools = opts.tools ?? NO_TOOLS;
  const { db, close } = await (opts.database ?? freshDatabase)();
  const clock = new VirtualClock(db);
  const channel = new SimulatedChannel();
  opts.prepare?.(channel);
  const runner = new RecordingRunner(opts.runner);
  const lanes = new TurnLanes(opts.modelAbortMs + opts.raceDeadlineMs);
  const store = new ConversationStore(db);
  const worker = new OutboxWorker({ db, client: channel, logger: SILENT });
  // A nudge that fails anywhere but the model is reported by the worker as
  // skipped, which would read as suppressed: its error log is how the step
  // knows it was an infrastructure failure instead (specs/043).
  const nudgeFailures: string[] = [];
  const nudger = new NudgeWorker({
    db,
    runner,
    config: () => ({ persona: '', catalog: opts.catalog, rules: opts.rules, tools }),
    contacts: channel,
    logger: { ...SILENT, error: (_fields, message) => nudgeFailures.push(message) },
    modelAbortMs: opts.modelAbortMs,
    tracing: opts.tracing,
  });
  const fetcher = new FixtureFetcher();
  const transcriber = new FixtureTranscriber();
  const capabilities = opts.media ?? { acceptsImages: false, transcription: true, splitter: null };
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
    tracing: opts.tracing,
    media: new MediaResolver({
      fetcher,
      transcriber: capabilities.transcription ? transcriber : null,
      splitter: capabilities.splitter,
      acceptsImages: capabilities.acceptsImages,
    }),
  });
  const settled = () => settle({ lanes, worker, db, clock });

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
      const { input } = step;

      let outcome: StepRecord['outcome'];
      let turnReply: AgentReply | undefined;
      let nudge: StepRecord['nudge'];
      if (input.kind === 'silence') {
        nudgeFailures.length = 0;
        const results = await silence(input.advance_minutes * 60_000, {
          db,
          clock,
          nudger,
          settled,
        });
        const ran = results.includes('sent') || results.includes('skipped');
        outcome = results.includes('sent') ? 'nudge_sent' : ran ? 'nudge_skipped' : 'no_turn';
        nudge = { outcome: nudgeOutcome(results), results };
      } else {
        let text = input.kind === 'media' ? '' : input.text;
        let media: InboundMessage['media'];
        if (input.kind === 'media') {
          // A file arrives as its URL alone, with no caption (specs/020).
          text = `${MEDIA_HOST}/${encodeURIComponent(scenario.id)}/${encodeURIComponent(step.id)}`;
          media = { kind: input.media, url: text };
          fetcher.serve(text, {
            bytes: new Uint8Array(readFileSync(join(opts.suiteDir ?? '.', input.file))),
            contentType: input.content_type,
          });
          transcriber.current = input.transcript ?? '';
        }
        const inbound: InboundMessage = {
          tenantId: EVAL_TENANT,
          subscriberId: EVAL_SUBSCRIBER,
          text,
          channel: opts.defaultChannel,
          contactName: null,
          locale: null,
          contactToken: channel.tokenOf(EVAL_SUBSCRIBER),
          ...(media ? { media } : {}),
          offering: input.kind === 'message' ? (input.advert_offering ?? null) : null,
          receivedAt: new Date(),
        };

        const turn = await handler.handle(inbound);
        // The response goes out first; the actions it staged follow it
        // (specs/012 § Actions follow the text).
        if (!turn.silent) channel.deliverInline(turn.reply.messages);
        await turn.afterResponse?.();
        await settled();
        outcome = turn.outcome;
        turnReply = turn.reply;
      }

      const results = runner.results.get(step.id) ?? [];
      const last = results.at(-1);
      // A lost race delivers the model's reply later; the turn's own reply was
      // the holding line (ADR-0001). A silence step's reply is the nudge's.
      const reply =
        turnReply === undefined
          ? (last?.reply ?? plainReply([]))
          : outcome === 'deferred' && last
            ? last.reply
            : turnReply;
      const delivered = channel.deliveries.filter(
        (entry): entry is Extract<Delivery, { kind: 'reply' }> =>
          entry.kind === 'reply' &&
          entry.step === step.id &&
          (outcome !== 'deferred' || entry.via === 'outbox'),
      );
      const messages = delivered.flatMap(entry => entry.messages);

      const actions = (await actionsSince(db, seq)).map(action => ({ ...action, step: step.id }));
      seq = await lastSeq(db);
      run.actions.push(...actions);

      const modelError =
        results.find(result => result.modelError)?.modelError ?? runner.thrown.get(step.id);
      const executionError =
        modelError !== undefined
          ? `model error: ${modelError}`
          : input.kind === 'silence' && nudgeFailures.length > 0
            ? `nudge error: ${nudgeFailures.join(', ')}`
            : outcome === 'error'
              ? 'the turn failed and escalated'
              : outcome === 'deferred' && last === undefined
                ? 'the deferred model call did not complete'
                : undefined;

      run.steps.push({
        id: step.id,
        input,
        outcome,
        reply,
        messages,
        replies: delivered.length,
        nudge,
        clockMs: clock.elapsedMs,
        actions,
        state: await stateOf(db, channel, tools),
        // A nudge has no race, so no latency to hold against the deadline.
        latencyMs: input.kind === 'silence' ? undefined : last?.latencyMs,
        costUsd: results.reduce((sum, result) => sum + result.usage.costUsd, 0),
        interventions: results.flatMap(result => result.interventions),
        executionError,
      });

      // An infrastructure failure never passes a behaviour test, even when its
      // fallback escalation looks like an expected handoff (specs/043 § A
      // failed conversation continues until a terminal event). A nudge that
      // escalates is suppressed, not handed off: the script goes on.
      if (executionError !== undefined) {
        run.terminal = 'error';
        run.executionError = `${step.id}: ${executionError}`;
      } else if (input.kind !== 'silence' && reply.escalate) {
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
 * The contact says nothing for `ms`. The clock moves to each nudge as it
 * comes due, the worker runs it and its reply settles, and then the rest of
 * the silence passes. No nudge is made up: with none pending, nothing runs
 * (specs/043 § Scripts supply contact messages).
 */
async function silence(
  ms: number,
  deps: {
    db: Database;
    clock: VirtualClock;
    nudger: NudgeWorker;
    settled: () => Promise<number>;
  },
): Promise<NudgeResult[]> {
  const results: NudgeResult[] = [];
  let remaining = ms;
  for (let ran = 0; ran < MAX_NUDGES_PER_SILENCE; ran++) {
    const [next] = await deps.db
      .select({ due: min(nudges.dueAt) })
      .from(nudges)
      .where(eq(nudges.status, 'pending'));
    const due = next?.due ? new Date(next.due).getTime() : undefined;
    if (due === undefined) break;
    const wait = Math.max(due - Date.now(), 0) + 1;
    if (wait > remaining) break;
    await deps.clock.advance(wait);
    remaining -= wait;
    results.push(...(await deps.nudger.drainOnce()));
    remaining -= await deps.settled();
  }
  await deps.clock.advance(Math.max(remaining, 0));
  return results;
}

/**
 * Waits for everything the turn left running: its deferred reply recorded,
 * then every queued reply delivered. A reply held for a playing flow is due
 * later; the clock moves to it rather than waiting (specs/043). Resolves to
 * how far it moved the clock.
 */
async function settle(deps: {
  lanes: TurnLanes;
  worker: OutboxWorker;
  db: Database;
  clock: VirtualClock;
}): Promise<number> {
  // The contact's lane frees once the turn's background work has settled.
  const slot = deps.lanes.enter(`${EVAL_TENANT}:${EVAL_SUBSCRIBER}`);
  const ready = await slot.ready;
  slot.leave();
  if (ready === 'expired') throw new Error('the turn did not settle within the model abort bound');

  let moved = 0;
  const deadline = Date.now() + SETTLE_LIMIT_MS;
  for (;;) {
    const drained = await deps.worker.drainOnce();
    if (drained.claimed > 0) continue;
    const [pending] = await deps.db
      .select({ due: min(outbox.nextAttemptAt), count: sql<number>`count(*)::int` })
      .from(outbox)
      .where(and(eq(outbox.status, 'pending'), eq(outbox.kind, 'reply')));
    if (!pending || pending.count === 0) return moved;
    if (Date.now() > deadline) throw new Error('queued replies did not drain');
    const wait = pending.due ? new Date(pending.due).getTime() - Date.now() : 0;
    if (wait > 0) {
      await deps.clock.advance(wait + 1);
      moved += wait + 1;
    } else {
      // Due, and claimed by nothing yet: the row is still being written.
      await pause(25);
    }
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
  const [pending] = await db
    .select({ dueAt: nudges.dueAt, scheduledAt: nudges.scheduledAt })
    .from(nudges)
    .where(eq(nudges.status, 'pending'));
  let pendingNudge: string | null = null;
  if (pending) {
    const minutes = Math.round(
      (new Date(pending.dueAt).getTime() - new Date(pending.scheduledAt).getTime()) / 60_000,
    );
    pendingNudge =
      tools.nudge?.delays.find(delay => delay.minutes === minutes)?.id ?? `${minutes}m`;
  }
  return { fields, tags, offering: row?.offering ?? null, pendingNudge };
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
