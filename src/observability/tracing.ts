/**
 * Turn traces in the tenant's own LangSmith workspace (specs/052, ADR-0028,
 * ADR-0029). A live trace is built from an allowlist: what leaves the process
 * is a projection written here, field by field, so a field a library adds is
 * dropped too. Only an eval on the fixture tenant traces with text.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CallbackManager } from '@langchain/core/callbacks/manager';
import type { CallbackManagerForChainRun, Callbacks } from '@langchain/core/callbacks/manager';
import type { Serialized } from '@langchain/core/load/serializable';
import { BaseTracer } from '@langchain/core/tracers/base';
import type { Run } from '@langchain/core/tracers/base';
import type { TurnOutcome } from '../contracts/agent.ts';

/** Uploads waiting at most: past it the oldest is dropped (specs/052, chosen 2026-10-30). */
export const TRACE_QUEUE_LIMIT = 1000;
/** How long an upload waits for more runs to join it. */
const FLUSH_DELAY_MS = 250;
/** The most runs one request carries. */
const BATCH_LIMIT = 100;
/** One upload's bound, the 10 s every other outbound call outside the race has (specs/022). */
const UPLOAD_TIMEOUT_MS = 10_000;

/** Metadata a live run may carry; every other key is dropped (specs/052). */
const METADATA_ALLOWLIST = [
  'conversation',
  'turn_kind',
  'langgraph_step',
  'langgraph_node',
  'ls_provider',
  'ls_model_name',
  'ls_max_tokens',
  'ls_temperature',
] as const;

/** A tool name the model made up is model output, and is never uploaded as such. */
export const UNKNOWN_TOOL = 'unknown_tool';

/** The name of a turn's root run. */
export const TURN_RUN = 'turn';

export interface TraceLogger {
  warn: (o: object, m: string) => void;
}

export type TurnKind = 'inbound' | 'nudge';

/** A run as `/runs/batch` takes it, after the projection. */
export interface ProjectedRun {
  id: string;
  name: string;
  run_type: string;
  start_time: string;
  end_time?: string | undefined;
  parent_run_id?: string | undefined;
  trace_id?: string | undefined;
  dotted_order?: string | undefined;
  session_name: string;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  extra: { metadata: Record<string, unknown> };
  error?: string | undefined;
}

/** How a run is projected: what the turn offered, and whether text may leave. */
export interface Projection {
  project: string;
  /** The tool names the turn was offered: any other name is `unknown_tool`. */
  offered: ReadonlySet<string>;
  /** An eval on the fixture tenant only (§ Eval runs on the fixture tenant …). */
  fullText: boolean;
  /** The class of the error the run ended with, read before it became a string. */
  errorClass?: string | undefined;
}

/** An error's class name: never its message, which can echo the request (C5). */
export function errorClass(error: unknown): string {
  if (error instanceof Error) return error.name || error.constructor.name || 'Error';
  return 'Error';
}

const iso = (time: number | undefined) =>
  time === undefined ? undefined : new Date(time).toISOString();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** A model run's token counts, summed over its generations; `{}` when it reports none. */
function tokenCounts(outputs: unknown): Record<string, unknown> {
  const generations = isRecord(outputs) ? outputs.generations : undefined;
  if (!Array.isArray(generations)) return {};
  const counts = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  let reported = false;
  for (const generation of generations.flat()) {
    const message: unknown = isRecord(generation) ? generation.message : undefined;
    const usage: unknown = isRecord(message) ? message.usage_metadata : undefined;
    if (!isRecord(usage)) continue;
    for (const key of ['input_tokens', 'output_tokens', 'total_tokens'] as const) {
      const value = usage[key];
      if (typeof value === 'number') {
        counts[key] += value;
        reported = true;
      }
    }
  }
  return reported ? { usage_metadata: counts } : {};
}

/** The tools node's calls, in order, by name only: never an argument or a result. */
function toolNames(outputs: unknown, offered: ReadonlySet<string>): Record<string, unknown> {
  const steps = isRecord(outputs) ? outputs.steps : undefined;
  if (!Array.isArray(steps)) return { tools: [] };
  const names = steps.flatMap(step => {
    const name: unknown = isRecord(step) ? step.name : undefined;
    if (typeof name !== 'string') return [];
    return [offered.has(name) ? name : UNKNOWN_TOOL];
  });
  return { tools: names };
}

