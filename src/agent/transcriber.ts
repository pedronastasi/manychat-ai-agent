import { NoTranscriptGeneratedError, transcribe, type TranscriptionModel } from 'ai';
import { MediaFailure, type Transcriber, type Transcript } from '../media/port.ts';
import { transcriptionCostUsd } from './registry.ts';

/**
 * Opus at 8 kbit/s, below what a voice note is encoded at, so a duration
 * estimated from the size errs long and the budget cap errs toward stopping.
 */
const PESSIMISTIC_BYTES_PER_SECOND = 1000;

/**
 * Transcribes a voice note or a video's soundtrack with TRANSCRIPTION_MODEL
 * (specs/020). The model comes from the registry, so this file imports no
 * provider (C2).
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
    const billed = seconds ?? audio.byteLength / PESSIMISTIC_BYTES_PER_SECOND;
    return {
      text,
      model: this.modelSpec,
      costUsd: transcriptionCostUsd(this.modelSpec, billed),
    };
  }
}
