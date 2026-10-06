import { generateText, isStepCount, Output, type LanguageModel, type ModelMessage } from 'ai';
import { AgentReplyForModel, type ActionRecord, type AgentReply } from '../contracts/agent.ts';
import type { TenantConfig } from '../config/loader.ts';
import { NO_TOOLS, offersTools } from '../contracts/config.ts';
import type { MediaImage } from '../media/port.ts';
import {
  actionsNote,
  buildSystemPrompt,
  courseNotice,
  fenceUserText,
  funnelNotice,
  mediaNotice,
  intentNotice,
  nudgeNotice,
  stagedNotice,
} from './prompt.ts';
import { applyGuardrails, escalationReply } from './guardrails.ts';
import type { EscalationCause } from './guardrails.ts';
import type { ContactReads } from './contact.ts';
import type { FlowSends } from './flows.ts';
import { estimateCostUsd, supportsTemperature } from './registry.ts';
import {
  ActionStage,
  buildTools,
  courseField,
  funnelField,
  intentField,
  MAX_STEPS,
  openingFlow,
  stagesProspect,
} from './tools.ts';
import type { ContactActions } from './tools.ts';
import type { Plugins } from '../plugins/plugins.ts';
import { renderPlaybook } from '../learning/playbook.ts';
import type { ActivePlaybook } from '../learning/playbook.ts';

export interface AgentUsage {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  cacheReadTokens: number | undefined;
  costUsd: number;
}

export interface AgentResult {
  reply: AgentReply;
  usage: AgentUsage;
  interventions: string[];
  /**
   * The error name when the call failed and `reply` is the fail-closed
   * fallback, absent when the model actually answered.
   *
   * Without it a failed call is indistinguishable from a model that chose to
   * escalate: both carry `escalate: true` and the same tenant message, so the
   * turn was recorded as `escalated_model` and the only clue left was that
   * usage came back undefined.
   */
  modelError?: string;
  latencyMs: number;
  /**
   * The `provider:model` spec that produced this turn. Recorded per turn
   * because the active model is a runtime string (ADR-0002) — without it,
   * spend cannot be attributed after a model switch.
   */
  model: string;
  /**
   * Whether any tool was offered, so the turn can record "no tools" (null)
   * apart from "tools offered, none chosen" (specs/012). What was staged is
   * on the `ActionStage` the caller passed in. Absent means none were.
   */
  toolsOffered?: boolean;
  /**
   * What made `reply` an escalation, when it is one: the model, the
   * confidence threshold, or a failure. Decides whether an `onEscalation`
   * note is still written (specs/024).
   */
  escalatedBy?: EscalationCause | undefined;
  /**
   * The playbook version the prompt was built with, null when none was
   * active (specs/031). Recorded on the turn.
   */
  playbookVersion?: string | null;
}

/** What the contact sent when it was not typed, as the model receives it (specs/020). */
export interface TurnMedia {
  kind: 'audio' | 'image' | 'video';
  /** A photo, or still frames from a video. Sent this turn only, never kept. */
  images: MediaImage[];
  /** Whether `text` is a transcript of what the contact said. */
  transcript: boolean;
}

/** A turn of history. An agent turn carries what the server did on it (specs/012). */
export interface HistoryTurn {
  role: 'user' | 'agent';
  text: string;
  actions?: ActionRecord[] | null | undefined;
}

