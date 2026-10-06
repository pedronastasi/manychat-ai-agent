/**
 * A turn's place in its contact's order: `ready` settles when it may run, and
 * `leave` lets the next one in.
 */
export interface TurnSlot {
  /** Whether an earlier turn of the contact held the slot when this one asked. */
  waited: boolean;
  /** Settles with `'expired'` when the earlier turn outran the bound. */
  ready: Promise<'ready' | 'expired'>;
  leave: () => void;
}

/**
 * One turn at a time per contact, in the order their requests arrived
 * (specs/037 § Turns that enter history run one at a time). Kept in the process
 * that receives the requests, so one instance is shared by every request.
 */
export class TurnLanes {
  private readonly maxWaitMs: number;
  /** Each contact's last turn to enter, settling when it leaves. */
  private readonly tails = new Map<string, Promise<void>>();

  /** `maxWaitMs`: past it, an earlier turn is no longer waited for (C6). */
  constructor(maxWaitMs: number) {
    this.maxWaitMs = maxWaitMs;
  }

  enter(contact: string): TurnSlot {
    const before = this.tails.get(contact);
    let leave!: () => void;
    const left = new Promise<void>(resolve => (leave = resolve));
    const ready = before ? this.bounded(before) : Promise.resolve('ready' as const);
    const tail = ready.then(() => left);
    this.tails.set(contact, tail);
    void tail.then(() => {
      if (this.tails.get(contact) === tail) this.tails.delete(contact);
    });
    return { waited: before !== undefined, ready, leave };
  }

  private bounded(before: Promise<void>): Promise<'ready' | 'expired'> {
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve('expired'), this.maxWaitMs);
      void before.then(() => {
        clearTimeout(timer);
        resolve('ready');
      });
    });
  }
}
