/**
 * The documentation site (specs/014-docs-site.md). It renders the repository's
 * Markdown where it already lives and adds only navigation: nothing here names
 * a page, so a spec or ADR merged without touching this file is still on the
 * site.
 */
import { readFileSync } from 'node:fs';
import { posix, relative, resolve } from 'node:path';
import { defineConfig, type MarkdownOptions } from 'vitepress';

import {
  BRANCH,
  REPOSITORY,
  REWRITES,
  deriveSidebar,
  publishedPages,
  resolveLink,
  unpublishedPatterns,
} from './site.ts';

type MarkdownIt = Parameters<NonNullable<MarkdownOptions['config']>>[0];

const root = resolve(import.meta.dirname, '..');
const pages = new Set(publishedPages(root));
const { description } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  description: string;
};

/**
 * Relative links whose target is not in the tree. VitePress's own dead-link
 * check only follows links to pages, so a link to a deleted `src/` file would
 * otherwise reach the site as a 404 (specs/014 § A broken link fails).
 */
const missing = new Set<string>();

/**
 * Applies resolveLink to every link in a published file as it is parsed. The
 * source file is not edited: its links keep working on GitHub, and on the site
 * they open what they name.
 */
function publishedLinks(md: MarkdownIt): void {
  md.core.ruler.push('published_links', state => {
    const env = state.env as { realPath?: string; path?: string };
    const source = env.realPath ?? env.path;
    if (source === undefined) return;
    const from = relative(root, source).split('\\').join(posix.sep);

    for (const block of state.tokens) {
      for (const token of block.children ?? []) {
        if (token.type !== 'link_open') continue;
        const href = token.attrGet('href');
        if (href === null) continue;
        const resolution = resolveLink(root, pages, from, href);
        if (resolution.kind === 'rewritten') token.attrSet('href', resolution.href);
        if (resolution.kind === 'missing') missing.add(`${from}: ${href}`);
      }
    }
  });
}

export default defineConfig({
  title: 'ManyChat AI Agent',
  description,
  // GitHub Pages serves a project site under the repository's name.
  base: `/${posix.basename(REPOSITORY)}/`,
  srcDir: '.',
  srcExclude: unpublishedPatterns(root),
  rewrites: { ...REWRITES },
  cleanUrls: true,
  // `ignoreDeadLinks` is deliberately never set (specs/014).

  markdown: { config: publishedLinks },

  themeConfig: {
    sidebar: deriveSidebar(root),
    // Local search: the index ships with the site, and no search service sees
    // the content or anyone's queries.
    search: { provider: 'local' },
    editLink: {
      pattern: `${REPOSITORY}/edit/${BRANCH}/:path`,
      text: 'Edit this file on GitHub',
    },
    socialLinks: [{ icon: 'github', link: REPOSITORY }],
  },

  buildEnd() {
    if (missing.size === 0) return;
    throw new Error(
      `Relative links to files that do not exist:\n${[...missing].map(link => `  ${link}`).join('\n')}`,
    );
  },
});
