import type { InboundMedia, MediaKind } from '../../contracts/agent.ts';
import { MediaFailure, type MediaDownload, type MediaFetcher } from '../../media/port.ts';

/**
 * Where ManyChat puts a file a WhatsApp contact sends, as observed on
 * 2026-09-27 (specs/020 § Media is recognised by exact host and path). The
 * whole trimmed `text` must match: a URL inside a sentence is something the
 * contact typed, and a URL on any other host is not ours to fetch.
 */
const MEDIA_HOST = 'manybot-files.s3.eu-central-1.amazonaws.com';
const MEDIA_URL =
  /^https:\/\/manybot-files\.s3\.eu-central-1\.amazonaws\.com\/\d+\/wa\/\d{4}\/\d{2}\/\d{2}\/original_[0-9a-f]+\.([a-z0-9]+)$/i;

/** Only `.ogg` and `.jpeg` have been observed; the rest are formats WhatsApp accepts. */
const KIND_BY_EXTENSION: Record<string, MediaKind> = {
  ogg: 'audio',
  jpeg: 'image',
  jpg: 'image',
  png: 'image',
  mp4: 'video',
  '3gp': 'video',
};

export function matchMediaUrl(text: string): InboundMedia | null {
  const url = text.trim();
  const match = MEDIA_URL.exec(url);
  if (!match) return null;
  const extension = match[1]!.toLowerCase();
  return { kind: KIND_BY_EXTENSION[extension] ?? 'unsupported', url };
}

/**
 * Text that names the media host without matching the shape. The only sign
 * that ManyChat changed its URL format, which would otherwise turn every voice
 * note back into a link the model answers.
 */
export function mentionsMediaHost(text: string): boolean {
  return text.toLowerCase().includes(MEDIA_HOST);
}

/**
 * The path of a URL on the media host with its account ID, date and hash
 * reduced to placeholders: enough to see how the format changed, nothing that
 * opens a file or names an account.
 */
export function mediaUrlShape(text: string): string {
  const at = text.toLowerCase().indexOf(MEDIA_HOST);
  const path = text.slice(at + MEDIA_HOST.length).split(/\s/)[0] ?? '';
  return path
    .replace(/[0-9a-f]{12,}|\d+/gi, run => (/^\d+$/.test(run) ? '<n>' : '<hex>'))
    .slice(0, 120);
}

const MB = 1024 * 1024;

/**
 * WhatsApp's own limits (ManyChat's media guidelines, updated 2026-08-24). A
 * larger file should not exist, so one means the platform changed.
 */
const LIMITS: Record<Exclude<MediaKind, 'unsupported'>, { bytes: number; type: string }> = {
  image: { bytes: 5 * MB, type: 'image/' },
  audio: { bytes: 16 * MB, type: 'audio/' },
  video: { bytes: 16 * MB, type: 'video/' },
};

/**
 * Downloads a file from ManyChat's media host: the ManyChat HTTP boundary of
 * specs/004, faked there in tests like the API client.
 *
 * Nothing it throws carries the URL, which opens the contact's file for good.
 */
export class ManyChatMediaFetcher implements MediaFetcher {
  private readonly doFetch: typeof fetch;

  constructor(fetchImpl?: typeof fetch) {
    // Bound for the same reason as ManyChatHttpClient's: native fetch rejects
    // any receiver but the global.
    this.doFetch = fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async fetch(media: InboundMedia, signal: AbortSignal): Promise<MediaDownload> {
    // Checked again here rather than trusted from the adapter: this is the
    // line that decides what the server requests.
    if (media.kind === 'unsupported' || matchMediaUrl(media.url)?.kind !== media.kind) {
      throw new MediaFailure('download', 'not a recognised ManyChat media URL');
    }
    const limit = LIMITS[media.kind];

    let response: Response;
    try {
      response = await this.doFetch(media.url, { method: 'GET', redirect: 'manual', signal });
    } catch (error) {
      throw new MediaFailure('download', error instanceof Error ? error.name : 'unknown', {
        cause: error,
      });
    }

    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      throw new MediaFailure('redirect', `status ${response.status}`);
    }
    if (!response.ok) throw new MediaFailure('download', `status ${response.status}`);

    const contentType = (response.headers.get('content-type') ?? '')
      .split(';')[0]!
      .trim()
      .toLowerCase();
    if (!contentType.startsWith(limit.type)) {
      throw new MediaFailure(
        'content_type',
        `expected ${limit.type}*, got ${contentType || 'none'}`,
      );
    }

    return { bytes: await readLimited(response, limit.bytes), contentType };
  }
}

/** Reads the body, stopping at `limit` rather than trusting Content-Length. */
async function readLimited(response: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (declared > limit) {
    await response.body?.cancel();
    throw new MediaFailure('too_large', `declared ${declared} bytes`);
  }
  if (!response.body) return new Uint8Array();

  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new MediaFailure('too_large', `over ${limit} bytes`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof MediaFailure) throw error;
    throw new MediaFailure('download', error instanceof Error ? error.name : 'unknown', {
      cause: error,
    });
  }
  return Buffer.concat(chunks);
}