export interface AgentTurnInput {
  /** The contact's message, or a transcript of it. Empty for an image alone. */
  text: string;
  history: HistoryTurn[];
  signal?: AbortSignal | undefined;
  media?: TurnMedia | undefined;
  /**
   * Where the tools record what they stage. Owned by the caller, so it still
   * knows what was staged when the call is aborted and never returns.
   */
  stage?: ActionStage | undefined;
  /**
   * What was already done for this contact: the flows sent and the stage of
   * the sale (specs/023). Absent, the contact is treated as new.
   */
  contact?: ContactActions | undefined;
  /**
   * The turn's reads of its own contact. Absent, `get_contact` is not offered:
   * a turn without the contact's token never reads their record (specs/024).
   */
  reads?: ContactReads | undefined;
  /**
   * Sends a flow when the model calls it, so the reply follows it (specs/029).
   * Absent, flows are staged and sent after the reply, as every write is.
   */
  flows?: FlowSends | undefined;
  /** Sends the opening before the turn's first flow, on the prospect turn (specs/034). */
  beforeFlow?: (() => Promise<void>) | undefined;
  /**
   * Set on a nudge turn: no contact wrote, and the model decides whether to
   * follow up on silence since this time (specs/025). `text` is then unused.
   */
  nudge?: { since: Date } | undefined;
}

/**
 * An earlier turn as the model reads it. An agent turn is followed by the
 * server's note of what it performed, written from the `actions` column and
 * never from the model's own text. Outside the fence: it is the system's
 * account, not the contact's (C4).
 */
function historyMessage(turn: HistoryTurn): ModelMessage {
  if (turn.role === 'user') return { role: 'user', content: fenceUserText(turn.text) };
  const note = actionsNote(turn.actions);
  if (note === null) return { role: 'assistant', content: turn.text };
  return {
    role: 'assistant',
    content: [
      { type: 'text', text: turn.text },
      { type: 'text', text: note },
    ],
  };
}

/**
 * The turn's own message. A media turn adds a note saying what the model
 * received, and the images as bytes: never a URL, which some providers would
 * fetch themselves and all would keep in their logs. A tenant with a funnel
 * adds a note of the contact's stage (specs/023), and one with a course field
 * a note of their course (specs/028).
 */
function currentMessage(
  text: string,
  media: TurnMedia | undefined,
  contactNotices: string[],
): ModelMessage {
  if (!media && contactNotices.length === 0) return { role: 'user', content: fenceUserText(text) };
  const notices = [
    ...contactNotices,
    ...(media
      ? [
          mediaNotice({
            kind: media.kind,
            frames: media.images.length,
            transcript: media.transcript,
          }),
        ]
      : []),
  ];
  return {
    role: 'user',
    content: [
      ...notices.map(notice => ({ type: 'text' as const, text: notice })),
      // `file` with an image type: the SDK deprecated `image` parts and warns
      // on every request that sends one.
      ...(media?.images ?? []).map(image => ({
        type: 'file' as const,
        data: image.data,
        mediaType: image.mediaType,
      })),
      ...(text.length > 0 ? [{ type: 'text' as const, text: fenceUserText(text) }] : []),
    ],
  };
}

/**
 * A nudge turn's message: the server's trigger note, after the funnel and
 * course notes if there are any. All of it is the system's, so none of it is
 * fenced (C4).
 */
function nudgeMessage(since: Date, contactNotices: string[]): ModelMessage {
  return {
    role: 'user',
    content: [...contactNotices, nudgeNotice(since)].map(text => ({
      type: 'text' as const,
      text,
    })),
  };
}

/**
 * The port every caller depends on. Implemented with `generateText`: a single
 * step when the tenant configures no tools, and a loop of at most four when it
 * does (ADR-0010, ADR-0016).
 */
export interface AgentRunner {
  run(input: AgentTurnInput): Promise<AgentResult>;
}

