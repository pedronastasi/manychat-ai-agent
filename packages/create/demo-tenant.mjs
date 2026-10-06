/**
 * The fictional demo tenant, as both `pnpm bootstrap` and `create` start from
 * it (specs/035). One list and one set of edits, so the two cannot drift into a
 * second copy of the example tenant.
 */

/** The committed examples a first run copies, and the names they take. */
export const EXAMPLE_CONFIG = [
  ['config/prompt.md.example', 'config/prompt.md'],
  ['config/catalog.json.example', 'config/catalog.json'],
  ['config/rules.json.example', 'config/rules.json'],
];

/** Each line of `.env.example` an offline first run replaces, and with what. */
const OFFLINE = [
  ['MANYCHAT_SHARED_SECRET=change-me-to-a-long-random-string', 'MANYCHAT_SHARED_SECRET=<secret>'],
  // A runnable offline setup: no API key, no database to install.
  ['AGENT_MODEL=anthropic:claude-haiku-4-5', 'AGENT_MODEL=mock:demo'],
  ['DATABASE_URL=postgres://agent:agent@localhost:5432/agent', 'DATABASE_URL=pglite'],
  // With no ManyChat account there is no field to hold a contact's token, so
  // `simulate` could never present one and would get no history.
  ['CONTACT_TOKENS_ENFORCED=true', 'CONTACT_TOKENS_ENFORCED=false'],
];

/**
 * `.env.example` with the offline defaults. Throws when a line it replaces is
 * gone, rather than writing a `.env` that silently needs an API key.
 */
export function offlineEnv(example, secret) {
  let env = example;
  for (const [line, replacement] of OFFLINE) {
    if (!env.includes(line)) throw new Error(`.env.example no longer contains: ${line}`);
    env = env.replace(line, replacement.replace('<secret>', secret));
  }
  return env;
}
