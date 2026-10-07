/**
 * What the documentation site publishes, and the navigation it derives from
 * that (specs/014-docs-site.md). Everything here reads the working tree and
 * returns values, so the tests ask the same questions VitePress does and get
 * the same answers.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, relative, resolve, sep } from 'node:path';

export const REPOSITORY = 'https://github.com/pedronastasi/manychat-ai-agent';
export const BRANCH = 'main';

/** Written by `pnpm docs:api` from the Zod contracts, and never committed. */
export const API_PAGE = 'api/index.md';

/**
 * specs/014 § Publication is an allowlist. Exactly these are published, and a
 * Markdown file anywhere else is not, whatever it is called. Adding to this
 * list publishes content, so it is a C1 decision that changes the spec first.
 *
 * `files` are named one by one; `directory` publishes the `*.md` directly in
 * it, not below it. The order of sections is the order of the sidebar.
 */
export const ALLOWLIST: readonly Section[] = [
  { label: 'Project', files: ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md'] },
  { label: 'Guides', directory: 'docs/guides' },
  { label: 'Specs', directory: 'specs' },
  { label: 'Decisions', directory: 'docs/adr' },
  // By name: the rest of config/ is where a deployment's real files sit.
  { label: 'Configuration', files: ['config/README.md'] },
  { label: 'Reference', files: [API_PAGE] },
];

export type Section =
  { label: string; files: readonly string[] } | { label: string; directory: string };

/** Served in place of the file, so neither moves (specs/014 § A docs/ tree). */
export const REWRITES: Readonly<Record<string, string>> = {
  'README.md': 'index.md',
  'specs/README.md': 'specs/index.md',
};

/** Never walked: VitePress does not look inside them either, and they are large. */
const UNWALKED = new Set(['node_modules', '.git', 'dist', 'coverage']);

/** Paths are repository-relative and `/`-separated throughout. */
const toPosix = (path: string): string => path.split(sep).join(posix.sep);

export function isPublished(path: string): boolean {
  return ALLOWLIST.some(section =>
    'files' in section
      ? section.files.includes(path)
      : posix.dirname(path) === section.directory && path.endsWith('.md'),
  );
}

/** Every Markdown file in the tree, published or not. */
export function markdownFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!UNWALKED.has(entry.name)) walk(path);
      } else if (entry.name.endsWith('.md')) {
        found.push(path);
      }
    }
  };
  walk('');
  return found.sort();
}

/** The pages in one section, in filename order. */
export function sectionPages(root: string, section: Section): string[] {
  if ('files' in section) return section.files.filter(file => existsSync(join(root, file))).sort();
  return readdirSync(join(root, section.directory))
    .filter(name => name.endsWith('.md'))
    .map(name => `${section.directory}/${name}`)
    .sort();
}

export function publishedPages(root: string): string[] {
  return ALLOWLIST.flatMap(section => sectionPages(root, section)).sort();
}

/**
 * VitePress takes a denylist, so the allowlist is handed to it as its
 * complement: every Markdown file the allowlist does not name. A file added
 * anywhere else is in this list without anyone editing it, which is the
 * direction C1 needs a mistake to fail in.
 */
export function unpublishedPatterns(root: string): string[] {
  return markdownFiles(root)
    .filter(path => !isPublished(path))
    .map(path => path.replace(/[*?{}()[\]!+@]/g, '\\$&'));
}

const servedAs = (path: string): string => REWRITES[path] ?? path;

/** The URL VitePress serves a source file at, without the site's base. */
export function routeOf(path: string): string {
  return `/${servedAs(path)
    .replace(/\.md$/, '')
    .replace(/(^|\/)index$/, '$1')}`;
}

