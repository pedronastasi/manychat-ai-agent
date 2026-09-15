/**
 * Sends a Dynamic Block request to a running local server, exactly as ManyChat
 * would, and prints what a contact would actually receive.
 *
 * Dev Tools require a paid ManyChat plan, so without this the agent could not be
 * developed or demonstrated at all before upgrading (ADR-0005).
 *
 *   pnpm simulate "how much is the foundation course?"
 *   pnpm simulate --subscriber 42 "can you give me a discount?"
 */
import { loadEnv } from '../../config/loader.ts';
import { ManyChatResponse } from '../../contracts/manychat.ts';

function parseArgs(argv: string[]) {
  let subscriber = 'sim-001';
  const words: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--subscriber' || argv[index] === '-s') {
      subscriber = argv[++index] ?? subscriber;
    } else {
      words.push(argv[index]!);
    }
  }
  return { subscriber, text: words.join(' ') };
}

async function main() {
  const env = loadEnv();
  const { subscriber, text } = parseArgs(process.argv.slice(2));

  if (!text) {
    console.error('Usage: pnpm simulate [--subscriber <id>] "<message>"');
    process.exit(2);
  }

  const url = `http://127.0.0.1:${env.PORT}/v1/channels/manychat/message`;
  const started = Date.now();

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.MANYCHAT_SHARED_SECRET[0]}`,
    },
    body: JSON.stringify({ subscriber_id: subscriber, text }),
  });

  const elapsed = Date.now() - started;
  const raw: unknown = await res.json();

  console.log(`\n  contact   ${text}`);
  console.log(`  ${'-'.repeat(60)}`);

  if (!res.ok) {
    console.log(`  HTTP ${res.status}`, JSON.stringify(raw));
    process.exit(1);
  }

  const parsed = ManyChatResponse.safeParse(raw);
  if (!parsed.success) {
    console.log('  INVALID Dynamic Block v2 response:');
    console.log(JSON.stringify(parsed.error.issues, null, 2));
    process.exit(1);
  }

  for (const message of parsed.data.content.messages) {
    if (message.type === 'text') console.log(`  agent     ${message.text}`);
    else console.log(`  agent     [${message.type}] ${'url' in message ? message.url : ''}`);
  }

  const cb = parsed.data.content.external_message_callback;
  console.log(`  ${'-'.repeat(60)}`);
  console.log(
    `  ${elapsed}ms` +
      `  |  callback: ${cb ? 'registered' : 'none'}` +
      // The check that matters on WhatsApp: the key must be absent entirely.
      `  |  quick_replies: ${'quick_replies' in parsed.data.content ? 'PRESENT' : 'omitted'}` +
      (elapsed > 10_000 ? '  |  OVER MANYCHAT 10s LIMIT' : ''),
  );
  console.log();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    message.includes('ECONNREFUSED')
      ? 'No server on that port. Start it with `pnpm dev` first.'
      : message,
  );
  process.exit(1);
});
