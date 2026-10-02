import { ManyChat } from 'manychat-sdk';
import type { ContactTokenWriter } from '../../conversation/tokens.ts';
import type { StagedAction } from '../../contracts/agent.ts';
import type { Env } from '../../contracts/config.ts';

// The worker retries on `ManyChatError.retryable` (specs/022 § Retries follow
// the SDK's retryable, not instanceof), and only this file imports the SDK.
export {
  ManyChatError,
  ManyChatApiError,
  ManyChatConnectionError,
  ManyChatResponseError,
} from 'manychat-sdk';

/**
 * Performs an action the agent staged on a turn (specs/012), one request per
 * action through the same rate limiter as delivery. Called only after the
 * reply's text has gone out.
 */
export interface ActionPerformer {
  performAction(subscriberId: string, action: StagedAction): Promise<void>;
}

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
export interface ManyChatClient extends ContactTokenWriter, ActionPerformer {
  sendText(subscriberId: string, messages: string[]): Promise<void>;
}

/**
 * Every option the agent relies on is set here rather than inherited from the
 * SDK, because a dependency's default is not where delivery decisions get made
 * (specs/022 § Swapping the client for the SDK with its defaults would change
 * delivery).
 *
 * Ten a second, in bursts of five, stays well under ManyChat's documented ~25.
 * Chosen, not measured: change it when a measurement shows a need, and record
 * its date in specs/022.
 */
const RATE_LIMIT = { requestsPerSecond: 10, burst: 5 };

/**
 * Every call, the rate limiter's wait included, is abandoned after this and
 * fails as retryable (specs/022 § Every call is abandoned after 10 seconds).
 * Well inside the outbox's retry delay for a token write, so a hung write
 * cannot land after the worker has replaced the token it carries (specs/019).
 */
const TIMEOUT_MS = 10_000;

export interface ManyChatClientOptions {
  apiToken: string;
  baseUrl: string;
  /** Custom field the reply text is written to before the flow renders it. */
  replyField: string;
  /** Namespace of the flow that renders `replyField`. */
  replyFlowNs: string;
  /** Custom field that holds the contact's token (specs/019). */
  tokenField: string;
  /** The ManyChat HTTP boundary, faked by tests (specs/004). */
  fetchImpl?: typeof fetch;
}

/**
 * The only file that imports `manychat-sdk` (specs/022 § The SDK sits behind
 * the ManyChatClient port). Build one per process and share it: the rate limit
 * belongs to the SDK instance, so two of them send at twice the rate.
 */
export class ManyChatHttpClient implements ManyChatClient {
  private readonly api: ManyChat;
  private readonly replyField: string;
  private readonly replyFlowNs: string;
  private readonly tokenField: string;

  constructor(opts: ManyChatClientOptions) {
    this.api = new ManyChat({
      apiToken: opts.apiToken,
      baseUrl: opts.baseUrl,
      timeoutMs: TIMEOUT_MS,
      rateLimit: RATE_LIMIT,
      ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
    });
    this.replyField = opts.replyField;
    this.replyFlowNs = opts.replyFlowNs;
    this.tokenField = opts.tokenField;
  }

  /**
   * Writes the reply, then triggers the flow that renders it
   * (specs/002-channel-contract.md § Deferred delivery goes through a flow).
   *
   * `subscriber.setCustomFieldByName` is per-subscriber. The SDK's
   * `page.setBotField` takes near-identical parameters and writes a value every
   * contact sees, so the only thing distinguishing a safe write from one that
   * leaks a contact's reply to a different contact is this method name — hence
   * the two are never abstracted behind one helper (specs/022).
   */
  private async sendOne(subscriberId: string, text: string): Promise<void> {
    await this.api.subscriber.setCustomFieldByName({
      subscriber_id: subscriberId,
      field_name: this.replyField,
      field_value: text,
    });
    await this.api.sending.sendFlow({ subscriber_id: subscriberId, flow_ns: this.replyFlowNs });
  }

  /**
   * Writes the contact's token to their own custom field, the same
   * per-subscriber endpoint as a reply, so ManyChat can send it back
   * (specs/019 § Each contact's token lives in ManyChat, never in a response).
   */
  async writeToken(subscriberId: string, token: string): Promise<void> {
    await this.api.subscriber.setCustomFieldByName({
      subscriber_id: subscriberId,
      field_name: this.tokenField,
      field_value: token,
    });
  }

  /**
   * Every endpoint here is per-subscriber and takes the turn's own contact, so
   * an action cannot land on anyone else (specs/012 § The subscriber is never
   * a parameter).
   */
  async performAction(subscriberId: string, action: StagedAction): Promise<void> {
    const subscriber = { subscriber_id: subscriberId };
    switch (action.tool) {
      case 'send_flow':
        return this.api.sending.sendFlow({ ...subscriber, flow_ns: action.flowNs });
      case 'add_tag':
        return this.api.subscriber.addTagByName({ ...subscriber, tag_name: action.tag });
      case 'remove_tag':
        return this.api.subscriber.removeTagByName({ ...subscriber, tag_name: action.tag });
      case 'set_field':
        return this.api.subscriber.setCustomFieldByName({
          ...subscriber,
          field_name: action.field,
          field_value: action.value,
        });
    }
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

/**
 * The one client a process shares between the server and the outbox worker
 * (specs/022 § One instance per process).
 *
 * Without an API token no SDK instance is built, since the SDK refuses an empty
 * key and the server must still boot for local development. The deferred path
 * then cannot deliver, so each call fails loudly rather than silently dropping
 * a contact's reply.
 */
export function manychatClientFor(env: Env, fetchImpl?: typeof fetch): ManyChatClient {
  if (!env.MANYCHAT_API_TOKEN) {
    return {
      sendText: () =>
        Promise.reject(new Error('MANYCHAT_API_TOKEN is not set; cannot deliver deferred replies')),
      writeToken: () =>
        Promise.reject(new Error('MANYCHAT_API_TOKEN is not set; cannot write contact tokens')),
      performAction: () =>
        Promise.reject(new Error('MANYCHAT_API_TOKEN is not set; cannot perform actions')),
    };
  }
  return new ManyChatHttpClient({
    apiToken: env.MANYCHAT_API_TOKEN,
    baseUrl: env.MANYCHAT_API_BASE,
    replyField: env.MANYCHAT_REPLY_FIELD,
    replyFlowNs: env.MANYCHAT_REPLY_FLOW_NS ?? '',
    tokenField: env.MANYCHAT_TOKEN_FIELD,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}