export interface RunnerOptions {
  model: LanguageModel;
  modelSpec: string;
  /**
   * Read per turn rather than captured, so a SIGHUP reload reaches the prompt.
   * Passing the values directly froze the persona and catalog for the life of
   * the process: `rules` reloaded because turn.ts re-reads them, but the system
   * prompt did not, so prompt edits silently needed a restart (specs/003).
   */
  config: () => TenantConfig;
  maxOutputTokens: number;
  temperature: number;
  /** Reasoning models only; omitted from the request when unset. */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | undefined;
  /**
   * Records prompts and completions in telemetry spans. Off by default: spans
   * would otherwise carry the contact's message text verbatim, which is exactly
   * what Constitution C5 forbids. Enable only against a trusted collector.
   */
  recordPromptsInTraces?: boolean;
  /** The tenant's plugin tools, loaded once at boot (specs/036). */
  plugins?: Plugins | undefined;
  /**
   * The active playbook version, read per turn and never waited on: its
   * source refreshes on a timer (specs/031).
   */
  playbook?: { current(): ActivePlaybook | undefined } | undefined;
}

export class GenerateTextRunner implements AgentRunner {
  private readonly opts: RunnerOptions;
  private cached:
    | {
        config: TenantConfig;
        /** The version the source held when this was built, rendered or not. */
        loadedPlaybook: string | undefined;
        playbook: ActivePlaybook | undefined;
        staticPrefix: string;
        catalogBlock: string;
        withTools: boolean;
      }
    | undefined;

  constructor(opts: RunnerOptions) {
    this.opts = opts;
  }

  /**
   * Rebuilds only when ConfigStore swaps in a new object, so the prefix stays
   * byte-identical between reloads and remains cacheable (see prompt.ts). A
   * failed reload keeps the previous object, so it correctly rebuilds nothing.
   * An activated playbook version rebuilds it once, not on every turn.
   */
  private current() {
    const config = this.opts.config();
    const playbook = this.opts.playbook?.current();
    if (this.cached?.config !== config || this.cached.loadedPlaybook !== playbook?.id) {
      const tools = config.tools ?? NO_TOOLS;
      const pluginTools = this.opts.plugins?.hasTools ?? false;
      const withTools = offersTools(tools) || pluginTools;
      const prompt = buildSystemPrompt(config.persona, config.catalog, config.rules, tools, {
        pluginTools,
      });
      // After the catalog and before the cache breakpoint, so a version is
      // cached with the rest of the prefix (specs/031). Without `learning`
      // the prefix is what it was before that spec.
      const rendered = config.rules.learning ? renderPlaybook(playbook) : undefined;
      this.cached = {
        config,
        loadedPlaybook: playbook?.id,
        playbook: rendered ? playbook : undefined,
        withTools,
        staticPrefix: prompt.staticPrefix,
        catalogBlock: rendered ? `${prompt.catalogBlock}\n\n${rendered}` : prompt.catalogBlock,
      };
    }
    return this.cached;
  }

