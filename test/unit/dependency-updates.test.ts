import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * specs/011-dependency-updates.md § Verification.
 *
 * Every property here can be relaxed by a one-line diff that reads as a tweak.
 * Widening `matchUpdateTypes` on the auto-merge rule, or moving it below the
 * exclusions, hands unattended merges to updates the spec argued must be read —
 * and nothing else in the repository would object.
 */

const SPEC_PATH = 'specs/011-dependency-updates.md';

type PackageRule = {
  matchUpdateTypes?: string[];
  matchManagers?: string[];
  matchDepTypes?: string[];
  groupName?: string;
  automerge?: boolean;
  dependencyDashboardApproval?: boolean;
};

const config = JSON.parse(readFileSync('renovate.json', 'utf8')) as {
  extends?: string[];
  minimumReleaseAge?: string;
  schedule?: string[];
  packageRules?: PackageRule[];
};

const rules = config.packageRules ?? [];
const automerging = rules.filter(rule => rule.automerge === true);

/** The stream table in specs/011 § Three streams is the source of truth (C8). */
const specStreams = [
  ...readFileSync(SPEC_PATH, 'utf8').matchAll(
    /^\|\s*`(patch|minor|major)`\s*\|\s*([^|]+?)\s*\|\s*(Yes|No)\s*\|/gm,
  ),
].map(row => ({ stream: row[1]!, batching: row[2]!, automerge: row[3] === 'Yes' }));

const ruleFor = (updateType: string): PackageRule | undefined =>
  rules.find(
    rule => rule.matchUpdateTypes?.length === 1 && rule.matchUpdateTypes[0] === updateType,
  );

describe('the three streams match the spec table', () => {
  it('found the table in the spec', () => {
    expect(specStreams).toHaveLength(3);
  });

  it.each(specStreams)('$stream auto-merges: $automerge', ({ stream, automerge }) => {
    expect(ruleFor(stream)?.automerge ?? false).toBe(automerge);
  });

  it('groups patch and minor, and leaves major ungrouped', () => {
    // specs/011: a combined major PR that fails CI leaves no way to tell which
    // upgrade broke it.
    expect(ruleFor('patch')?.groupName).toBeDefined();
    expect(ruleFor('minor')?.groupName).toBeDefined();
    expect(ruleFor('major')?.groupName).toBeUndefined();
  });

  it('opens major PRs without dashboard approval', () => {
    expect(ruleFor('major')?.dependencyDashboardApproval).toBeUndefined();
  });
});

describe('auto-merge reaches patches and nothing else', () => {
  it('is granted by exactly one rule', () => {
    expect(automerging).toHaveLength(1);
  });

  it('is granted only to patch updates', () => {
    // The assertion the spec exists for. `matchUpdateTypes: ["patch", "minor"]`
    // would be a one-word diff.
    expect(automerging[0]?.matchUpdateTypes).toEqual(['patch']);
  });

  it('is never granted to GitHub Actions or the toolchain', () => {
    // specs/011 § Deliberately not automated: an action version is a reference
    // to code that runs with this repository's credentials, including a
    // workflow holding contents: write (specs/010).
    for (const rule of automerging) {
      expect(rule.matchManagers).toBeUndefined();
      expect(rule.matchDepTypes).toBeUndefined();
    }
  });
});

describe('the exclusions override the patch rule rather than being overridden', () => {
  // Renovate merges packageRules in order: for a dependency matched by several,
  // the later rule wins. An exclusion placed above the auto-merge rule is
  // silently void, and the config still validates.
  const indexOfAutomerge = rules.findIndex(rule => rule.automerge === true);

  const exclusions = [
    { label: 'github-actions', at: rules.findIndex(rule => rule.matchManagers?.length) },
    { label: 'toolchain', at: rules.findIndex(rule => rule.matchDepTypes?.length) },
  ];

  it.each(exclusions)('the $label rule exists', ({ at }) => {
    expect(at).toBeGreaterThanOrEqual(0);
  });

  it.each(exclusions)('the $label rule sits after the auto-merge rule', ({ at }) => {
    expect(at).toBeGreaterThan(indexOfAutomerge);
  });

  it.each(exclusions)('the $label rule turns auto-merge off', ({ at }) => {
    expect(rules[at]?.automerge).toBe(false);
  });
});

describe('a compromised release gets a window to be caught in', () => {
  it('delays every update by at least three days', () => {
    // specs/011 § Auto-merge is a claim about CI: this is a delay, not a
    // detector. CI goes green on a malicious patch because the payload is not
    // what the tests are looking at.
    const age = config.minimumReleaseAge ?? '';
    const [amount, unit] = age.split(' ');
    expect(unit).toMatch(/^days?$/);
    expect(Number(amount)).toBeGreaterThanOrEqual(3);
  });

  it('batches on a weekly schedule rather than continuously', () => {
    expect(config.schedule?.length).toBeGreaterThan(0);
    expect(config.schedule?.join(' ')).toMatch(/monday/i);
  });

  it('titles pull requests with the conventional prefixes releases are cut from', () => {
    // specs/011 § Dependency PRs feed the release: without :semanticCommits the
    // titles stop parsing, and specs/010's version bump silently stops seeing
    // dependency updates.
    expect(config.extends).toContain(':semanticCommits');
  });
});
