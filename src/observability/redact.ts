/**
 * PII redaction (Constitution C5).
 *
 * Applied at the logger, not the call site, so a new log statement cannot opt
 * out of it by forgetting. Conversation text is the highest-risk field: it is
 * free-form and routinely contains phone numbers and full names.
 */

const PHONE = /(?:\+?\d[\d\s().-]{7,}\d)/g;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]{2,}/g;
/** Long digit runs: document and card numbers. */
const LONG_DIGITS = /\b\d{7,}\b/g;
/**
 * Any URL on ManyChat's media host, in any region and of any shape. Broader
 * than the shape the adapter recognises on purpose: a URL it no longer
 * recognises is still a permanent, unauthenticated link to a contact's voice
 * or photo (specs/020 § The URL never reaches storage or logs).
 */
const MEDIA_URL = /https?:\/\/manybot-files\.s3[\w.-]*\.amazonaws\.com[^\s"'\\<>]*/gi;

/** Any other link: a profile, a booking page, a document the contact shared. */
const URL = /\b(?:https?:\/\/|www\.)[^\s"'\\<>]+/gi;

/**
 * The identifier shapes this service removes, in the order they are applied:
 * a URL can hold an email or digits, and an email can hold digits. Shared with
 * the cleaning of agent notes, so a change here is a change to both (specs/024
 * § Note text is cleaned before it is written).
 */
export const IDENTIFIER_SHAPES = [
  { shape: URL, label: '[url]' },
  { shape: EMAIL, label: '[email]' },
  { shape: PHONE, label: '[phone]' },
  { shape: LONG_DIGITS, label: '[number]' },
] as const;

export function redactMediaUrls(input: string): string {
  return input.replace(MEDIA_URL, '[media-url]');
}

export function redactText(input: string): string {
  return IDENTIFIER_SHAPES.reduce(
    (text, { shape, label }) => text.replace(shape, label),
    redactMediaUrls(input),
  );
}

/**
 * Wraps the log destination so every serialized line loses its media URLs.
 * Applied to the line rather than to known fields: the URL arrives as the
 * contact's text, and text reaches log lines by more routes than a path list
 * can name.
 */
export function mediaScrubbingStream(destination: { write(line: string): unknown }) {
  return { write: (line: string) => void destination.write(redactMediaUrls(line)) };
}

/**
 * Paths pino redacts outright. Secrets are removed rather than masked — a
 * partially masked credential is still a credential leak.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.body.text',
  'req.body.first_name',
  'req.body.last_name',
  'req.body.ai_token',
  'res.headers["set-cookie"]',
  '*.apiKey',
  '*.apiToken',
  '*.secret',
  '*.password',
  'env.ANTHROPIC_API_KEY',
  'env.OPENAI_API_KEY',
  'env.GOOGLE_GENERATIVE_AI_API_KEY',
  'env.MANYCHAT_SHARED_SECRET',
  'env.MANYCHAT_API_TOKEN',
  'env.DATABASE_URL',
];
