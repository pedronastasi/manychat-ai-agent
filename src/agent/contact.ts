import type { Tools } from '../contracts/config.ts';
import type { ContactRecord } from '../contracts/manychat.ts';
import type { ContactReader } from '../channels/manychat/client.ts';
import { IDENTIFIER_SHAPES } from '../observability/redact.ts';
import { fenceUserText } from './fence.ts';

/**
 * How long one read may take before the turn goes on without it, so that a
 * slow `getInfo` cannot consume the race. Chosen, not measured (specs/024
 * § A read is performed, and its failure is not an escalation).
 */
export const READ_TIMEOUT_MS = 1500;

/** Reads a turn may make. A third call makes no request. Chosen, not measured. */
export const MAX_READS_PER_TURN = 2;

/** What an enum field reads as when it holds anything but a configured value. */
export const OTHER_VALUE = 'other';

/** What `get_contact` answers when there is nothing it may say. */
export const UNAVAILABLE = { available: false } as const;

/** The whitelist `get_contact` returns: configured ids and values, and the notes' text. */
export interface ContactView {
  tags: string[];
  fields: Record<string, string | null>;
  notes: Record<string, string | null>;
}

/**
 * Reduces the contact's record to what `tools.json` lists as readable
 * (specs/024 § `get_contact` returns a whitelist, never the subscriber).
 *
 * A tag or field is matched by its ManyChat name and returned by its id, so the
 * model never sees the names. An enum value outside the field's `values` reads
 * as `other`: a flow may have filled it from the contact's typing.
 */
export function contactView(record: ContactRecord, tools: Tools): ContactView {
  const has = new Set(record.tags);
  const values = new Map(record.custom_fields.map(field => [field.name, field.value]));
  const valueOf = (field: string) => {
    const value = values.get(field);
    return value === undefined || value === null || value === '' ? null : String(value);
  };

  const tags = [...tools.tags, ...tools.readable.tags]
    .filter(entry => has.has(entry.tag))
    .map(entry => entry.id);

  const fields = Object.fromEntries(
    [...tools.fields, ...tools.readable.fields].map(entry => {
      const value = valueOf(entry.field);
      return [entry.id, value === null || entry.values.includes(value) ? value : OTHER_VALUE];
    }),
  );

  const notes = Object.fromEntries(
    tools.notes.map(note => [note.id, valueOf(note.field)?.slice(0, note.maxLength) ?? null]),
  );

  return { tags, fields, notes };
}

/**
 * The view as the model reads it. A note is model output summarising the
 * contact's words, so it goes back inside the same fence as their messages;
 * tags and fields are configured ids by construction and stay outside it (C4).
 */
export function contactResult(view: ContactView) {
  return { tags: view.tags, fields: view.fields, notes: fenceUserText(JSON.stringify(view.notes)) };
}

/** Control characters, newlines among them: a note is one line. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * A note's text as it may be written, or the empty string when nothing is
 * left (specs/024 § Note text is cleaned before it is written):
 *
 * 1. URL, email, phone and long-number shapes become `[removed]`;
 * 2. control characters go and whitespace collapses;
 * 3. text over `maxLength` is cut at a word boundary.
 */
export function cleanNote(text: string, maxLength: number): string {
  const stripped = IDENTIFIER_SHAPES.reduce(
    (current, { shape }) => current.replace(shape, '[removed]'),
    text,
  );
  const collapsed = stripped.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) return collapsed;
  const cut = collapsed.slice(0, maxLength + 1);
  const boundary = cut.lastIndexOf(' ');
  // A single word longer than the note is cut where the note ends.
  return (boundary > 0 ? cut.slice(0, boundary) : collapsed.slice(0, maxLength)).trimEnd();
}

export interface ReadLogger {
  warn: (fields: object, message: string) => void;
}

/**
 * The turn's reads of its own contact. Built per turn by the caller, which
 * knows the subscriber, so `get_contact` takes no parameter and cannot read
 * anyone else (specs/024, specs/012 § The subscriber is never a parameter).
 *
 * Unlike every other tool, a read is performed when the model calls it
 * (ADR-0016): it has no effect on the contact for an escalation to undo.
 */
export class ContactReads {
  private readonly reader: ContactReader;
  private readonly subscriberId: string;
  private readonly logger: ReadLogger;
  private readonly timeoutMs: number;
  private made = 0;
  private last: ContactView | undefined;

  constructor(opts: {
    reader: ContactReader;
    subscriberId: string;
    logger: ReadLogger;
    timeoutMs?: number;
  }) {
    this.reader = opts.reader;
    this.subscriberId = opts.subscriberId;
    this.logger = opts.logger;
    this.timeoutMs = opts.timeoutMs ?? READ_TIMEOUT_MS;
  }

  /** Requests made so far this turn. */
  get count(): number {
    return this.made;
  }

  /** The most recent successful read, which the reply step is shown. */
  get latest(): ContactView | undefined {
    return this.last;
  }

  /**
   * The contact as `tools.json` lets the model see it, or `UNAVAILABLE`. A
   * failed or slow read is not an escalation: the turn continues without it,
   * and a turn that then cannot ground its answer escalates for that reason.
   */
  async read(tools: Tools, signal?: AbortSignal): Promise<ContactView | typeof UNAVAILABLE> {
    if (this.made >= MAX_READS_PER_TURN) return UNAVAILABLE;
    this.made++;
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new Error('contact read timed out')),
      this.timeoutMs,
    );
    const abandon = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    try {
      // Raced as well as aborted, so a reader that ignores its signal is still
      // given up on in time.
      const record = await Promise.race([
        this.reader.readContact(this.subscriberId, abandon),
        new Promise<never>((_resolve, reject) => {
          abandon.addEventListener('abort', () => reject(new Error('contact read abandoned')), {
            once: true,
          });
        }),
      ]);
      this.last = contactView(record, tools);
      return this.last;
    } catch (error) {
      // The error's name only: ManyChat's message can quote the subscriber (C5).
      this.logger.warn(
        {
          tool: 'get_contact',
          error: error instanceof Error ? error.name : typeof error,
          timedOut: timeout.signal.aborted,
        },
        'contact read failed',
      );
      return UNAVAILABLE;
    } finally {
      clearTimeout(timer);
    }
  }
}
