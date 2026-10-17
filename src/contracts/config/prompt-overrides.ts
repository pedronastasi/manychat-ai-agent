import { z } from 'zod';

/**
 * The conversational sections of the system prompt a tenant may replace, in
 * the order the prompt assembles them (specs/044 § Only the named
 * conversational sections are replaceable). The order is the framework's: a
 * file's key order never changes the prompt.
 */
export const PROMPT_SECTIONS = [
  'operating',
  'format',
  'closing',
  'actions',
  'intent',
  'sales',
  'offerings',
  'followUps',
] as const;
export type PromptSection = (typeof PROMPT_SECTIONS)[number];

/** A complete replacement body: text, never a template or an include. */
const SectionBody = z.string().trim().min(1, 'must be a non-empty string');

/**
 * `config/prompt-overrides.json`. Strict, so a misspelt key fails the load
 * rather than leaving the default silently in place.
 */
export const PromptOverridesSchema = z.strictObject(
  Object.fromEntries(PROMPT_SECTIONS.map(key => [key, SectionBody.optional()])) as Record<
    PromptSection,
    z.ZodOptional<typeof SectionBody>
  >,
);
export type PromptOverrides = z.infer<typeof PromptOverridesSchema>;

/** No file, or `{}`: every section keeps its framework default. */
export const NO_PROMPT_OVERRIDES: PromptOverrides = {};
