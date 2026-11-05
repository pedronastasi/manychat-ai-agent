/**
 * Turn traces in the tenant's own LangSmith workspace (specs/052, ADR-0028,
 * ADR-0029). A live trace is built from an allowlist: each run is projected
 * here, field by field, with the turn's context, and the official LangSmith
 * client uploads the projection behind a second allowlist of its own hide
 * functions. Only an eval on the fixture tenant traces with text.
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
import { Client } from 'langsmith';
import type { ClientConfig } from 'langsmith';
import type { TurnOutcome } from '../contracts/agent.ts';

/**
 * The client's upload queue, in bytes: past it the client drops runs. Its own
 * default is 1 GB (specs/052, chosen 2026-11-05). A projected run is a few
 * hundred bytes, so this holds thousands of turns of backlog.
 */
export const TRACE_QUEUE_BYTES = 16 * 1024 * 1024;
/** One upload's bound, the 10 s every other outbound call outside the race has (specs/022). */
const UPLOAD_TIMEOUT_MS = 10_000;
/**
 * The whole shutdown send's bound, whatever is queued: past it the rest is
 * dropped, so a hung endpoint never holds SIGTERM (specs/052, chosen 2026-10-31).
 */
export const SHUTDOWN_SEND_MS = 5_000;

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

/** A run as the client's `createRun` takes it, after the projection. */
export interface ProjectedRun {
  id: string;
  name: string;
  run_type: string;
  start_time: string;
  end_time?: string | undefined;
  parent_run_id?: string | undefined;
  trace_id?: string | undefined;
  dotted_order?: string | undefined;
  project_name: string;
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
    project_name: projection.project,
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

/** An error as the projection leaves it: a class name, and nothing that reads as a sentence. */
const CLASS_NAME = /^[A-Za-z_$][\w$]*$/;

/**
 * The client's own hide functions, a second allowlist behind the projection:
 * whatever reaches the client is cut to the same fields again before it is
 * sent, so a projection bug alone cannot leak text (specs/052).
 */
export function liveHideFunctions(): Pick<
  ClientConfig,
  'hideInputs' | 'hideOutputs' | 'hideMetadata' | 'anonymizer'
> {
  return {
    hideInputs: () => ({}),
    hideOutputs: outputs => {
      const kept: Record<string, unknown> = {};
      const usage: unknown = outputs.usage_metadata;
      if (isRecord(usage)) {
        const counts: Record<string, number> = {};
        for (const key of ['input_tokens', 'output_tokens', 'total_tokens']) {
          const value = usage[key];
          if (typeof value === 'number') counts[key] = value;
        }
        kept.usage_metadata = counts;
      }
      const tools: unknown = outputs.tools;
      if (Array.isArray(tools)) {
        kept.tools = tools.filter((name): name is string => typeof name === 'string');
      }
      return kept;
    },
    hideMetadata: metadata => allowedMetadata(metadata),
    // With the hide functions set, the client calls this for a run's error only.
    anonymizer: values => {
      const error: unknown = values.error;
      return { error: typeof error === 'string' && CLASS_NAME.test(error) ? error : 'Error' };
    },
  };
}

export interface ClientOptions {
  endpoint: string;
  apiKey: string;
  /** An eval on the fixture tenant only: the client then hides nothing. */
  fullText: boolean;
  /** The HTTP boundary; tests fake it (specs/004). */
  fetch?: typeof fetch | undefined;
}

/**
 * The official client, configured in code so no environment variable can
 * change what it sends or where (specs/052, ADR-0029). It uploads in the
 * background, in batches, and never blocks a turn's root run.
 */
export function clientConfig(opts: ClientOptions): ClientConfig {
  return {
    apiUrl: opts.endpoint,
    apiKey: opts.apiKey,
    autoBatchTracing: true,
    blockOnRootRunFinalization: false,
    omitTracedRuntimeInfo: true,
    maxIngestMemoryBytes: TRACE_QUEUE_BYTES,
    timeout_ms: UPLOAD_TIMEOUT_MS,
    // Set here so LANGSMITH_TRACING_MODE, OTEL_ENABLED, LANGSMITH_DEBUG and
    // LANGSMITH_TRACING_SAMPLING_RATE cannot reroute, print or thin the trace.
    tracingMode: 'langsmith',
    debug: false,
    tracingSamplingRate: 1,
    ...(opts.fullText
      ? { hideInputs: false, hideOutputs: false, hideMetadata: false }
      : liveHideFunctions()),
    ...(opts.fetch ? { fetchImplementation: opts.fetch } : {}),
  };
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
  private readonly client: Client;
  private readonly logger: TraceLogger;
  private readonly metadata: { conversation: string; turn_kind: TurnKind };
  private readonly projection: Omit<Projection, 'offered' | 'errorClass'>;
  private offered: ReadonlySet<string> = new Set();
  private root: CallbackManagerForChainRun | undefined;
  /** Settles once the root run is in the client's queue. */
  private rootQueued: Promise<void> | undefined;
  private outcomeValue: TurnOutcome | undefined;
  private outcomeSent = false;

  /** Holds the background outcome send, so a flush or shutdown can wait for it. */
  private readonly track: (work: Promise<void>) => void;

  constructor(
    client: Client,
    logger: TraceLogger,
    context: { conversation: string; kind: TurnKind },
    projection: Omit<Projection, 'offered' | 'errorClass'>,
    track: (work: Promise<void>) => void = () => {},
  ) {
    this.client = client;
    this.logger = logger;
    this.track = track;
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

  /** A run of this turn finished: projected and handed to the client's queue. */
  ended(run: Run, failure: string | undefined): void {
    const projected = projectRun(run, {
      ...this.projection,
      offered: this.offered,
      errorClass: failure,
    });
    // The client reads a key that is present as set, so absent ones stay absent.
    const create = Object.fromEntries(
      Object.entries(projected).filter(([, value]) => value !== undefined),
    ) as Parameters<Client['createRun']>[0];
    const queued = this.client.createRun(create).catch((error: unknown) => {
      this.logger.warn({ err: errorClass(error) }, 'trace run dropped');
    });
    if (run.id === this.rootId) {
      this.rootQueued = queued;
      this.sendOutcome();
    }
  }

  /**
   * After the root run's batch has gone, so the feedback names a run the
   * workspace already holds. In the background: nothing waits on it.
   */
  private sendOutcome(): void {
    const { rootQueued, outcomeValue } = this;
    if (!rootQueued || outcomeValue === undefined || this.outcomeSent) return;
    this.outcomeSent = true;
    this.track(
      (async () => {
        await rootQueued;
        await this.client.awaitPendingTraceBatches();
        await this.client.createFeedback(this.rootId, 'outcome', { value: outcomeValue });
      })().catch((error: unknown) => {
        this.logger.warn({ err: errorClass(error) }, 'trace outcome dropped');
      }),
    );
  }
}

export interface TracingEnv {
  TRACE_TURNS: 'off' | 'langsmith';
  LANGSMITH_API_KEY?: string | undefined;
  LANGSMITH_PROJECT?: string | undefined;
  LANGSMITH_ENDPOINT: string;
}

/** The process's tracing: one LangSmith client, a trace per turn. */
export class Tracing {
  private readonly client: Client;
  private readonly logger: TraceLogger;
  private readonly project: string;
  private readonly fullText: boolean;
  /** Outcome feedback still being sent. */
  private readonly pending = new Set<Promise<void>>();

  constructor(opts: { client: Client; logger: TraceLogger; project: string; fullText?: boolean }) {
    this.client = opts.client;
    this.logger = opts.logger;
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
    const fullText = opts.fullText ?? false;
    const client = new Client(
      clientConfig({ endpoint: env.LANGSMITH_ENDPOINT, apiKey, fullText, fetch: opts.fetch }),
    );
    return new Tracing({ client, logger, project, fullText });
  }

  turn(context: { conversation: string; kind: TurnKind }): TurnTrace {
    return new TurnTrace(
      this.client,
      this.logger,
      context,
      { project: this.project, fullText: this.fullText },
      work => {
        this.pending.add(work);
        void work.finally(() => this.pending.delete(work));
      },
    );
  }

  /** Resolves once the client's queued batches and every outcome feedback have gone. */
  async flush(): Promise<void> {
    await this.client.awaitPendingTraceBatches();
    await Promise.all([...this.pending]);
  }

  /**
   * Waits for the client's queued batches and outcome feedback, for at most
   * `deadlineMs`: on SIGTERM. What has not gone by then is left behind as the
   * process exits.
   */
  async close(deadlineMs = SHUTDOWN_SEND_MS): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'deadline'>(resolve => {
      timer = setTimeout(() => resolve('deadline'), deadlineMs);
      timer.unref?.();
    });
    const sent = this.flush().then(() => 'sent' as const);
    const first = await Promise.race([sent, deadline]).catch(() => 'sent' as const);
    clearTimeout(timer);
    if (first === 'deadline') this.logger.warn({ deadlineMs }, 'trace send cut short at shutdown');
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
