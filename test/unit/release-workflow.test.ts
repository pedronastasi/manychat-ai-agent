import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * specs/010-release-workflow.md § Verification.
 *
 * Every property here fails somewhere other than where it is caused. A missing
 * changelog section drops commits from notes nobody reads until a release; a
 * missing .prettierignore entry fails an unrelated pull request; a workflow
 * that gains write access fails nothing at all.
 */

const WORKFLOW_DIR = '.github/workflows';
const SPEC_PATH = 'specs/010-release-workflow.md';

const config = JSON.parse(readFileSync('release-please-config.json', 'utf8')) as {
  packages: Record<
    string,
    {
      'bump-minor-pre-major'?: boolean;
      'bump-patch-for-minor-pre-major'?: boolean;
      'changelog-sections'?: {
        type: string;
        scope?: string;
        section: string;
        hidden?: boolean;
      }[];
    }
  >;
};

const rootPackage = config.packages['.'];
const sections = rootPackage?.['changelog-sections'] ?? [];

/**
 * The prefix table in specs/010 § The default changelog sections is the source
 * of truth (C8). Reading it here means adding a row without a section — or a
 * section without a row — fails, rather than diverging quietly.
 */
const specTable = [
  ...readFileSync(SPEC_PATH, 'utf8').matchAll(
    /^\|\s*`([a-z]+(?:\([a-z]+\))?)`\s*\|\s*([^|]+?)\s*\|\s*(Yes|No)\s*\|$/gm,
  ),
].map(row => {
  const match = row[1]!.match(/^([a-z]+)(?:\(([a-z]+)\))?$/);
  return {
    type: match![1]!,
    scope: match![2],
    key: row[1]!,
    section: row[2]!,
    hidden: row[3] === 'Yes',
  };
});

describe('the changelog sections match the commit prefixes this repository admits', () => {
  it('found the table in the spec', () => {
    // Guards the regex above: a reformatted table would otherwise silently
    // reduce every assertion below to a loop over nothing.
    expect(specTable.length).toBeGreaterThan(0);
  });

  it.each(specTable)(
    'declares a section for $key',
    ({ type, scope, section, hidden }: (typeof specTable)[number]) => {
      const declared = sections.find(
        entry => entry.type === type && (entry.scope ?? undefined) === scope,
      );
      expect(
        declared,
        `no changelog-sections entry for \`${scope ? `${type}(${scope})` : type}:\``,
      ).toBeDefined();
      expect(declared?.section).toBe(section);
      expect(declared?.hidden ?? false).toBe(hidden);
    },
  );

  it('declares nothing the spec does not list', () => {
    const sectionKey = (entry: { type: string; scope?: string }) =>
      entry.scope ? `${entry.type}(${entry.scope})` : entry.type;
    const spec = specTable.map(row => row.key).sort();
    expect(sections.map(sectionKey).sort()).toEqual(spec);
  });

  it('keeps refactor and docs visible', () => {
    // specs/010: a `refactor:` here moved every customer-facing string out of
    // src/, and a `docs:` is how a spec lands. release-please hides both by
    // default, which is the mistake this config exists to correct.
    for (const type of ['refactor', 'docs']) {
      expect(sections.find(entry => entry.type === type)?.hidden ?? false).toBe(false);
    }
  });
});

describe('versioning before 1.0', () => {
  it('treats a breaking change as a minor bump', () => {
    // specs/010 § Before 1.0: without this, the first `!` commit silently
    // declares an interface nobody promised.
    expect(rootPackage?.['bump-minor-pre-major']).toBe(true);
  });

  it('keeps feat: on the minor rather than demoting it to a patch', () => {
    expect(rootPackage?.['bump-patch-for-minor-pre-major']).toBe(false);
  });

  it('starts from the version package.json already declares', () => {
    // release-please computes the next version from the manifest, not from
    // package.json. Drift between them bumps from the wrong base.
    const manifest = JSON.parse(readFileSync('.release-please-manifest.json', 'utf8')) as Record<
      string,
      string
    >;
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
    expect(manifest['.']).toBe(pkg.version);
  });
});

describe('the generated changelog stays out of the format check', () => {
  it('is listed in .prettierignore', () => {
    // specs/010 § CHANGELOG.md must be excluded: the Release PR does not run
    // CI, so a changelog Prettier objects to merges clean and then fails the
    // next unrelated pull request, in a file that PR never touched.
    const entries = readFileSync('.prettierignore', 'utf8')
      .split('\n')
      .map(line => line.trim());
    expect(entries).toContain('CHANGELOG.md');
  });
});

describe('write access is confined to the release workflow', () => {
  const workflows = readdirSync(WORKFLOW_DIR).filter(name => /\.ya?ml$/.test(name));

  it('found workflows to check', () => {
    expect(workflows).toContain('release.yml');
    expect(workflows).toContain('ci.yml');
  });

  it.each(workflows.filter(name => name !== 'release.yml'))(
    '%s does not request contents: write',
    name => {
      // specs/010 § What a release contains. A substring check, not a YAML
      // parse: it catches the grant written plainly, which is how it would be
      // written, and misses one spelled through an expression or an anchor.
      const body = readFileSync(join(WORKFLOW_DIR, name), 'utf8');
      expect(body).not.toMatch(/contents:\s*write/);
    },
  );

  it('ci.yml still declares contents: read', () => {
    expect(readFileSync(join(WORKFLOW_DIR, 'ci.yml'), 'utf8')).toMatch(/contents:\s*read/);
  });

  it('release.yml is the one that holds it', () => {
    const body = readFileSync(join(WORKFLOW_DIR, 'release.yml'), 'utf8');
    expect(body).toMatch(/contents:\s*write/);
    expect(body).toMatch(/pull-requests:\s*write/);
  });
});
