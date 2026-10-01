/**
 * Writes the documentation site's API reference from the Zod contracts
 * (specs/014-docs-site.md § The API reference is generated). Run via
 * `pnpm docs:api`; `pnpm docs:build` runs it first.
 *
 * The output is gitignored. A committed copy would be a second source of truth
 * for the wire contract, stale the first time a schema changed without it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import { API_PAGE } from '../.vitepress/site.ts';
import { ConfigStore, loadEnv } from '../src/config/loader.ts';
import { createEmbeddedDatabase } from '../src/db/client.ts';
import type { Database } from '../src/db/client.ts';
import { buildServer } from '../src/server.ts';

/**
 * The placeholders CI's eval step runs with: the mock model, an embedded
 * database, the fixture tenant. No model key, no network, no real secret,
 * whatever the caller's shell or `.env` holds.
 */
const PLACEHOLDER_ENV = {
  AGENT_MODEL: 'mock:demo',
  PUBLIC_BASE_URL: 'https://ci.example.com',
  MANYCHAT_SHARED_SECRET: 'ci-secret-ci-secret-ci-secret-xx',
  DATABASE_URL: 'pglite',
  LOG_LEVEL: 'fatal',
};
const FIXTURE_CONFIG = 'test/fixtures/config';

interface Operation {
  summary?: string;
  description?: string;
  security?: Record<string, string[]>[];
  requestBody?: { content?: Record<string, { schema?: unknown }> };
  responses?: Record<
    string,
    { description?: string; content?: Record<string, { schema?: unknown }> }
  >;
}

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string };
  paths?: Record<string, Record<string, Operation>>;
}

export async function exportOpenApi(): Promise<OpenApiDocument> {
  const env = loadEnv(PLACEHOLDER_ENV);
  const embedded = await createEmbeddedDatabase(env.DATABASE_URL);
  const { app } = await buildServer({
    env,
    db: embedded.db as unknown as Database,
    configStore: new ConfigStore(FIXTURE_CONFIG),
  });
  try {
    await app.ready();
    return app.swagger() as unknown as OpenApiDocument;
  } finally {
    await app.close();
    await embedded.client.close();
  }
}

/** Prose from a schema reaches a Vue template, so it must not read as markup. */
const escapeProse = (text: string): string =>
  text.replace(/[<>{}&]/g, character => `&#${character.charCodeAt(0)};`);

const jsonBlock = (value: unknown): string =>
  ['```json', JSON.stringify(value, null, 2), '```'].join('\n');

function renderContent(content: Record<string, { schema?: unknown }> | undefined): string[] {
  return Object.entries(content ?? {}).flatMap(([mediaType, { schema }]) => [
    `\`${mediaType}\``,
    '',
    jsonBlock(schema ?? {}),
    '',
  ]);
}

export function renderApiPage(document: OpenApiDocument): string {
  const lines = [
    '---',
    // There is no file to edit: the page is generated from the schemas.
    'editLink: false',
    '---',
    '',
    '# API reference',
    '',
    `${escapeProse(document.info.title)}, OpenAPI ${escapeProse(document.openapi)}.`,
    '',
    'Generated at build time from the Zod schemas in `src/contracts/`, which also',
    'validate every request at runtime. To change this page, change the schema.',
    '',
  ];

  for (const [path, methods] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(methods)) {
      lines.push(`## \`${method.toUpperCase()} ${path}\``, '');
      for (const prose of [operation.summary, operation.description]) {
        if (prose) lines.push(escapeProse(prose), '');
      }
      const schemes = (operation.security ?? []).flatMap(requirement => Object.keys(requirement));
      if (schemes.length > 0) {
        lines.push(`Authentication: ${schemes.map(scheme => `\`${scheme}\``).join(', ')}.`, '');
      }
      if (operation.requestBody) {
        lines.push('### Request body', '', ...renderContent(operation.requestBody.content));
      }
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        lines.push(`### ${escapeProse(status)}`, '');
        if (response.description) lines.push(escapeProse(response.description), '');
        lines.push(...renderContent(response.content));
      }
    }
  }

  lines.push(
    '## Full document',
    '',
    '::: details OpenAPI JSON',
    '',
    jsonBlock(document),
    '',
    ':::',
    '',
  );
  return lines.join('\n');
}

export async function writeApiPage(path = API_PAGE): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderApiPage(await exportOpenApi()));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await writeApiPage();
  console.log(`wrote ${API_PAGE}`);
}
