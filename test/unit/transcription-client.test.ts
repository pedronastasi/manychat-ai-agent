import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  resolveTranscriptionModel,
  transcriptionCostUsd,
  TRANSCRIPTION_MAX_RETRIES,
  UnknownProviderError,
} from '../../src/agent/registry.ts';
import { MediaFailure } from '../../src/media/port.ts';

/**
 * specs/053-one-model-library.md § Verification: No dependency,
 * Transcription, Direct dependency, Ollama transcription and Google
 * transcription dropped (§ Transcription is a port the registry implements
 * with the provider's SDK). The transcription model is a model, so it is faked
 * at its HTTP boundary through the client's `fetch` (specs/004). The audio is
 * a few invented bytes, never a recording (C1).
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Ogg's signature and a few bytes after it: named `audio.ogg`, as the AI SDK named it. */
const OGG = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 2, 0, 0, 0, 0, 0, 0]);

interface Sent {
  url: string;
  form: Record<string, string>;
  signal: AbortSignal | undefined;
}

/** A transcription API answering each request from `answer`, recording what was sent. */
function api(answer: (call: number) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const fetch = (async (url: string | URL, init: RequestInit) => {
    const form: Record<string, string> = {};
    if (init.body instanceof FormData) {
      for (const [key, value] of init.body.entries()) {
        form[key] = typeof value === 'string' ? value : `${value.name} ${value.type}`;
      }
    }
    sent.push({ url: String(url), form, signal: init.signal ?? undefined });
    return answer(sent.length - 1);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

function openai(spec: string, fetch: typeof globalThis.fetch) {
  vi.stubEnv('OPENAI_API_KEY', 'sk-invented-for-tests');
  return resolveTranscriptionModel(spec, { fetch });
}

describe('the transcription client is set as the table says (specs/053 V5)', () => {
  it('retries twice, inside the abort, as the AI SDK did', async () => {
    expect(TRANSCRIPTION_MAX_RETRIES).toBe(2);
    const { fetch, sent } = api(() =>
      json({ error: { message: 'busy' } }, 429, { 'retry-after-ms': '1' }),
    );
    const transcriber = openai('openai:gpt-4o-mini-transcribe', fetch);
    await expect(transcriber.transcribe(OGG, new AbortController().signal)).rejects.toBeInstanceOf(
      MediaFailure,
    );
    expect(sent).toHaveLength(1 + TRANSCRIPTION_MAX_RETRIES);
  });

  it('passes the turn’s signal, so the request is aborted with the turn', async () => {
    const turn = new AbortController();
    const { fetch, sent } = api(
      () =>
        new Promise<Response>((_resolve, reject) => {
          const signal = sent[0]!.signal!;
          signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
          turn.abort();
        }),
    );
    const transcriber = openai('openai:gpt-4o-mini-transcribe', fetch);
    await expect(transcriber.transcribe(OGG, turn.signal)).rejects.toBeInstanceOf(MediaFailure);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.signal!.aborted).toBe(true);
  });

  it('turns an empty transcript into empty text, not a failure, billed from the size', async () => {
    const { fetch } = api(() => json({ text: '', duration: 9 }));
    const transcript = await openai('openai:whisper-1', fetch).transcribe(
      OGG,
      new AbortController().signal,
    );
    expect(transcript).toEqual({
      text: '',
      model: 'openai:whisper-1',
      costUsd: transcriptionCostUsd('openai:whisper-1', OGG.byteLength / 1000),
    });
  });

  it('fails a response that is not a transcript as MediaFailure (C3)', async () => {
    const { fetch } = api(() => json({ transcript: 'no text field' }));
    await expect(
      openai('openai:gpt-4o-transcribe', fetch).transcribe(OGG, new AbortController().signal),
    ).rejects.toMatchObject({ name: 'MediaFailure', reason: 'transcription' });
  });

  it('bills a missing duration at 1000 bytes per second, and a reported one as reported', async () => {
    const plain = api(() => json({ text: 'Hello there.' }));
    expect(
      await openai('openai:gpt-4o-transcribe', plain.fetch).transcribe(
        OGG,
        new AbortController().signal,
      ),
    ).toEqual({
      text: 'Hello there.',
      model: 'openai:gpt-4o-transcribe',
      costUsd: transcriptionCostUsd('openai:gpt-4o-transcribe', OGG.byteLength / 1000),
    });
    const verbose = api(() => json({ text: ' Hello there. ', duration: 4.5 }));
    expect(
      await openai('openai:whisper-1', verbose.fetch).transcribe(OGG, new AbortController().signal),
    ).toEqual({
      text: 'Hello there.',
      model: 'openai:whisper-1',
      costUsd: transcriptionCostUsd('openai:whisper-1', 4.5),
    });
    const usage = api(() => json({ text: 'Hi.', usage: { type: 'duration', seconds: 2 } }));
    expect(
      (
        await openai('openai:gpt-4o-transcribe', usage.fetch).transcribe(
          OGG,
          new AbortController().signal,
        )
      ).costUsd,
    ).toBe(transcriptionCostUsd('openai:gpt-4o-transcribe', 2));
  });

  it('sends the file and format the AI SDK sent, per model', async () => {
    const whisper = api(() => json({ text: 'Hi.', duration: 1 }));
    await openai('openai:whisper-1', whisper.fetch).transcribe(OGG, new AbortController().signal);
    expect(whisper.sent[0]).toMatchObject({
      url: 'https://api.openai.com/v1/audio/transcriptions',
      form: {
        file: 'audio.ogg audio/ogg',
        model: 'whisper-1',
        response_format: 'verbose_json',
        'timestamp_granularities[]': 'segment',
      },
    });
    const diarize = api(() => json({ text: 'Hi.', duration: 1 }));
    await openai('openai:gpt-4o-transcribe-diarize', diarize.fetch).transcribe(
      OGG,
      new AbortController().signal,
    );
    expect(diarize.sent[0]!.form).toEqual({
      file: 'audio.ogg audio/ogg',
      model: 'gpt-4o-transcribe-diarize',
      response_format: 'diarized_json',
      chunking_strategy: 'auto',
    });
    const plain = api(() => json({ text: 'Hi.' }));
    await openai('openai:gpt-4o-mini-transcribe', plain.fetch).transcribe(
      new Uint8Array([1, 2, 3]),
      new AbortController().signal,
    );
    expect(plain.sent[0]!.form).toEqual({
      file: 'audio.wav audio/wav',
      model: 'gpt-4o-mini-transcribe',
    });
  });

  it('boots without an OpenAI key, and fails the first voice note instead, as before', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    const { fetch, sent } = api(() => json({ text: 'never asked' }));
    const transcriber = resolveTranscriptionModel('openai:whisper-1', { fetch });
    await expect(transcriber.transcribe(OGG, new AbortController().signal)).rejects.toBeInstanceOf(
      MediaFailure,
    );
    expect(sent).toHaveLength(0);
  });
});

describe('the service depends on no AI SDK package (specs/053 V1)', () => {
  it('lists neither ai nor any @ai-sdk package, in dependencies or devDependencies', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const names = [...Object.keys(manifest.dependencies), ...Object.keys(manifest.devDependencies)];
    expect(names.filter(name => name === 'ai' || name.startsWith('@ai-sdk/'))).toEqual([]);
  });
});

