import type { InboundMedia, MediaKind } from '../contracts/agent.ts';
import type { MediaFetcher, MediaImage, Transcriber, VideoSplitter } from './port.ts';

/** Why the contact is asked to type instead (specs/020 § A failure we caused hands off). */
export type FallbackReason =
  | 'unsupported'
  | 'no_transcription_model'
  | 'images_not_accepted'
  | 'no_ffmpeg'
  | 'empty_transcript'
  | 'nothing_readable';

export type ResolvedMedia = {
  /** Transcription spend, owed whatever the turn does next. */
  costUsd: number;
} & (
  | { status: 'fallback'; reason: FallbackReason }
  | {
      status: 'ready';
      /** What was said, when something was; null for an image or a silent video. */
      transcript: string | null;
      images: MediaImage[];
    }
);

export interface MediaResolverOptions {
  fetcher: MediaFetcher;
  /** Null when TRANSCRIPTION_MODEL is unset. */
  transcriber: Transcriber | null;
  /** Null when the server has no ffmpeg. */
  splitter: VideoSplitter | null;
  /** Whether the answering model takes images (registry `acceptsImages`). */
  acceptsImages: boolean;
}

/**
 * Turns a media pointer into what the model can read: a transcript, images, or
 * both for a video (specs/020). A kind it cannot read is decided before any
 * download; a download, transcription or ffmpeg failure throws `MediaFailure`.
 */
export class MediaResolver {
  private readonly opts: MediaResolverOptions;

  constructor(opts: MediaResolverOptions) {
    this.opts = opts;
  }

  private unreadable(kind: MediaKind): FallbackReason | null {
    const { transcriber, splitter, acceptsImages } = this.opts;
    if (kind === 'unsupported') return 'unsupported';
    if (kind === 'audio' && !transcriber) return 'no_transcription_model';
    if (kind === 'image' && !acceptsImages) return 'images_not_accepted';
    if (kind === 'video' && !splitter) return 'no_ffmpeg';
    if (kind === 'video' && !acceptsImages && !transcriber) return 'nothing_readable';
    return null;
  }

  async resolve(media: InboundMedia, signal: AbortSignal): Promise<ResolvedMedia> {
    const unreadable = this.unreadable(media.kind);
    if (unreadable) return { status: 'fallback', reason: unreadable, costUsd: 0 };

    const { bytes, contentType } = await this.opts.fetcher.fetch(media, signal);

    if (media.kind === 'image') {
      return {
        status: 'ready',
        transcript: null,
        images: [{ data: bytes, mediaType: contentType }],
        costUsd: 0,
      };
    }

    if (media.kind === 'audio') {
      const said = await this.opts.transcriber!.transcribe(bytes, signal);
      if (said.text.length === 0) {
        return { status: 'fallback', reason: 'empty_transcript', costUsd: said.costUsd };
      }
      return { status: 'ready', transcript: said.text, images: [], costUsd: said.costUsd };
    }

    // A video: each half degrades on its own (specs/020 § A video is read as
    // still frames and a transcript of its soundtrack).
    const { transcriber, acceptsImages } = this.opts;
    const parts = await this.opts.splitter!.split(
      bytes,
      { frames: acceptsImages, soundtrack: transcriber !== null },
      signal,
    );
    const said =
      parts.soundtrack && transcriber
        ? await transcriber.transcribe(parts.soundtrack, signal)
        : null;
    const transcript = said?.text || null;
    const costUsd = said?.costUsd ?? 0;
    if (parts.frames.length === 0 && transcript === null) {
      return { status: 'fallback', reason: 'nothing_readable', costUsd };
    }
    return { status: 'ready', transcript, images: parts.frames, costUsd };
  }
}