function allowedMetadata(metadata: unknown): Record<string, unknown> {
  if (!isRecord(metadata)) return {};
  const kept: Record<string, unknown> = {};
  for (const key of METADATA_ALLOWLIST) {
    const value = metadata[key];
    if (typeof value === 'string' || typeof value === 'number') kept[key] = value;
  }
  return kept;
}

/** A plain copy for a fixture eval's full trace; `{}` for what will not serialize. */
function plain(value: unknown): Record<string, unknown> {
  try {
    const copy: unknown = JSON.parse(JSON.stringify(value ?? {}));
    return isRecord(copy) ? copy : { value: copy };
  } catch {
    return {};
  }
}

/**
 * A run as it may leave the process (specs/052 § A live trace carries no input
 * and no output). Live: no inputs; outputs only a model run's token counts or
 * the tools node's tool names; allowlisted metadata; an error by its class.
 */
export function projectRun(run: Run, projection: Projection): ProjectedRun {
  const metadata: unknown = run.extra?.metadata;
  const base = {
    id: run.id,
    name: run.name,
    run_type: run.run_type,
    start_time: iso(run.start_time) ?? new Date().toISOString(),
    end_time: iso(run.end_time),
    parent_run_id: run.parent_run_id,
    trace_id: run.trace_id,
    dotted_order: run.dotted_order,
    session_name: projection.project,
  };
  if (projection.fullText) {
    return {
      ...base,
      inputs: plain(run.inputs),
      outputs: plain(run.outputs),
      extra: { metadata: plain(metadata) },
      error: run.error,
    };
  }
  const node = isRecord(metadata) ? metadata.langgraph_node : undefined;
  const outputs =
    run.run_type === 'llm'
      ? tokenCounts(run.outputs)
      : run.name === 'tools' && node === 'tools'
        ? toolNames(run.outputs, projection.offered)
        : {};
  return {
    ...base,
    inputs: {},
    outputs,
    extra: { metadata: allowedMetadata(metadata) },
    error: run.error === undefined ? undefined : (projection.errorClass ?? 'Error'),
  };
}

type Upload =
  | { kind: 'run'; run: ProjectedRun }
  | { kind: 'feedback'; feedback: { run_id: string; key: string; value: string } };

export interface TraceUploaderOptions {
  endpoint: string;
  apiKey: string;
  logger: TraceLogger;
  /** The HTTP boundary; tests fake it (specs/004). */
  fetch?: typeof fetch;
  limit?: number;
  flushDelayMs?: number;
}

/**
 * Sends projected runs and outcome feedback in the background (ADR-0029).
 * Nothing awaits it inside a turn; a failed upload is logged once, by class
 * and status, and dropped, never retried (specs/052 § The uploader never
 * holds a turn, C6, C7).
 */
export class TraceUploader {
  private readonly opts: Required<Omit<TraceUploaderOptions, 'fetch'>> & { fetch: typeof fetch };
  private readonly queue: Upload[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushing: Promise<void> | undefined;
  private overflowed = false;
  private closed = false;

  constructor(opts: TraceUploaderOptions) {
    this.opts = {
      endpoint: opts.endpoint.replace(/\/+$/, ''),
      apiKey: opts.apiKey,
      logger: opts.logger,
      fetch: opts.fetch ?? globalThis.fetch.bind(globalThis),
      limit: opts.limit ?? TRACE_QUEUE_LIMIT,
      flushDelayMs: opts.flushDelayMs ?? FLUSH_DELAY_MS,
    };
  }

  run(run: ProjectedRun): void {
    this.enqueue({ kind: 'run', run });
  }

  feedback(runId: string, key: string, value: string): void {
    this.enqueue({ kind: 'feedback', feedback: { run_id: runId, key, value } });
  }

  /** Sends what is queued now, once, and stops scheduling: for shutdown. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.flush();
  }

  /** Sends what is queued, in order. Resolves when the queue is empty. */
  async flush(): Promise<void> {
    this.flushing ??= this.drain().finally(() => {
      this.flushing = undefined;
      if (this.queue.length > 0) this.schedule();
    });
    return this.flushing;
  }

  private enqueue(upload: Upload): void {
    if (this.queue.length >= this.opts.limit) {
      this.queue.shift();
      if (!this.overflowed) {
        this.opts.logger.warn({ limit: this.opts.limit }, 'trace queue full; dropping the oldest');
        this.overflowed = true;
      }
    }
    this.queue.push(upload);
    this.schedule();
  }

  private schedule(): void {
    if (this.timer || this.flushing || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.opts.flushDelayMs);
    this.timer.unref?.();
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const first = this.queue[0]!;
      if (first.kind === 'feedback') {
        this.queue.shift();
        await this.send('/feedback', first.feedback);
        continue;
      }
      const runs: ProjectedRun[] = [];
      while (runs.length < BATCH_LIMIT && this.queue[0]?.kind === 'run') {
        runs.push((this.queue.shift() as Extract<Upload, { kind: 'run' }>).run);
      }
      await this.send('/runs/batch', { post: runs, patch: [] });
    }
    this.overflowed = false;
  }

