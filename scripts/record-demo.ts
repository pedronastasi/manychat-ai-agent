/**
 * Records the README's demo (specs/021-contributor-surface.md § The README's
 * first screen): boots the server against the fixture tenant and the mock
 * model, sends one question and one escalation through the simulator, and
 * writes what it printed as an animated SVG. Run via `pnpm demo:record`.
 *
 * The tenant and model are fixed here rather than read from the environment,
 * so a recording can never be made against a real deployment's config (C1).
 */
import { execFile, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { promisify } from 'node:util';

const OUTPUT = 'docs/assets/demo.svg';
const PORT = '3999';
const MESSAGES = ['how much is the foundation course?', 'I want to speak to a human'];

const NODE_FLAGS = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'];

const ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  NODE_ENV: 'development',
  PORT,
  LOG_LEVEL: 'error',
  AGENT_MODEL: 'mock:demo',
  DATABASE_URL: 'pglite',
  CONFIG_DIR: 'test/fixtures/config',
  PUBLIC_BASE_URL: 'https://demo.example.com',
  MANYCHAT_SHARED_SECRET: 'demo-secret-demo-secret',
};

const FONT_SIZE = 13;
const CHAR_WIDTH = FONT_SIZE * 0.6;
const LINE_HEIGHT = 20;
const WRAP_AT = 86;
/** `  contact   ` and `  agent     `: the simulator's label column. */
const LABEL_WIDTH = 12;
const PADDING = 20;
const CHROME = 36;

const TYPE_MS = 35;
const LINE_MS = 90;
const PAUSE_MS = 500;
const HOLD_MS = 2200;
const END_HOLD_MS = 4000;

interface Line {
  text: string;
  kind: 'command' | 'contact' | 'agent' | 'rule' | 'footer' | 'blank';
  continuation?: boolean;
}

