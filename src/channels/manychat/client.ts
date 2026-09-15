/**
 * ManyChat delivery client — the deferred path (ADR-0001).
 *
 * Delivery is two calls, not one: the reply text is written to a per-subscriber
 * custom field and a flow is then triggered to render it. `sendContent` cannot
 * be used, because Meta permits free-form messages only within 24h of the
 * contact's last message and ManyChat no longer accepts the `message_tag` that
 * used to lift that (specs/002-channel-contract.md).
 *
 * Only used when the model loses the race, so throughput is low; the limiter
 * exists to stay well under ManyChat's documented ~25 rps rather than to push
 * against it. Note each message now costs two requests.
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
      await new Promise(resolve =>
        setTimeout(resolve, Math.ceil(((1 - this.tokens) / this.refillPerSec) * 1000)),
      );
    }
  }
}

export interface ManyChatClientOptions {
  apiToken: string;
  baseUrl?: string;
  /** Custom field the reply text is written to before the flow renders it. */
  replyField: string;
  /** Namespace of the flow that renders `replyField`. */
  replyFlowNs: string;
  /** Well under the documented ~25 rps ceiling. */
  requestsPerSecond?: number;
  fetchImpl?: typeof fetch;
}

export class ManyChatHttpClient implements ManyChatClient {
  private readonly base: string;
  private readonly apiToken: string;
  private readonly replyField: string;
  private readonly replyFlowNs: string;
  private readonly bucket: TokenBucket;
  private readonly doFetch: typeof fetch;

  constructor(opts: ManyChatClientOptions) {
    this.base = (opts.baseUrl ?? 'https://api.manychat.com').replace(/\/$/, '');
    this.apiToken = opts.apiToken;
    this.replyField = opts.replyField;
    this.replyFlowNs = opts.replyFlowNs;
    this.bucket = new TokenBucket(5, opts.requestsPerSecond ?? 10);
    // Bound deliberately: reaching native fetch through `this.doFetch(...)`
    // would call it with the instance as its receiver, which it rejects.
    this.doFetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private async post(path: string, payload: unknown): Promise<void> {
    await this.bucket.take();
    const res = await this.doFetch(`${this.base}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const retryable = res.status === 429 || res.status >= 500;
      throw new ManyChatApiError(res.status, body, retryable);
    }
  }

  /**
   * Writes the reply, then triggers the flow that renders it
   * (specs/002-channel-contract.md § Deferred delivery goes through a flow).
   *
   * `setCustomFieldByName` is per-subscriber. The account-global bot-field
   * endpoint accepts a near-identical body, so the only thing distinguishing a
   * safe write from one that leaks a contact's reply to a different contact is
   * this path — hence the two are never abstracted behind one helper.
   */
  private async sendOne(subscriberId: string, text: string): Promise<void> {
    await this.post('/fb/subscriber/setCustomFieldByName', {
      subscriber_id: subscriberId,
      field_name: this.replyField,
      field_value: text,
    });
    await this.post('/fb/sending/sendFlow', {
      subscriber_id: subscriberId,
      flow_ns: this.replyFlowNs,
    });
  }

  async sendText(subscriberId: string, messages: string[]): Promise<void> {
    // Sequential, so the contact receives them in the order they were written,
    // and so each flow renders its own message rather than the last one written.
    //
    // The field is written immediately before each trigger and never assumed to
    // have survived: a retry re-runs both calls, because a field left over from
    // a half-finished attempt may since have been overwritten by another turn.
    for (const text of messages) {
      await this.sendOne(subscriberId, text);
    }
  }
}
