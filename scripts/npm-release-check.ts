/**
 * Decides whether release.yml publishes a package (specs/010 § npm publish).
 * Run as `node scripts/npm-release-check.ts <package dir>` from a publish step;
 * it writes `publish=true|false` to `$GITHUB_OUTPUT`.
 *
 * A version already on the registry is skipped, so a release whose job failed
 * half-way can be re-run: npm refuses to publish over a version, and without
 * this the package that did go out fails the re-run. A package that does not
 * exist at all fails with the one-time steps, because trusted publishing
 * cannot create a package and the bare E404 npm returns names neither cause.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const REGISTRY = 'https://registry.npmjs.org';

export interface Manifest {
  name: string;
  version: string;
}

export interface Lookup {
  status: number;
  versions: string[];
}

export function bootstrapSteps(pkg: Manifest, repository: string, dir: string): string {
  return [
    `${pkg.name} does not exist on npm, and trusted publishing cannot create a package.`,
    `Once, by hand: check out v${pkg.version}, run \`npm publish --access public\` in ${dir}`,
    `while logged in to npm, then on npmjs.com attach the trusted publisher (${repository},`,
    'workflow release.yml, no environment) and allow `npm publish`. Then re-run this job:',
    'the hand-published version is skipped and any package after it is published.',
  ].join(' ');
}

export function shouldPublish(pkg: Manifest, lookup: Lookup, repository: string, dir: string) {
  if (lookup.status === 404) throw new Error(bootstrapSteps(pkg, repository, dir));
  if (lookup.status !== 200) {
    throw new Error(`${REGISTRY} answered ${lookup.status} for ${pkg.name}`);
  }
  return !lookup.versions.includes(pkg.version);
}

async function lookup(name: string): Promise<Lookup> {
  const response = await fetch(`${REGISTRY}/${name.replaceAll('/', '%2F')}`);
  if (response.status !== 200) return { status: response.status, versions: [] };
  const body = (await response.json()) as { versions?: Record<string, unknown> };
  return { status: 200, versions: Object.keys(body.versions ?? {}) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] ?? '.';
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest;
  const repository = process.env.GITHUB_REPOSITORY ?? 'this repository';
  try {
    const publish = shouldPublish(pkg, await lookup(pkg.name), repository, dir);
    console.log(
      publish
        ? `${pkg.name}@${pkg.version} is not on npm yet: publishing`
        : `${pkg.name}@${pkg.version} is already on npm: skipping`,
    );
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `publish=${publish}\n`);
  } catch (error) {
    console.error(`::error::${(error as Error).message}`);
    process.exit(1);
  }
}
