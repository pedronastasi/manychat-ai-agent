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

export function redactText(input: string): string {
  return input.replace(EMAIL, '[email]').replace(PHONE, '[phone]').replace(LONG_DIGITS, '[number]');
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
