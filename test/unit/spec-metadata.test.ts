import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ADR_DIR,
  KEYS,
  STATUSES,
  INDEX_PATH,
  SPECS_DIR,
  adrFiles,
  citationsByNumber,
  constitutionClauses,
  listOf,
  readSpecs,
  renderIndex,
  specFiles,
} from '../../scripts/spec-index.ts';

/**
 * specs/008-spec-metadata.md § Verification.
 *
 * The metadata's only value is that a reader can trust it, and nothing else in
 * the repository notices when it stops being true. An implementation reverted,
 * a spec extended with sections nobody built, an index regenerated and not
 * committed — every one of those leaves a green suite and a spec that lies
 * about the code. These assertions are the falsifiability 008 requires.
 */

const specs = readSpecs();
const numberOf = (file: string): string => file.slice(0, 3);

/** Any mention of `specs/NNN` under test/ — the citation C8 already requires. */
const citedNumbers = new Set(citationsByNumber().keys());

describe('spec frontmatter', () => {
  it('covers every spec, and only specs', () => {
    const markdown = readdirSync(SPECS_DIR).filter(
      name => name.endsWith('.md') && name !== 'README.md',
    );
    expect(specFiles().sort()).toEqual(markdown.sort());
  });

  it.each(specs)('$file declares a recognised status', ({ meta }) => {
    expect(meta).not.toBeNull();
    expect(STATUSES).toContain(meta?.status);
  });

  it.each(specs)('$file uses no unrecognised key', ({ meta }) => {
    for (const key of Object.keys(meta ?? {})) expect(KEYS).toContain(key);
  });

  it.each(specs)('$file dates its implementation exactly when it claims one', ({ meta }) => {
    const claimed = meta?.status === 'implemented';
    expect(meta?.implemented !== undefined).toBe(claimed);
    if (claimed) expect(meta?.implemented).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('reserves `standing` for the constitution', () => {
    const standing = specs.filter(spec => spec.meta?.status === 'standing');
    expect(standing.map(spec => spec.file)).toEqual(['000-constitution.md']);
  });

  it.each(specs)('$file resolves superseded_by when superseded', ({ meta }) => {
    const superseded = meta?.status === 'superseded';
    expect(meta?.superseded_by !== undefined).toBe(superseded);
    if (superseded) {
      const target = specFiles().some(file => numberOf(file) === meta?.superseded_by);
      expect(target).toBe(true);
    }
  });
});

describe('an implemented spec is backed by evidence', () => {
  const implemented = specs.filter(spec => spec.meta?.status === 'implemented');

  it('has specs to check', () => {
    expect(implemented.length).toBeGreaterThan(0);
  });

  it.each(implemented)('$file is cited by at least one test (C8)', ({ file }) => {
    expect(citedNumbers).toContain(numberOf(file));
  });

  it('does not pass by matching every possible number', () => {
    expect(citedNumbers.has('999')).toBe(false);
  });
});

describe('links into the constitution and the ADRs resolve', () => {
  const clauses = constitutionClauses();
  const adrs = adrFiles();

  it('found clauses and ADRs to check against', () => {
    expect(clauses.size).toBeGreaterThan(0);
    expect(adrs.size).toBeGreaterThan(0);
  });

  it.each(specs)('$file cites only real constitution clauses', ({ meta }) => {
    for (const clause of listOf(meta, 'constitution')) expect(clauses).toContain(clause);
  });

  it.each(specs)('$file cites only ADRs that exist and still stand', ({ meta }) => {
    for (const number of listOf(meta, 'adr')) {
      const file = adrs.get(number);
      expect(file, `ADR ${number} does not exist`).toBeDefined();
      const body = readFileSync(join(ADR_DIR, file ?? ''), 'utf8');
      expect(body, `ADR ${number} is superseded`).not.toMatch(/\*\*Status:\*\*\s*superseded/i);
    }
  });

  it('rejects a clause the constitution does not define', () => {
    expect(clauses.has('C99')).toBe(false);
  });
});

describe('the generated index', () => {
  it('matches what the generator produces', () => {
    expect(readFileSync(INDEX_PATH, 'utf8')).toBe(renderIndex());
  });

  it('marks 007 as not yet built, so the table is not uniformly green', () => {
    expect(readFileSync(INDEX_PATH, 'utf8')).toMatch(/007-local-model\.md\)\s*\|\s*specified/);
  });
});