describe('openai is a direct dependency (specs/053 V6)', () => {
  it('lists openai in dependencies', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies.openai).toBeDefined();
  });
});

describe('Ollama transcribes through the same client at OLLAMA_BASE_URL (specs/053 V7)', () => {
  it('sends the request to Ollama’s base URL, with no OpenAI key needed', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    const { fetch, sent } = api(() => json({ text: 'Hi.' }));
    const transcript = await resolveTranscriptionModel('ollama:whisper-small', {
      fetch,
    }).transcribe(OGG, new AbortController().signal);
    expect(transcript.text).toBe('Hi.');
    expect(sent[0]!.url).toBe(
      `${process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1'}/audio/transcriptions`,
    );
  });
});

describe('a provider that does not transcribe fails boot (specs/053 V8)', () => {
  it('refuses google:, dropped with the AI SDK, naming TRANSCRIPTION_MODEL', () => {
    expect(() => resolveTranscriptionModel('google:gemini-3.5-transcribe')).toThrow(
      UnknownProviderError,
    );
    expect(() => resolveTranscriptionModel('google:gemini-3.5-transcribe')).toThrow(
      /TRANSCRIPTION_MODEL/,
    );
  });

  it('refuses anthropic: naming TRANSCRIPTION_MODEL', () => {
    expect(() => resolveTranscriptionModel('anthropic:claude-haiku-4-5')).toThrow(
      UnknownProviderError,
    );
    expect(() => resolveTranscriptionModel('anthropic:claude-haiku-4-5')).toThrow(
      /TRANSCRIPTION_MODEL/,
    );
  });
});
