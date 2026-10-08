import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { offerings } from './offerings.ts';

/**
 * What a migration may rewrite: the tenant's `config/`, and its eval suites,
 * which live in the project beside it (specs/042 § Existing tenants move with
 * `agent upgrade`).
 */
export interface MigrationTarget {
  configDir: string;
  /** Every `cases.jsonl` the project holds, each once. */
  evalFiles: string[];
}

export interface ConfigMigration {
  version: string;
  migrate(target: MigrationTarget): void;
}

const migrations: ConfigMigration[] = [offerings];

export interface MigrationOptions {
  /** The project root whose `evals/<name>/cases.jsonl` are rewritten. Default: the cwd. */
  root?: string | undefined;
  /** `EVAL_DIR`, when it is set and may lie outside `evals/`. */
  evalDir?: string | undefined;
}

export function runMigrations(
  dir: string,
  options: MigrationOptions = {},
): { applied: string[]; unchanged: boolean } {
  const target: MigrationTarget = { configDir: dir, evalFiles: evalFiles(options) };
  const applied: string[] = [];
  for (const migration of migrations) {
    const before = snapshot(target);
    migration.migrate(target);
    const after = snapshot(target);
    if (before !== after) applied.push(migration.version);
  }
  return { applied, unchanged: applied.length === 0 };
}

/**
 * `evals/*` under the root, and `EVAL_DIR` beside them. Not `EVAL_DIR` alone:
 * a project scaffolded by specs/035 sets it only inside its `eval` script.
 */
function evalFiles({ root = process.cwd(), evalDir }: MigrationOptions): string[] {
  const evals = join(root, 'evals');
  const dirs = existsSync(evals)
    ? readdirSync(evals, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => join(evals, entry.name))
    : [];
  if (evalDir !== undefined) dirs.push(resolve(root, evalDir));
  const files = dirs.map(dir => resolve(dir, 'cases.jsonl')).filter(file => existsSync(file));
  return [...new Set(files)];
}

function snapshot(target: MigrationTarget): string {
  const files = [
    ...['prompt.md', 'catalog.json', 'rules.json', 'tools.json'].map(file =>
      join(target.configDir, file),
    ),
    ...target.evalFiles,
  ];
  return files.map(path => (existsSync(path) ? readFileSync(path, 'utf8') : '')).join('\0');
}

export function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function writeJsonFile(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}
