import type { ContactTokenWriter } from '../../src/conversation/tokens.ts';

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

export interface ManyChatCall {
  path: string;
  body: Record<string, unknown>;
}

/**
 * The ManyChat API at its HTTP boundary, for `buildServer`: it records every
 * call, keeps each contact's custom fields, and answers as ManyChat does when
 * it accepts a request.
 */
export function fakeManyChatApi() {
  const calls: ManyChatCall[] = [];
  const fields = new Map<string, Map<string, string>>();
  const state = { failing: false };

  const fetchImpl = ((url: string, init: { body: string }) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ path, body });
    if (state.failing) {
      return Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve('down') });
    }
    if (path === '/fb/subscriber/setCustomFieldByName') {
      const subscriber = String(body.subscriber_id);
      const contact = fields.get(subscriber) ?? new Map<string, string>();
      contact.set(String(body.field_name), String(body.field_value));
      fields.set(subscriber, contact);
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve('{"status":"success"}'),
    });
  }) as unknown as typeof fetch;

  return {
    fetch: fetchImpl,
    calls,
    state,
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
