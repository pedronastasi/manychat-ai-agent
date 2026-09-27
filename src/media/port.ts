import type { InboundMedia } from '../contracts/agent.ts';

/**
 * The seams a media turn crosses (specs/020). Each is a port so tests fake it
 * where the constitution allows: the fetch at the ManyChat HTTP boundary, the
 * transcriber at the model boundary. ffmpeg is never faked; its tests run it.
 */

export interface MediaDownload {
  bytes: Uint8Array;
  /** The response's own type, parameters dropped, e.g. `image/jpeg`. */
  contentType: string;
}

/** Downloads what a channel pointed at. Lives with the channel that knows the URL. */
export interface MediaFetcher {
  fetch(media: InboundMedia, signal: AbortSignal): Promise<MediaDownload>;
}

export interface Transcript {
  text: string;
  model: string;
  costUsd: number;
}

export interface Transcriber {
  transcribe(audio: Uint8Array, signal: AbortSignal): Promise<Transcript>;
}

export interface MediaImage {
  data: Uint8Array;
  mediaType: string;
}

export interface VideoParts {
  frames: MediaImage[];
  /** Null when the video has no audio track, or it was not asked for. */
  soundtrack: Uint8Array | null;
}

export interface VideoSplitter {
  split(
    video: Uint8Array,
    want: { frames: boolean; soundtrack: boolean },
    signal: AbortSignal,
  ): Promise<VideoParts>;
}

/**
 * A failure we caused, or the platform did: the download, the transcription or
 * the frame extraction. It hands the contact to a person, never asks them to
 * type (specs/020 § A failure we caused hands off).
 */
export type MediaFailureReason =
  'download' | 'redirect' | 'content_type' | 'too_large' | 'transcription' | 'ffmpeg';

export class MediaFailure extends Error {
  readonly reason: MediaFailureReason;

  constructor(reason: MediaFailureReason, detail: string, options?: { cause?: unknown }) {
    super(`${reason}: ${detail}`, options);
    this.name = 'MediaFailure';
    this.reason = reason;
  }
}
