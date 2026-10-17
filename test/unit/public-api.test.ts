import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { publicApi } from '../helpers/public-api.ts';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  name: string;
  exports: Record<string, { default: string }>;
};

/** Each entry point the `exports` map names, and the source its build comes from. */
const entries = Object.fromEntries(
  Object.entries(pkg.exports).map(([key, target]) => [
    `${pkg.name}${key.slice(1)}`,
    target.default.replace(/^\.\/dist\//, 'src/').replace(/\.js$/, '.ts'),
  ]),
);

/**
 * specs/033-tenant-projects-not-forks.md § Entry points, through an exports
 * map, and § A release is a version bump: what a tenant can import is the
 * contract, and a change to it is a decision, not a side effect.
 *
 * The snapshot holds every export of the three entry points down to its
 * members. A refactor that leaves them alone leaves it alone; one that changes
 * them fails here until the snapshot is regenerated with
 * `pnpm vitest run test/unit/public-api.test.ts -u`, so the change is in the
 * diff a reviewer reads. Whether it is breaking, and the commit marked `!`,
 * stays the reviewer's call (specs/033 § What this does not catch).
 */
describe("the package's public API (specs/033)", () => {
  it('is what the snapshot records', async () => {
    const surface = publicApi(entries);
    await expect(surface).toMatchFileSnapshot('__snapshots__/public-api.txt');
  });
});
