import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface ConfigMigration {
  version: string;
  migrate(dir: string): void;
}

const migrations: ConfigMigration[] = [];

export function runMigrations(dir: string): { applied: string[]; unchanged: boolean } {
  const applied: string[] = [];
  for (const migration of migrations) {
    const before = snapshot(dir);
    migration.migrate(dir);
    const after = snapshot(dir);
    if (before !== after) applied.push(migration.version);
  }
  return { applied, unchanged: applied.length === 0 };
}

function snapshot(dir: string): string {
  const files = ['prompt.md', 'catalog.json', 'rules.json', 'tools.json'];
  return files
    .map(file => {
      const path = join(dir, file);
      return existsSync(path) ? readFileSync(path, 'utf8') : '';
    })
    .join('\0');
}

export function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function writeJsonFile(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}
