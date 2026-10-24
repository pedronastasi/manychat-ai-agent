import type { ContactReader, ManyChatClient } from '../../channels/manychat/client.ts';
import type { PerformableAction } from '../../contracts/agent.ts';
import type { ContactRecord } from '../../contracts/manychat.ts';

/**
 * What the contact saw, in the order they saw it: a flow, or a reply's
 * messages, inline or from the outbox (specs/043 § The production turn path
 * determines state and action outcomes).
 */
export type Delivery =
  | { kind: 'flow'; step: string; id: string; origin?: string | undefined }
  | { kind: 'reply'; step: string; messages: string[]; via: 'inline' | 'outbox' };

/**
 * ManyChat for a conversation run: the action endpoints, the contact read,
 * the token field and reply delivery, at the ports the production code
 * depends on. A write lands in the contact's record only once it succeeds,
 * and a request named in `failing` is refused as ManyChat refuses one. It
 * makes no network request.
 */
export class SimulatedChannel implements ManyChatClient, ContactReader {
  /** The step the harness is running, stamped on every delivery. */
  step = '';
  readonly deliveries: Delivery[] = [];
  /** `tool:id` pairs the channel refuses, such as `send_flow:enrolment_link`. */
  readonly failing = new Set<string>();
  private readonly tokens = new Map<string, string>();
  private readonly fields = new Map<string, Map<string, string>>();
  private readonly tags = new Map<string, Set<string>>();

  writeToken(subscriberId: string, token: string): Promise<void> {
    this.tokens.set(subscriberId, token);
    return Promise.resolve();
  }

  tokenOf(subscriberId: string): string | null {
    return this.tokens.get(subscriberId) ?? null;
  }

  sendText(_subscriberId: string, messages: string[]): Promise<void> {
    this.deliveries.push({
      kind: 'reply',
      step: this.step,
      messages: [...messages],
      via: 'outbox',
    });
    return Promise.resolve();
  }

  /** A reply the turn handed back inline, recorded by the harness when the response goes out. */
  deliverInline(messages: string[]): void {
    this.deliveries.push({
      kind: 'reply',
      step: this.step,
      messages: [...messages],
      via: 'inline',
    });
  }

  performAction(subscriberId: string, action: PerformableAction): Promise<void> {
    if (this.failing.has(`${action.tool}:${action.id}`)) {
      return Promise.reject(new Error('the simulated channel refused the request'));
    }
    const fields = this.fieldsOf(subscriberId);
    const tags = this.tagsOf(subscriberId);
    switch (action.tool) {
      case 'send_flow':
        this.deliveries.push({
          kind: 'flow',
          step: this.step,
          id: action.id,
          origin: action.origin,
        });
        break;
      case 'set_field':
        fields.set(action.field, action.value);
        break;
      case 'write_note':
        fields.set(action.field, action.text);
        break;
      case 'add_tag':
        tags.add(action.tag);
        break;
      case 'remove_tag':
        tags.delete(action.tag);
        break;
      case 'send_event':
        // A tracking flow sends the contact nothing (specs/027).
        break;
      default:
        return Promise.reject(new Error(`the simulated channel cannot perform ${action.tool}`));
    }
    return Promise.resolve();
  }

  readContact(subscriberId: string): Promise<ContactRecord> {
    return Promise.resolve({
      tags: [...this.tagsOf(subscriberId)],
      custom_fields: [...this.fieldsOf(subscriberId)].map(([name, value]) => ({ name, value })),
    });
  }

  /** A field's value by its ManyChat name, or null. */
  field(subscriberId: string, name: string): string | null {
    return this.fieldsOf(subscriberId).get(name) ?? null;
  }

  hasTag(subscriberId: string, tag: string): boolean {
    return this.tagsOf(subscriberId).has(tag);
  }

  /** Seeds a returning contact's record, as an earlier performed action left it. */
  seed(subscriberId: string, action: PerformableAction): Promise<void> {
    const before = this.deliveries.length;
    return this.performAction(subscriberId, action).then(() => {
      // Seeded state was never delivered in this run.
      this.deliveries.splice(before);
    });
  }

  private fieldsOf(subscriberId: string): Map<string, string> {
    let fields = this.fields.get(subscriberId);
    if (!fields) this.fields.set(subscriberId, (fields = new Map<string, string>()));
    return fields;
  }

  private tagsOf(subscriberId: string): Set<string> {
    let tags = this.tags.get(subscriberId);
    if (!tags) this.tags.set(subscriberId, (tags = new Set<string>()));
    return tags;
  }
}