  private async send(path: string, body: unknown): Promise<void> {
    try {
      const response = await this.opts.fetch(`${this.opts.endpoint}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': this.opts.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.opts.logger.warn({ path, status: response.status }, 'trace upload failed; dropped');
      }
    } catch (error) {
      this.opts.logger.warn({ path, err: errorClass(error) }, 'trace upload failed; dropped');
    }
  }
}

/** Hands each finished run of one turn to its trace, with the class of its error. */
class TurnTracer extends BaseTracer {
  name = 'turn_tracer';
  private readonly trace: TurnTrace;
  private readonly errors = new Map<string, string>();

  constructor(trace: TurnTrace) {
    super();
    this.trace = trace;
  }

  protected persistRun(): Promise<void> {
    return Promise.resolve();
  }

  override onRunUpdate(run: Run): void {
    const failure = this.errors.get(run.id);
    this.errors.delete(run.id);
    this.trace.ended(run, failure);
  }

  override handleChainError(
    ...args: Parameters<BaseTracer['handleChainError']>
  ): ReturnType<BaseTracer['handleChainError']> {
    this.errors.set(args[1], errorClass(args[0]));
    return super.handleChainError(...args);
  }

  override handleLLMError(
    ...args: Parameters<BaseTracer['handleLLMError']>
  ): ReturnType<BaseTracer['handleLLMError']> {
    this.errors.set(args[1], errorClass(args[0]));
    return super.handleLLMError(...args);
  }

  override handleToolError(
    ...args: Parameters<BaseTracer['handleToolError']>
  ): ReturnType<BaseTracer['handleToolError']> {
    this.errors.set(args[1], errorClass(args[0]));
    return super.handleToolError(...args);
  }
}

const TURN_SERIALIZED = { lc: 1, type: 'not_implemented', id: [TURN_RUN] } as Serialized;

/**
 * One turn's trace: one root run named `turn`, opened when the runner starts
 * and closed when it returns, with the graph and any rewrite inside it, and
 * one `outcome` feedback once the turn is recorded (specs/052 § One traced
 * turn is one root run, § How the turn ended is feedback …).
 */
export class TurnTrace {
  /** The root run's ID, set here rather than by LangChain, so feedback can name it. */
  readonly rootId = randomUUID();
  private readonly uploader: TraceUploader;
  private readonly metadata: { conversation: string; turn_kind: TurnKind };
  private readonly projection: Omit<Projection, 'offered' | 'errorClass'>;
  private offered: ReadonlySet<string> = new Set();
  private root: CallbackManagerForChainRun | undefined;
  private rootEnded = false;
  private outcomeValue: TurnOutcome | undefined;
  private outcomeSent = false;

  constructor(
    uploader: TraceUploader,
    context: { conversation: string; kind: TurnKind },
    projection: Omit<Projection, 'offered' | 'errorClass'>,
  ) {
    this.uploader = uploader;
    this.metadata = { conversation: context.conversation, turn_kind: context.kind };
    this.projection = projection;
  }

  /** Opens the root run. Returns the callbacks the turn's model calls run under. */
  async open(tools: readonly string[]): Promise<Callbacks | undefined> {
    this.offered = new Set(tools);
    const manager = CallbackManager.configure(
      [new TurnTracer(this)],
      undefined,
      undefined,
      undefined,
      this.metadata,
    );
    if (!manager) return undefined;
    this.root = await manager.handleChainStart(
      TURN_SERIALIZED,
      {},
      this.rootId,
      undefined,
      undefined,
      undefined,
      TURN_RUN,
    );
    return this.root.getChild();
  }

  /** Closes the root run. Never throws: a trace never changes a turn (C6). */
  async close(error?: unknown): Promise<void> {
    const root = this.root;
    if (!root) return;
    try {
      if (error === undefined) await root.handleChainEnd({});
      else await root.handleChainError(error);
    } catch {
      // The trace is lost; the turn is not.
    }
  }

  /** How the turn ended: sent once, after the root run, and only if it was opened. */
  outcome(outcome: TurnOutcome): void {
    if (!this.root || this.outcomeValue !== undefined) return;
    this.outcomeValue = outcome;
    this.sendOutcome();
  }

  /** A run of this turn finished: projected and queued. */
  ended(run: Run, failure: string | undefined): void {
    this.uploader.run(
      projectRun(run, { ...this.projection, offered: this.offered, errorClass: failure }),
    );
    if (run.id === this.rootId) {
      this.rootEnded = true;
      this.sendOutcome();
    }
  }

  private sendOutcome(): void {
    if (!this.rootEnded || this.outcomeValue === undefined || this.outcomeSent) return;
    this.outcomeSent = true;
    this.uploader.feedback(this.rootId, 'outcome', this.outcomeValue);
  }
}

export interface TracingEnv {
  TRACE_TURNS: 'off' | 'langsmith';
  LANGSMITH_API_KEY?: string | undefined;
  LANGSMITH_PROJECT?: string | undefined;
  LANGSMITH_ENDPOINT: string;
}

/** The process's tracing: one uploader, a trace per turn. */
export class Tracing {
  private readonly uploader: TraceUploader;
  private readonly project: string;
  private readonly fullText: boolean;

  constructor(opts: { uploader: TraceUploader; project: string; fullText?: boolean }) {
    this.uploader = opts.uploader;
    this.project = opts.project;
    this.fullText = opts.fullText ?? false;
  }

  /**
   * Tracing as the environment sets it, or none. The server never passes
   * `fullText`: only an eval on the fixture tenant may (specs/052).
   */
  static fromEnv(
    env: TracingEnv,
    logger: TraceLogger,
    opts: { fullText?: boolean; fetch?: typeof fetch } = {},
  ): Tracing | undefined {
    if (env.TRACE_TURNS !== 'langsmith') return undefined;
    const { LANGSMITH_API_KEY: apiKey, LANGSMITH_PROJECT: project } = env;
    // The schema refuses this combination; checked again so no caller can skip it.
    if (apiKey === undefined || project === undefined) return undefined;
    const uploader = new TraceUploader({
      endpoint: env.LANGSMITH_ENDPOINT,
      apiKey,
      logger,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    return new Tracing({ uploader, project, fullText: opts.fullText ?? false });
  }

  turn(context: { conversation: string; kind: TurnKind }): TurnTrace {
    return new TurnTrace(this.uploader, context, {
      project: this.project,
      fullText: this.fullText,
    });
  }

  /** Sends what is queued, once: on SIGTERM, inside the shutdown already allowed. */
  async close(): Promise<void> {
    await this.uploader.close();
  }
}

/** This package's root, where the fixture tenant and the golden set live. */
const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

function real(path: string): string | undefined {
  return existsSync(path) ? realpathSync(path) : undefined;
}

/**
 * Whether an eval may trace with text: only the fixture tenant on the golden
 * set, by resolved path, so no variable can mark a tenant's config as
 * invented (specs/052 § Eval runs on the fixture tenant are the only traces
 * with text).
 */
export function fixtureEval(configDir: string, evalDir: string, root = PACKAGE_ROOT): boolean {
  const config = real(resolve(configDir));
  const suite = real(resolve(evalDir));
  const fixtureConfig = real(resolve(root, 'test/fixtures/config'));
  const golden = real(resolve(root, 'evals/golden'));
  if (!config || !suite || !fixtureConfig || !golden) return false;
  return config === fixtureConfig && suite === golden;
}
