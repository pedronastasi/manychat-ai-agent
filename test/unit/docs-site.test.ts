import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createMarkdownRenderer } from 'vitepress';

import { mermaidDiagrams, mermaidTag } from '../../.vitepress/diagrams.ts';

import {
  API_PAGE,
  REPOSITORY,
  isPublished,
  markdownFiles,
  publishedPages,
  resolveLink,
  unpublishedPatterns,
} from '../../.vitepress/site.ts';

/**
 * specs/014-docs-site.md § Verification. The allowlist decides what the
 * documentation site publishes, and a mistake in it publishes before anyone
 * has looked (C1), so it is asserted path by path rather than trusted.
 */

const root = process.cwd();
const pages = new Set(publishedPages(root));
const github = (view: 'blob' | 'tree', path: string) => `${REPOSITORY}/${view}/main/${path}`;

describe('publication is an allowlist (specs/014 § Publication is an allowlist)', () => {
  it.each([
    'README.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'CHANGELOG.md',
    'specs/README.md',
    'specs/014-docs-site.md',
    'docs/adr/0003-contract-first-with-zod.md',
    API_PAGE,
  ])('publishes %s', path => {
    expect(isPublished(path)).toBe(true);
  });

  it.each([
    'config/README.md',
    'test/fixtures/config/prompt.md',
    'CLAUDE.md',
    '.claude/skills/spec/SKILL.md',
    '.github/pull_request_template.md',
    // Absent from the spec's list, so absent from the site, however harmless.
    'CODE_OF_CONDUCT.md',
    // A directory publishes the files directly in it, not below it.
    'specs/drafts/next.md',
    'docs/adr/archive/0000-old.md',
    // Not Markdown, even in a published directory.
    'specs/notes.txt',
  ])('does not publish %s', path => {
    expect(isPublished(path)).toBe(false);
  });

  it('hands VitePress every other Markdown file in the tree as excluded', () => {
    const excluded = unpublishedPatterns(root);
    // Guards the loop below against an empty walk, which would pass anything.
    expect(excluded).toContain('config/README.md');
    expect(excluded).toContain('CLAUDE.md');
    for (const path of markdownFiles(root)) {
      expect(excluded.includes(path)).toBe(!isPublished(path));
    }
  });
});

describe('links outside the site point at GitHub (specs/014 § Links outside the site)', () => {
  const from = 'specs/014-docs-site.md';

  it('sends a link to code to the same path on main, keeping the anchor', () => {
    expect(resolveLink(root, pages, from, '../src/server.ts#L59')).toEqual({
      kind: 'rewritten',
      href: `${github('blob', 'src/server.ts')}#L59`,
    });
  });

  it('sends a link to an unpublished Markdown file to GitHub rather than serving it', () => {
    expect(resolveLink(root, pages, 'README.md', 'config/README.md')).toEqual({
      kind: 'rewritten',
      href: github('blob', 'config/README.md'),
    });
  });

  it('sends a link to a directory to its tree view', () => {
    expect(resolveLink(root, pages, 'CONTRIBUTING.md', '.claude/skills/')).toEqual({
      kind: 'rewritten',
      href: github('tree', '.claude/skills'),
    });
    expect(resolveLink(root, pages, 'README.md', 'docs/adr/')).toEqual({
      kind: 'rewritten',
      href: github('tree', 'docs/adr'),
    });
  });

  it('leaves a link to a published page alone', () => {
    expect(resolveLink(root, pages, from, '008-spec-metadata.md#four-statuses')).toEqual({
      kind: 'unchanged',
    });
    expect(resolveLink(root, pages, from, '../docs/adr/0003-contract-first-with-zod.md')).toEqual({
      kind: 'unchanged',
    });
  });

  it('points a link to a rewritten README at the page that serves it', () => {
    expect(resolveLink(root, pages, from, 'README.md')).toEqual({
      kind: 'rewritten',
      href: 'index.md',
    });
    expect(resolveLink(root, pages, from, '../README.md#status')).toEqual({
      kind: 'rewritten',
      href: '../index.md#status',
    });
    expect(resolveLink(root, pages, 'README.md', 'specs/README.md')).toEqual({
      kind: 'rewritten',
      href: 'specs/index.md',
    });
    expect(resolveLink(root, pages, 'README.md', 'specs/')).toEqual({
      kind: 'rewritten',
      href: 'specs/index.md',
    });
  });

  it.each(['renamed-spec.md', '../src/does-not-exist.ts#L3', '../../outside-the-repository.md'])(
    'reports %s as missing rather than rewriting it, so the build fails',
    href => {
      expect(resolveLink(root, pages, from, href).kind).toBe('missing');
    },
  );

  it.each(['#verification', 'https://example.com/page.md', '/specs/', ''])(
    'leaves %j alone: it is not a relative link to a file',
    href => {
      expect(resolveLink(root, pages, from, href)).toEqual({ kind: 'unchanged' });
    },
  );
});

