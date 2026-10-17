import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { cleanNote } from '../contact.ts';
import { idsOf, STAGED_NOTE } from './copy.ts';
import type { ToolTurn } from './turn.ts';

/** `write_note`: the tenant's free-text notes (specs/024, ADR-0017). */
export function addWriteNote(turn: ToolTurn, tools: ToolSet) {
  const { config, stage } = turn;
  if (config.notes.length > 0) {
    const notes = new Map(config.notes.map(note => [note.id, note]));
    const listing = config.notes
      .map(
        note =>
          `- ${note.id} (at most ${note.maxLength} characters${note.onEscalation ? '; still written if you escalate' : ''}): ${note.description}`,
      )
      .join('\n');
    tools.write_note = tool({
      description:
        `Write one of these notes on the contact, for the people who follow up.\n${listing}\n` +
        'Write what they need, in your own words. Never put a name, phone number, email or link ' +
        `in a note: they are removed before it is written.\n${STAGED_NOTE}`,
      inputSchema: z.object({ note: z.enum(idsOf(config.notes)), text: z.string() }),
      execute: ({ note, text }) => {
        const entry = notes.get(note)!;
        // Cleaned when staged, so the outbox never holds what the field will not.
        const cleaned = cleanNote(text, entry.maxLength);
        if (cleaned.length === 0) return { staged: false };
        return {
          staged: stage.stage({
            tool: 'write_note',
            id: note,
            field: entry.field,
            text: cleaned,
            onEscalation: entry.onEscalation,
          }),
        };
      },
    });
  }
}
