import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigMigration, MigrationTarget } from './index.ts';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const isObject = (value: Json | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `from` renamed to `to` in place, keeping the key order, so a diff of the
 * migrated file shows the rename and nothing else. A key already renamed is
 * left as it is, never overwritten.
 */
function renameKey(object: JsonObject, from: string, to: string): JsonObject {
  if (!(from in object) || to in object) return object;
  return Object.fromEntries(
    Object.entries(object).map(([key, value]) => [key === from ? to : key, value]),
  );
}

function catalog(raw: JsonObject): JsonObject {
  const renamed = renameKey(raw, 'courses', 'offerings');
  const offerings = renamed.offerings;
  if (!Array.isArray(offerings)) return renamed;
  return {
    ...renamed,
    offerings: offerings.map(entry =>
      isObject(entry) ? renameKey(entry, 'enrollmentUrl', 'url') : entry,
    ),
  };
}

function tools(raw: JsonObject): JsonObject {
  const each = (key: string) =>
    Array.isArray(raw[key])
      ? raw[key].map(entry => (isObject(entry) ? renameKey(entry, 'course', 'offering') : entry))
      : raw[key];
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [
      key,
      key === 'fields' || key === 'flows' ? (each(key) as Json) : value,
    ]),
  );
}

function rules(raw: JsonObject): JsonObject {
  const learning = raw.learning;
  if (!isObject(learning)) return raw;
  return { ...raw, learning: renameKey(learning, 'enrolledTag', 'convertedTag') };
}

/** Rewrites a JSON file only when the rename changes it, so a migrated file stays byte-identical. */
function rewriteJson(path: string, change: (raw: JsonObject) => JsonObject): void {
  if (!existsSync(path)) return;
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Json;
  if (!isObject(raw)) return;
  const next = change(raw);
  if (JSON.stringify(next) === JSON.stringify(raw)) return;
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n');
}

/**
 * The spacing the repository's suites are written in (`{"id": "a", "b": 1}`),
 * so a rewritten case reads like the ones around it.
 */
function spaced(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(spaced).join(', ')}]`;
  if (isObject(value)) {
    const entries = Object.entries(value).map(
      ([key, item]) => `${JSON.stringify(key)}: ${spaced(item)}`,
    );
    return `{${entries.join(', ')}}`;
  }
  return JSON.stringify(value);
}

/** Only the lines that carry an old key change; every other byte is kept. */
function rewriteCases(path: string): void {
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n').map(line => {
    if (line.trim() === '') return line;
    let parsed: Json;
    try {
      parsed = JSON.parse(line) as Json;
    } catch {
      // The case loader reports a broken line; a migration does not guess at one.
      return line;
    }
    if (!isObject(parsed) || !isObject(parsed.contact)) return line;
    const contact = renameKey(
      renameKey(parsed.contact, 'course', 'offering'),
      'advert_course',
      'advert_offering',
    );
    if (JSON.stringify(contact) === JSON.stringify(parsed.contact)) return line;
    return spaced({ ...parsed, contact });
  });
  const next = lines.join('\n');
  if (next !== text) writeFileSync(path, next);
}

/**
 * specs/042: the sales layer's words for what is sold and for a completed
 * sale. Invents no value and leaves `prompt.md` and every ManyChat object
 * alone.
 */
export const offerings: ConfigMigration = {
  version: '0.22.0',
  migrate({ configDir, evalFiles }: MigrationTarget) {
    rewriteJson(join(configDir, 'catalog.json'), catalog);
    rewriteJson(join(configDir, 'tools.json'), tools);
    rewriteJson(join(configDir, 'rules.json'), rules);
    for (const file of evalFiles) rewriteCases(file);
  },
};
