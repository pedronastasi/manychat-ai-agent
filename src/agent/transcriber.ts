import { NoTranscriptGeneratedError, transcribe, type TranscriptionModel } from 'ai';
import { z } from 'zod';
import { MediaFailure, type Transcriber, type Transcript } from '../media/port.ts';
import { audioExtension, audioMediaType } from '../media/audio-type.ts';
import { transcriptionCostUsd } from './registry.ts';

/**
 * Opus at 8 kbit/s, below what a voice note is encoded at, so a duration
 * estimated from the size errs long and the budget cap errs toward stopping.
 */
const PESSIMISTIC_BYTES_PER_SECOND = 1000;

function billed(modelSpec: string, audio: Uint8Array, seconds: number | undefined): number {
  return transcriptionCostUsd(
    modelSpec,
    seconds ?? audio.byteLength / PESSIMISTIC_BYTES_PER_SECOND,
  );
}

/**
 * Transcribes with an AI SDK model. Kept for `google:` and for test fakes
 * until specs/053's step 3 (§ Google transcription is dropped).
 */
export class SdkTranscriber implements Transcriber {
  private readonly model: TranscriptionModel;
  private readonly modelSpec: string;

  constructor(opts: { model: TranscriptionModel; modelSpec: string }) {
    this.model = opts.model;
    this.modelSpec = opts.modelSpec;
  }

  async transcribe(audio: Uint8Array, signal: AbortSignal): Promise<Transcript> {
    let text = '';
    let seconds: number | undefined;
    try {
      const result = await transcribe({ model: this.model, audio, abortSignal: signal });
      text = result.text.trim();
      seconds = result.durationInSeconds;
    } catch (error) {
      // The SDK throws on an empty transcript. A voice note with nothing said
      // is the contact's to fix by typing, not a failure to hand off.
      if (!NoTranscriptGeneratedError.isInstance(error)) {
        throw new MediaFailure('transcription', error instanceof Error ? error.name : 'unknown', {
          cause: error,
        });
      }
    }
    return { text, model: this.modelSpec, costUsd: billed(this.modelSpec, audio, seconds) };
  }
}

/** The transcription endpoint of an OpenAI-compatible client: the `openai` package's, built in the registry (C2). */
export interface TranscriptionEndpoint {
  create(body: TranscriptionRequest, options: { signal: AbortSignal }): Promise<unknown>;
}

export interface TranscriptionRequest {
  file: File;
  model: string;
  response_format?: 'verbose_json' | 'diarized_json';
  timestamp_granularities?: 'segment'[];
  chunking_strategy?: 'auto';
}

/**
 * What the transcription API answers, checked before its text is read (C3).
 * `duration` comes with `verbose_json` and `diarized_json`; `usage` of type
 * `duration` with whisper's plain JSON. Anything else is left unread.
 */
const TranscriptionResponse = z.object({
  text: z.string(),
  duration: z.number().optional(),
  usage: z.object({ type: z.string(), seconds: z.number().optional() }).loose().optional(),
});

/**
 * The response format each model was asked for under the AI SDK: whisper's
 * verbose JSON, which carries the duration, the diarizing model's own with its
 * chunking, and the API's default for the rest (specs/053).
 */
function requestFor(model: string): Omit<TranscriptionRequest, 'file' | 'model'> {
  if (model === 'whisper-1') {
    return { response_format: 'verbose_json', timestamp_granularities: ['segment'] };
  }
  if (model === 'gpt-4o-transcribe-diarize') {
    return { response_format: 'diarized_json', chunking_strategy: 'auto' };
  }
  return {};
}

/**
 * Transcribes through an OpenAI-compatible transcription endpoint: OpenAI's,
 * or Ollama's at `OLLAMA_BASE_URL` (specs/053 § Transcription is a port the
 * registry implements with the provider's SDK). The endpoint is built on first
 * use, so a missing key fails the first voice note, as it did, not boot.
 */
export class OpenAiTranscriber implements Transcriber {
  private endpoint: TranscriptionEndpoint | undefined;
  private readonly opts: {
    endpoint: () => TranscriptionEndpoint;
    model: string;
    modelSpec: string;
  };

  constructor(opts: { endpoint: () => TranscriptionEndpoint; model: string; modelSpec: string }) {
    this.opts = opts;
  }

  async transcribe(audio: Uint8Array, signal: AbortSignal): Promise<Transcript> {
    const mediaType = audioMediaType(audio);
    let response: z.infer<typeof TranscriptionResponse>;
    try {
      this.endpoint ??= this.opts.endpoint();
      const raw = await this.endpoint.create(
        {
          file: new File([audio], `audio.${audioExtension(mediaType)}`, { type: mediaType }),
          model: this.opts.model,
          ...requestFor(this.opts.model),
        },
        { signal },
      );
      response = TranscriptionResponse.parse(raw);
    } catch (error) {
      throw new MediaFailure('transcription', error instanceof Error ? error.name : 'unknown', {
        cause: error,
      });
    }
    // An empty transcript is not a failure, and was billed from the size: the
    // AI SDK threw on it before reading the duration (specs/053, specs/020).
    if (response.text === '') {
      return {
        text: '',
        model: this.opts.modelSpec,
        costUsd: billed(this.opts.modelSpec, audio, undefined),
      };
    }
    const seconds =
      response.duration ??
      (response.usage?.type === 'duration' ? response.usage.seconds : undefined);
    return {
      text: response.text.trim(),
      model: this.opts.modelSpec,
      costUsd: billed(this.opts.modelSpec, audio, seconds),
    };
  }
}