describe('the sidebar is derived (specs/014 § The sidebar is derived, never hand-listed)', () => {
  const siteFiles = readdirSync('.vitepress', { recursive: true, encoding: 'utf8' })
    .filter(name => !/^(cache|dist)\b/.test(name))
    .filter(name => /\.([cm]?[jt]s|vue)$/.test(name))
    .map(name => join('.vitepress', name));

  it('found the site configuration to check', () => {
    expect(siteFiles).toContain(join('.vitepress', 'config.ts'));
  });

  it.each(siteFiles)('%s writes no sidebar entry as a literal', file => {
    // An entry is a `link` with a fixed target. Anything VitePress navigates
    // to must come from the derivation, so no file under .vitepress/ names one.
    expect(readFileSync(file, 'utf8')).not.toMatch(/\blink\s*:\s*['"`]/);
  });

  it('takes the sidebar from the derivation', () => {
    expect(readFileSync(join('.vitepress', 'config.ts'), 'utf8')).toMatch(
      /sidebar:\s*deriveSidebar\(root\)/,
    );
  });
});

describe('the OpenAPI document is generated, never committed (specs/014 § The API reference)', () => {
  const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n');

  it('is not tracked in any form', () => {
    const documents = tracked
      .filter(path => /\.(json|ya?ml)$/.test(path))
      .filter(path => /^\s*["']?(openapi|swagger)["']?\s*:/m.test(readFileSync(path, 'utf8')));
    expect(documents).toEqual([]);
    expect(tracked).not.toContain(API_PAGE);
  });

  it('is written where git ignores it', () => {
    // check-ignore exits non-zero, and throws here, for a path git would track.
    expect(() => execFileSync('git', ['check-ignore', '--quiet', API_PAGE])).not.toThrow();
  });
});

describe('mermaid fences render as diagrams (specs/014 § The site renders files where they already live)', () => {
  // GitHub draws these; served as code, the site would read worse than the
  // repository it publishes.
  it('hands a mermaid fence to the diagram component, and leaves other fences as code', async () => {
    const md = await createMarkdownRenderer(root, { config: mermaidDiagrams });
    // Quotes, braces and brackets that would otherwise be read as markup.
    const diagram = 'sequenceDiagram\n  A->>B: "{{ greeting }}" <b>now</b>\n';
    const html = md.render(
      ['```mermaid', diagram + '```', '', '```json', '{ "a": 1 }', '```'].join('\n'),
    );

    expect(html).toContain(mermaidTag(diagram));
    expect(html).not.toContain('{{ greeting }}');
    expect(html).toContain('language-json');
  });

  it('carries the diagram source through unchanged', () => {
    const diagram = 'graph TD\n  A["x & y"] --> B{{"z"}}\n';
    const encoded = mermaidTag(diagram).match(/source="([^"]*)"/)?.[1] ?? '';
    expect(decodeURIComponent(encoded)).toBe(diagram);
  });
});
