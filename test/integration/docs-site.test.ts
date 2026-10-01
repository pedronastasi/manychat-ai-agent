import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolveConfig, type SiteConfig } from 'vitepress';

import { API_PAGE, routeOf, type SidebarItem } from '../../.vitepress/site.ts';
import { writeApiPage } from '../../scripts/export-openapi.ts';

/**
 * specs/014-docs-site.md § Verification. The page list here is the one
 * VitePress itself resolves from .vitepress/config.ts, not a re-derivation of
 * it, so a config that disagrees with the allowlist fails.
 */

const markdownIn = (dir: string) =>
  readdirSync(dir)
    .filter(name => name.endsWith('.md'))
    .map(name => `${dir}/${name}`);

/** The table in specs/014 § Publication is an allowlist, written out independently. */
const ALLOWLIST = [
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CHANGELOG.md',
  ...markdownIn('specs'),
  ...markdownIn('docs/adr'),
  API_PAGE,
].sort();

let site: SiteConfig;

beforeAll(async () => {
  // The API page is generated, never committed, so it exists only once
  // exported: with placeholder settings, the mock model and an embedded
  // database, as the build does it.
  await writeApiPage();
  site = await resolveConfig(process.cwd(), 'build', 'production');
});

describe('the site publishes exactly the allowlist', () => {
  it('found the specs and decisions to publish', () => {
    expect(ALLOWLIST).toContain('specs/README.md');
    expect(ALLOWLIST).toContain('docs/adr/0001-hybrid-race-reply-path.md');
  });

  it('serves the allowlist, and nothing else', () => {
    expect([...site.pages].sort()).toEqual(ALLOWLIST);
  });

  it.each(['config/', 'test/', '.claude/', '.github/'])('serves nothing under %s', prefix => {
    expect(site.pages.filter(page => page.startsWith(prefix))).toEqual([]);
  });

  it('does not serve the agent instructions', () => {
    expect(site.pages).not.toContain('CLAUDE.md');
  });

  it('serves the README as the home page and the specs index as the specs page', () => {
    expect(site.rewrites.map['README.md']).toBe('index.md');
    expect(site.rewrites.map['specs/README.md']).toBe('specs/index.md');
  });

  it('never ignores dead links', () => {
    expect(site.ignoreDeadLinks).toBeUndefined();
  });
});

describe('the sidebar is the derivation', () => {
  const links = (items: SidebarItem[]): string[] =>
    items.flatMap(item => [...(item.link ? [item.link] : []), ...links(item.items ?? [])]);

  it('reaches every published page exactly once', () => {
    const sidebar = site.site.themeConfig.sidebar as SidebarItem[];
    expect(links(sidebar).sort()).toEqual(ALLOWLIST.map(routeOf).sort());
  });
});

describe('the API reference', () => {
  it('is generated from the Zod contracts without a model key or network', () => {
    const page = readFileSync(API_PAGE, 'utf8');
    expect(page).toContain('## `POST /v1/channels/manychat/message`');
    // The request schema comes from ManyChatInbound (src/contracts/manychat.ts).
    expect(page).toContain('"subscriber_id"');
  });
});