  async run({
    text,
    history,
    signal,
    media,
    stage = new ActionStage(),
    contact,
    reads,
    flows,
    beforeFlow,
    nudge,
  }: AgentTurnInput): Promise<AgentResult> {
    const started = Date.now();
    // Resolved once per turn: a reload landing mid-turn must not produce a
    // reply built from one config and guarded by another.
    const { config, playbook, staticPrefix, catalogBlock, withTools } = this.current();
    const playbookVersion = playbook?.id ?? null;
    const tools = withTools
      ? buildTools(config.tools ?? NO_TOOLS, stage, contact, reads, {
          nudgeTurn: nudge !== undefined,
          flows,
          beforeFlow,
          plugins: this.opts.plugins,
        })
      : undefined;
    // The opening is no longer known before the loop runs: the prospect write
    // that queues it says so, and the reply step is told below (specs/034).
    const opening = contact?.openingDue ? openingFlow(config.tools ?? NO_TOOLS) : undefined;
    const contactNotices = [
      ...(intentField(config.tools ?? NO_TOOLS)
        ? [intentNotice(contact?.intent, contact?.advertCourse)]
        : []),
      ...(funnelField(config.tools ?? NO_TOOLS) ? [funnelNotice(contact?.funnelStage)] : []),
      ...(courseField(config.tools ?? NO_TOOLS)
        ? [courseNotice(contact?.course, contact?.courseChangedFrom)]
        : []),
    ];

    const messages: ModelMessage[] = [
      ...history.map(historyMessage),
      nudge
        ? nudgeMessage(nudge.since, contactNotices)
        : currentMessage(text, media, contactNotices),
    ];

    // The last step offers no tools, so it must produce the reply. It sees a
    // note of what was staged, and of the last contact read, in place of its
    // own tool calls: a provider that drops its tools when told to use none
    // would otherwise receive tool calls with no tools to match them
    // (specs/024 § The loop grows to four steps and eight actions).
    const loop = tools
      ? {
          tools,
          stopWhen: isStepCount(MAX_STEPS),
          prepareStep: ({ stepNumber }: { stepNumber: number }) =>
            stepNumber === MAX_STEPS - 1
              ? {
                  activeTools: [],
                  messages: [
                    ...messages,
                    {
                      role: 'user' as const,
                      content: stagedNotice(
                        stage,
                        reads?.latest,
                        opening && stagesProspect(stage, config.tools ?? NO_TOOLS)
                          ? opening
                          : undefined,
                      ),
                    },
                  ],
                }
              : undefined,
        }
      : {};

    const outputSpec = Output.object({ schema: AgentReplyForModel });
    let output: unknown;
    let usage: Omit<AgentUsage, 'costUsd'>;
    try {
      const result = await generateText({
        model: this.opts.model,
        output: outputSpec,
        system: `${staticPrefix}\n\n${catalogBlock}`,
        messages,
        maxOutputTokens: this.opts.maxOutputTokens,
        ...(supportsTemperature(this.opts.modelSpec) ? { temperature: this.opts.temperature } : {}),
        telemetry: {
          functionId: 'agent-turn',
          recordInputs: this.opts.recordPromptsInTraces ?? false,
          recordOutputs: this.opts.recordPromptsInTraces ?? false,
        },
        ...(signal ? { abortSignal: signal } : {}),
        providerOptions: {
          anthropic: { cacheControl: { type: 'ephemeral' } },
          ...(this.opts.reasoningEffort
            ? { openai: { reasoningEffort: this.opts.reasoningEffort } }
            : {}),
        },
        ...loop,
      });
      // Read inside the try: a loop whose last step produced no reply throws
      // here, and fails closed exactly as a schema failure does.
      output = result.output;
      usage = {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheReadTokens: result.usage.inputTokenDetails.cacheReadTokens,
      };
    } catch (error) {
      // generateText validates against the output schema and throws when the
      // model does not comply, so this is the common failure, not an exotic one.
      // An abort (race deadline) is rethrown so the caller can tell "too slow"
      // apart from "model misbehaved"; everything else fails closed to a human
      // (Constitution C6).
      if (error instanceof Error && error.name === 'AbortError') throw error;
      if (signal?.aborted) throw error;
      const name = error instanceof Error ? error.name : 'unknown';
      return {
        reply: escalationReply('low_confidence', config.rules.messages.escalation),
        interventions: [`model_error: ${name}`],
        modelError: name,
        escalatedBy: 'error',
        playbookVersion,
        latencyMs: Date.now() - started,
        model: this.opts.modelSpec,
        toolsOffered: tools !== undefined,
        usage: {
          inputTokens: undefined,
          outputTokens: undefined,
          cacheReadTokens: undefined,
          costUsd: 0,
        },
      };
    }

    const earlierReplies = history.filter(turn => turn.role === 'agent').map(turn => turn.text);
    const guarded = applyGuardrails(output, config.rules, earlierReplies);

    return {
      reply: guarded.reply,
      interventions: guarded.interventions,
      escalatedBy: guarded.escalatedBy,
      playbookVersion,
      latencyMs: Date.now() - started,
      model: this.opts.modelSpec,
      toolsOffered: tools !== undefined,
      usage: { ...usage, costUsd: estimateCostUsd(this.opts.modelSpec, usage) },
    };
  }
}
