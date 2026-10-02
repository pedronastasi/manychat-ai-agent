import type { ContactTokenWriter } from '../../src/conversation/tokens.ts';
import type { ActionPerformer } from '../../src/channels/manychat/client.ts';
import { ManyChatApiError } from '../../src/channels/manychat/client.ts';
import type { StagedAction } from '../../src/contracts/agent.ts';

/**
 * ManyChat's action endpoints at the port (specs/012). Records what it was
 * asked to perform, for whom, and in what order; `failing` makes each request
 * fail as ManyChat does when it refuses one.
 */
export class FakeActions implements ActionPerformer {
  readonly performed: { subscriberId: string; action: StagedAction }[] = [];
  failing = false;

  performAction(subscriberId: string, action: StagedAction): Promise<void> {
    if (this.failing) return Promise.reject(new Error('ManyChat refused the request'));
    this.performed.push({ subscriberId, action });
    return Promise.resolve();
  }
}

/**
 * ManyChat's contact fields, as far as contact tokens need them (specs/019).
 *
 * A write lands in the named contact's field and nowhere else, which is the
 * contract of `setCustomFieldByName`, and `tokenOf` is what ManyChat would fill
 * into a request made for that contact. The field is set when the write is
 * made, before the promise settles, so the next message sees it as a contact
 * replying after reading the answer would.
 */
export class FakeContactFields implements ContactTokenWriter {
  readonly written: { subscriberId: string; token: string }[] = [];
  private readonly fields = new Map<string, string>();
  /** Set to make every write fail, as when ManyChat is down. */
  failing = false;

  writeToken(subscriberId: string, token: string): Promise<void> {
    if (this.failing) return Promise.reject(new Error('ManyChat unavailable'));
    this.fields.set(subscriberId, token);
    this.written.push({ subscriberId, token });
    return Promise.resolve();
  }

  tokenOf(subscriberId: string): string | null {
    return this.fields.get(subscriberId) ?? null;
  }
}

/**
 * An invented media URL in the shape observed on 2026-09-27 (specs/020). The
 * account ID, date and hash are made up: a real one opens a contact's file for
 * good and names the tenant's ManyChat account (C1, C5).
 */
export const mediaUrl = (extension: string, hash = '0123456789abcdef0123456789abcdef') =>
  `https://manybot-files.s3.eu-central-1.amazonaws.com/100000000000001/wa/2026/01/15/original_${hash}.${extension}`;

export interface FakeMediaFile {
  status?: number;
  contentType?: string | null;
  body?: Uint8Array;
  /** Sent as Content-Length when set, whatever the body's real size. */
  contentLength?: number;
  location?: string;
  /** Holds the response back, honouring the request's abort signal as fetch does. */
  delayMs?: number;
}

/**
 * ManyChat's media host, faked at the HTTP boundary like the API (specs/004).
 * Answers with real `Response` objects, so status, headers and streaming
 * bodies behave as fetch's do.
 */
export function fakeMediaHost() {
  const files = new Map<string, FakeMediaFile>();
  const requested: { url: string; redirect: string | undefined }[] = [];

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    requested.push({ url: String(url), redirect: init?.redirect });
    const file = files.get(String(url));
    if (!file) return new Response('not found', { status: 404 });
    if (file.delayMs) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, file.delayMs);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    }
    const headers = new Headers();
    if (file.contentType !== null) headers.set('content-type', file.contentType ?? 'audio/ogg');
    if (file.contentLength !== undefined) headers.set('content-length', String(file.contentLength));
    if (file.location) headers.set('location', file.location);
    return new Response(file.body ?? null, { status: file.status ?? 200, headers });
  }) as unknown as typeof fetch;

  return { fetch: fetchImpl, files, requested };
}

/** ManyChat's answer to a request it accepted (specs/022 § Tests fake fetch). */
export const MANYCHAT_SUCCESS = '{"status":"success"}';

/**
 * A response as ManyChat sends it: a real `Response`, so the SDK reads its
 * status and body as it reads fetch's.
 */
export function manychatAnswer(status = 200, body = MANYCHAT_SUCCESS): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

/** ManyChat's refusal as the client throws it; `retryable` follows from the status. */
export const manychatError = (status: number, message: string, endpoint = '/fb/sending/sendFlow') =>
  new ManyChatApiError({
    endpoint,
    status,
    message,
    code: undefined,
    details: [],
  });

/** Never answers, until the request's signal aborts, as a hung connection does. */
export function neverAnswers(init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
  });
}

export interface ManyChatCall {
  path: string;
  body: Record<string, unknown>;
}

/**
 * The ManyChat API at its HTTP boundary, for `buildServer`: it records every
 * call, keeps each contact's custom fields, and answers as ManyChat does when
 * it accepts a request. `failing` answers 503, as when ManyChat is down, and
 * `respond`, when set, answers every API request in its place.
 */
export function fakeManyChatApi() {
  const calls: ManyChatCall[] = [];
  const fields = new Map<string, Map<string, string>>();
  const state = {
    failing: false,
    respond: null as ((init: RequestInit) => Promise<Response>) | null,
  };
  const media = fakeMediaHost();

  const fetchImpl = ((url: string, init: RequestInit) => {
    // A GET with no body is a media download, the other half of the boundary.
    if (init.body === undefined) return media.fetch(url, init);
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ path, body });
    if (state.respond) return state.respond(init);
    if (state.failing) return Promise.resolve(manychatAnswer(503, 'down'));
    if (path === '/fb/subscriber/setCustomFieldByName') {
      const subscriber = String(body.subscriber_id);
      const contact = fields.get(subscriber) ?? new Map<string, string>();
      contact.set(String(body.field_name), String(body.field_value));
      fields.set(subscriber, contact);
    }
    return Promise.resolve(manychatAnswer());
  }) as unknown as typeof fetch;

  return {
    fetch: fetchImpl,
    calls,
    state,
    media,
    fieldOf: (subscriberId: string, field = 'ai_token') =>
      fields.get(subscriberId)?.get(field) ?? null,
    /**
     * Every token this fake was asked to write, failed writes included: every
     * field value that is not a reply, whichever field holds the token.
     */
    tokensWritten: () =>
      calls
        .filter(call => call.path === '/fb/subscriber/setCustomFieldByName')
        .filter(call => call.body.field_name !== 'ai_message')
        .map(call => String(call.body.field_value)),
  };
}
