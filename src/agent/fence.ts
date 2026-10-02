/**
 * Delimiter used to fence untrusted contact text. Chosen to be something a
 * contact is vanishingly unlikely to type, and stripped from input before
 * fencing so it cannot be forged (Constitution C4).
 *
 * Its own module so the tools, which fence what a contact read returns
 * (specs/024), need not import the prompt that imports them.
 */
export const FENCE = '<<<CONTACT_MESSAGE>>>';
export const FENCE_END = '<<<END_CONTACT_MESSAGE>>>';

/**
 * Wraps untrusted contact text. The fence markers are stripped from the input
 * first, so a contact cannot close the fence and append their own instructions.
 */
export function fenceUserText(text: string): string {
  const cleaned = text.split(FENCE).join('').split(FENCE_END).join('');
  return `${FENCE}\n${cleaned}\n${FENCE_END}`;
}