/** A file's `#` title, which is what the repository already calls it. */
export function titleOf(root: string, path: string): string {
  const title = readFileSync(join(root, path), 'utf8')
    .match(/^# (.+)$/m)?.[1]
    ?.trim();
  return title ?? posix.basename(path, '.md');
}

export interface SidebarItem {
  text: string;
  link?: string;
  items?: SidebarItem[];
  collapsed?: boolean;
}

export interface NavItem {
  text: string;
  link: string;
  activeMatch: string;
}

/**
 * A group longer than this starts collapsed, so the short sections stay in
 * view above the specs and decisions. VitePress opens a collapsed group when
 * it holds the page being read.
 */
export const COLLAPSE_AFTER = 8;

const isIndex = (page: string): boolean => posix.basename(servedAs(page)) === 'index.md';

/** A section's pages in sidebar order: its index first, then filename order. */
function orderedPages(root: string, section: Section): string[] {
  const pages = sectionPages(root, section);
  return [...pages.filter(isIndex), ...pages.filter(page => !isIndex(page))];
}

/**
 * specs/014 § The sidebar is derived, never hand-listed. One group per
 * allowlist section, each page an entry under its `#` title, in filename
 * order. A page served as its directory's index comes first, the way a README
 * heads a directory on GitHub. It is an entry like the rest: as the group's
 * own link it was reachable only by clicking a heading nobody reads as one.
 */
export function deriveSidebar(root: string): SidebarItem[] {
  return ALLOWLIST.flatMap(section => {
    const pages = orderedPages(root, section);
    if (pages.length === 0) return [];
    return [
      {
        text: section.label,
        items: pages.map(page => ({ text: titleOf(root, page), link: routeOf(page) })),
        ...(pages.length > COLLAPSE_AFTER ? { collapsed: true } : {}),
      },
    ];
  });
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * specs/014 § The sidebar is derived, never hand-listed, applied to the top
 * bar: one entry per allowlist section, linking to its first page and lit on
 * any page in it. The section holding the home page has none, because the
 * site title already links there.
 */
export function deriveNav(root: string): NavItem[] {
  return ALLOWLIST.flatMap(section => {
    const pages = orderedPages(root, section);
    const first = pages[0];
    if (first === undefined || routeOf(first) === '/') return [];
    const activeMatch =
      'directory' in section
        ? `^/${escapeRegExp(section.directory)}/`
        : `^(?:${pages.map(page => escapeRegExp(routeOf(page))).join('|')})$`;
    return [{ text: section.label, link: routeOf(first), activeMatch }];
  });
}

export type LinkResolution =
  { kind: 'unchanged' } | { kind: 'rewritten'; href: string } | { kind: 'missing'; target: string };

/**
 * specs/014 § Links outside the site point at GitHub, not at nothing. Decides
 * what a relative link in a published file becomes on the site, without the
 * file changing:
 *
 * - a published page stays a site link, pointed at where a rewrite serves it;
 * - anything else that exists opens on GitHub, at the same path on `main`;
 * - a target that does not exist is reported, and fails the build.
 *
 * `from` is the source file, repository-relative.
 */
export function resolveLink(
  root: string,
  pages: ReadonlySet<string>,
  from: string,
  href: string,
): LinkResolution {
  // Anchors, absolute URLs, other schemes and site-absolute paths are not
  // relative links to a file, so they are not this function's concern.
  if (href === '' || href.startsWith('#') || href.startsWith('/')) return { kind: 'unchanged' };
  if (/^[a-z][a-z\d+.-]*:/i.test(href)) return { kind: 'unchanged' };

  const cut = href.search(/[?#]/);
  const path = cut === -1 ? href : href.slice(0, cut);
  const suffix = cut === -1 ? '' : href.slice(cut);

  const absolute = resolve(root, posix.dirname(from), decodeURI(path));
  const target = toPosix(relative(root, absolute));
  // A link that leaves the repository has no address on GitHub either.
  if (target.startsWith('..') || !existsSync(absolute)) return { kind: 'missing', target };

  const isDirectory = statSync(absolute).isDirectory();
  const page = isDirectory ? posix.join(target, 'README.md') : target;
  if (pages.has(page) && (!isDirectory || REWRITES[page] !== undefined)) {
    if (servedAs(page) === page) return { kind: 'unchanged' };
    // Rewrites rename within a directory, so the link is relative to where
    // the linking page is served from, not where its source sits.
    const fromServed = posix.dirname(servedAs(from));
    return { kind: 'rewritten', href: posix.relative(fromServed, servedAs(page)) + suffix };
  }

  const view = isDirectory ? 'tree' : 'blob';
  return {
    kind: 'rewritten',
    href: `${REPOSITORY}/${view}/${BRANCH}/${encodeURI(target)}${suffix}`,
  };
}