async function waitForReady(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/ready`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('server did not become ready within 60s');
}

async function simulate(message: string): Promise<string> {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [...NODE_FLAGS, 'src/channels/manychat/simulator.ts', message],
    { env: ENV },
  );
  return stdout;
}

/** Null for a line with no label: a reply containing a newline, continuing the message above. */
function classify(text: string): Line['kind'] | null {
  if (text.startsWith('  contact')) return 'contact';
  if (text.startsWith('  agent')) return 'agent';
  if (text.startsWith('  ---')) return 'rule';
  if (/^\s+\d+ms/.test(text)) return 'footer';
  return null;
}

/** The simulator prints each reply on one line; the SVG wraps it under its text column. */
function wrap(text: string): string[] {
  const rows: string[] = [];
  let row = text.slice(0, LABEL_WIDTH);
  for (const word of text.slice(LABEL_WIDTH).split(' ')) {
    const empty = row.length === LABEL_WIDTH;
    if (!empty && row.length + 1 + word.length > WRAP_AT) {
      rows.push(row);
      row = ' '.repeat(LABEL_WIDTH) + word;
    } else {
      row = empty ? row + word : `${row} ${word}`;
    }
  }
  rows.push(row);
  return rows;
}

function toLines(message: string, output: string): Line[] {
  const lines: Line[] = [{ text: `$ pnpm simulate "${message}"`, kind: 'command' }];
  for (const raw of output.split('\n')) {
    if (raw.trim() === '') continue;
    const labelled = classify(raw);
    const kind = labelled ?? lines.at(-1)!.kind;
    const text = labelled ? raw : ' '.repeat(LABEL_WIDTH) + raw;
    const rows = kind === 'contact' || kind === 'agent' ? wrap(text) : [text];
    rows.forEach((row, index) =>
      lines.push({ text: row, kind, continuation: labelled === null || index > 0 }),
    );
  }
  return lines;
}

const escapeXml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function renderRow(line: Line): string {
  const text = escapeXml(line.text);
  if (line.kind === 'command') {
    return `<tspan class="prompt">$</tspan>${text.slice(1)}`;
  }
  if ((line.kind === 'contact' || line.kind === 'agent') && !line.continuation) {
    const label = text.slice(0, LABEL_WIDTH);
    return `<tspan class="${line.kind}">${label}</tspan>${text.slice(LABEL_WIDTH)}`;
  }
  return text;
}

function render(sessions: Line[][]): string {
  const lines: Line[] = sessions.flatMap((session, index) =>
    index === 0 ? session : [{ text: '', kind: 'blank' as const }, ...session],
  );

  // Each line gets its own keyframes over one shared cycle, so the whole
  // recording loops without script.
  const starts: number[] = [];
  let clock = 400;
  for (const line of lines) {
    starts.push(clock);
    if (line.kind === 'command') clock += line.text.length * TYPE_MS + PAUSE_MS;
    else if (line.kind === 'blank') clock += HOLD_MS;
    else clock += LINE_MS;
  }
  const cycle = clock + END_HOLD_MS;
  const percent = (ms: number): string => ((ms / cycle) * 100).toFixed(2);

  const width = Math.ceil(WRAP_AT * CHAR_WIDTH + PADDING * 2);
  const height = CHROME + PADDING + lines.length * LINE_HEIGHT + PADDING / 2;

  const keyframes: string[] = [];
  const rows: string[] = [];
  lines.forEach((line, index) => {
    if (line.kind === 'blank') return;
    const start = starts[index]!;
    const name = `l${index}`;
    if (line.kind === 'command') {
      const typed = start + line.text.length * TYPE_MS;
      keyframes.push(
        `@keyframes ${name}{0%,${percent(start)}%{clip-path:inset(0 100% 0 0);animation-timing-function:steps(${line.text.length},end)}` +
          `${percent(typed)}%,97%{clip-path:inset(0 0 0 0)}100%{clip-path:inset(0 100% 0 0)}}`,
      );
    } else {
      keyframes.push(
        `@keyframes ${name}{0%,${percent(start)}%{opacity:0}${percent(start + 1)}%,97%{opacity:1}100%{opacity:0}}`,
      );
    }
    const baseline = CHROME + PADDING + index * LINE_HEIGHT + FONT_SIZE;
    rows.push(
      `<text x="${PADDING}" y="${baseline}" class="${line.kind}-line" style="animation:${name} ${cycle}ms infinite">${renderRow(line)}</text>`,
    );
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title">
<title id="title">pnpm simulate against the fixture tenant and the mock model: one question answered from the catalog, one request for a person escalated</title>
<style>
text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace;font-size:${FONT_SIZE}px;fill:#c9d1d9;white-space:pre}
.prompt{fill:#7ee787}.contact{fill:#79c0ff}.agent{fill:#d2a8ff}.rule-line{fill:#484f58}.footer-line{fill:#8b949e}.caption{fill:#8b949e;font-size:12px}
${keyframes.join('\n')}
@media (prefers-reduced-motion:reduce){text{animation:none!important}}
</style>
<rect width="${width}" height="${height}" rx="8" fill="#0d1117"/>
<circle cx="20" cy="18" r="6" fill="#ff5f57"/><circle cx="40" cy="18" r="6" fill="#febc2e"/><circle cx="60" cy="18" r="6" fill="#28c840"/>
<text x="${width - PADDING}" y="22" text-anchor="end" class="caption">fixture tenant · mock model · no API key</text>
${rows.join('\n')}
</svg>
`;
}

async function main(): Promise<void> {
  const server = spawn(process.execPath, [...NODE_FLAGS, 'src/main.ts'], {
    env: ENV,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    await waitForReady();
    const sessions: Line[][] = [];
    for (const message of MESSAGES) sessions.push(toLines(message, await simulate(message)));
    writeFileSync(OUTPUT, render(sessions));
    console.log(`wrote ${OUTPUT}`);
  } finally {
    server.kill('SIGTERM');
  }
}

await main();
