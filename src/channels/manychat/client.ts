/**
 * ManyChat Send API client — the deferred delivery path (ADR-0001).
 *
 * Only used when the model loses the race, so throughput is low; the limiter
 * exists to stay well under ManyChat's documented ~25 rps rather than to push
 * against it.
 */
export interface ManyChatClient {
  sendText(subscriberId: string, messages: string[]): Promise<void>;
}

export class ManyChatApiError extends Error {
  readonly status: number;
  readonly body: string;
  /** 4xx other than 429 will never succeed on retry. */
  readonly retryable: boolean;

  constructor(status: number, body: string, retryable: boolean) {
    super(`ManyChat API ${status}: ${body.slice(0, 200)}`);
    this.name = 'ManyChatApiError';
    this.status = status;
    this.body = body;
    this.retryable = retryable;
  }
}

class TokenBucket {
  private tokens: number;
  private last = Date.now();
  private readonly capacity: number;
  private readonly refillPerSec: number;

  constructor(capacity: number, refillPerSec: number) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.tokens = capacity;
  }
  async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(
        this.capacity,
        this.tokens + ((now - this.last) / 1000) * this.refillPerSec,
      );
      this.last = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await new Promise(r =>
        setTimeout(r, Math.ceil(((1 - this.tokens) / this.refillPerSec) * 1000)),
      );
    }
  }
}

export interface ManyChatClientOptions {
  apiToken: string;
  baseUrl?: string;
  /** Well under the documented ~25 rps ceiling. */
  requestsPerSecond?: number;
  fetchImpl?: typeof fetch;
}

export function createManyChatClient(opts: ManyChatClientOptions): ManyChatClient {
  const base = (opts.baseUrl ?? 'https://api.manychat.com').replace(/\/$/, '');
  const bucket = new TokenBucket(5, opts.requestsPerSecond ?? 10);
  const doFetch = opts.fetchImpl ?? fetch;

  async function sendOne(subscriberId: string, text: string): Promise<void> {
    await bucket.take();
    const res = await doFetch(`${base}/fb/sending/sendContent`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        subscriber_id: subscriberId,
        data: { version: 'v2', content: { messages: [{ type: 'text', text }] } },
        message_tag: 'ACCOUNT_UPDATE',
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const retryable = res.status === 429 || res.status >= 500;
      throw new ManyChatApiError(res.status, body, retryable);
    }
  }

  return {
    async sendText(subscriberId, messages) {
      // Sequential, so the contact receives them in the order they were written.
      for (const text of messages) {
        await sendOne(subscriberId, text);
      }
    },
  };
}
