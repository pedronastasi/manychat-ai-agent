/** What the model reads about the tools: their listings and the notes on their results. */

export const idsOf = (entries: { id: string }[]) =>
  entries.map(entry => entry.id) as [string, ...string[]];

export const catalogOf = (
  entries: {
    id: string;
    description: string;
    offering?: string | undefined;
    onStage?: string | undefined;
    silent?: boolean | undefined;
  }[],
) =>
  entries
    .map(entry => {
      const notes = [
        entry.offering === undefined ? null : `offering ${entry.offering}`,
        entry.onStage === undefined ? null : `sent by the system when you record ${entry.onStage}`,
        entry.silent ? 'silent: sends the contact nothing' : null,
      ].filter(Boolean);
      return `- ${entry.id}${notes.length > 0 ? ` (${notes.join('; ')})` : ''}: ${entry.description}`;
    })
    .join('\n');

export const STAGED =
  'The action is staged, not performed: it happens after your reply is sent, and not at all if the turn escalates.';

export const SENT_NOW =
  'The flow is sent when you call this, before your reply: the contact receives it first and your reply follows it. Do not repeat what it contains. The result says whether it went out.';

export const SILENT =
  'A silent flow sends the contact nothing: write your reply in full, as if it had not been sent.';

/** The note a silent flow's result carries; the payment link's names the link. */
export const silentResult = (role: string | undefined) =>
  role === 'payment_link'
    ? 'The contact received nothing from this flow. Your reply must carry the link of the contact’s offering from the CATALOG.'
    : 'The contact received nothing from this flow. Write your reply in full, as if it had not been sent.';

export const CONTACT_ASKED =
  'The payment link is refused before the stage is prepared. Pass contactAsked: true only when the contact’s message this turn asks for the link, the payment methods or how to pay; it is recorded.';

export const STAGED_NOTE =
  'The note is staged, not written: it is written after your reply is sent. It replaces what the note held, so read it first with get_contact to add to it.';
