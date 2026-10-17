import type { AgentRunner, AgentTurnInput } from '../agent/runner.ts';
import { escalationReply } from '../agent/guardrails.ts';
import type { InboundMedia, MediaKind } from '../contracts/agent.ts';
import type { Rules } from '../contracts/config.ts';
import type { BudgetGuard } from '../conversation/budget.ts';
import { checkKeywords } from '../conversation/budget.ts';
import type { ConversationStore } from '../conversation/store.ts';
import { MediaFailure } from '../media/port.ts';
import type { MediaResolver } from '../media/resolver.ts';
import type { Completion } from './completion.ts';
import type { TurnLogger } from './logger.ts';
import { plainReply } from './replies.ts';

/**
 * What a media turn is recorded as until, and unless, it has a transcript.
 * Never the URL: it opens the contact's file for good (specs/020).
 */
const MEDIA_MARKERS: Record<MediaKind, string> = {
  audio: '[voice note]',
  image: '[image]',
  video: '[video]',
  unsupported: '[media]',
};

export function mediaMarker(kind: MediaKind): string {
  return MEDIA_MARKERS[kind];
}

export interface MediaReaderDeps {
  runner: AgentRunner;
  rules: Rules;
  store: ConversationStore;
  budget: BudgetGuard;
  /** Reads voice notes, images and videos (specs/020). Without it, all take the fallback. */
  resolver?: MediaResolver | undefined;
}

/** The turn a media message belongs to, and what its model call is given. */
export interface MediaTurn {
  userTurnId: string;
  tenantId: string;
  logger: TurnLogger;
  /**
   * Everything the model call takes but the words, which the media supplies.
   * Its signal bounds the download and transcription too.
   */
  input: Omit<AgentTurnInput, 'text' | 'media'> & { signal: AbortSignal };
}

/**
 * The media half of a turn (specs/020): download, split and transcribe, then
 * the keyword check the transcript makes possible, then the model. Runs inside
 * the race, on the model's abort signal (specs/020 § Download and
 * transcription run inside the race).
 */
export class MediaReader {
  private readonly deps: MediaReaderDeps;

  constructor(deps: MediaReaderDeps) {
    this.deps = deps;
  }

  async read(media: InboundMedia, turn: MediaTurn): Promise<Completion> {
    const { rules, resolver } = this.deps;
    const { logger, input } = turn;

    let resolved;
    try {
      resolved = resolver
        ? await resolver.resolve(media, input.signal)
        : ({ status: 'fallback', reason: 'unsupported', costUsd: 0 } as const);
    } catch (error) {
      // A failed download, transcription or frame extraction is not something
      // the contact can fix, and asking them to type would blame them for it.
      // The message names the step, never the URL.
      logger.error(
        {
          media: media.kind,
          reason: error instanceof MediaFailure ? error.reason : 'unknown',
          err: error instanceof Error ? error.message : String(error),
        },
        'media unreadable',
      );
      return {
        kind: 'decided',
        reply: escalationReply('low_confidence', rules.messages.escalation),
        outcome: 'error',
      };
    }

    // Owed whatever happens next: an empty transcript was still transcribed.
    if (resolved.costUsd > 0) {
      await this.deps.budget.recordSpend(turn.tenantId, 0, resolved.costUsd);
    }

    if (resolved.status === 'fallback') {
      logger.info({ media: media.kind, reason: resolved.reason }, 'media fallback');
      return this.fallback();
    }

    const { transcript, images } = resolved;
    if (transcript !== null) {
      // From here the transcript is the contact's message, as if typed: it
      // enters history, and it is matched against the keywords.
      await this.deps.store.replaceUserMessage(turn.userTurnId, transcript);
      const keyword = checkKeywords(transcript, rules);
      if (!keyword.allowed) {
        logger.info(
          { reason: keyword.reason, detail: keyword.detail },
          'turn escalated before model',
        );
        return {
          kind: 'decided',
          reply: escalationReply(keyword.reason, rules.messages.escalation),
          outcome: 'escalated_precheck',
        };
      }
    }

    logger.info(
      { media: media.kind, images: images.length, transcript: transcript !== null },
      'media read',
    );
    const result = await this.deps.runner.run({
      ...input,
      text: transcript ?? '',
      media: {
        // `unsupported` never resolves; it always takes the fallback above.
        kind: media.kind as 'audio' | 'image' | 'video',
        images,
        transcript: transcript !== null,
      },
    });
    return { kind: 'model', result };
  }

  /**
   * The tenant's "please type it" reply, or a handoff when the tenant has not
   * written one: a contact who cannot be asked to type goes to a person (C6).
   */
  private fallback(): Completion {
    const { messages } = this.deps.rules;
    if (!messages.mediaFallback) {
      return {
        kind: 'decided',
        reply: escalationReply('out_of_scope', messages.escalation),
        outcome: 'escalated_precheck',
      };
    }
    return {
      kind: 'decided',
      // Tenant copy that already asks what it needs to.
      reply: plainReply([messages.mediaFallback]),
      outcome: 'media_fallback',
    };
  }
}
