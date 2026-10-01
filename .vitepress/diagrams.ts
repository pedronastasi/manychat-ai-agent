/**
 * Mermaid fences render as diagrams on the site, as they already do on GitHub.
 * The file is unchanged: a ```mermaid block becomes a <Mermaid> component
 * (theme/Mermaid.vue), which draws it in the browser.
 */
import type { MarkdownOptions } from 'vitepress';

type MarkdownIt = Parameters<NonNullable<MarkdownOptions['config']>>[0];

/**
 * The source travels URI-encoded, so nothing in a diagram — quotes, braces,
 * angle brackets — reaches the Vue template compiler as markup.
 */
export function mermaidTag(source: string): string {
  return `<Mermaid source="${encodeURIComponent(source)}" />\n`;
}

export function mermaidDiagrams(md: MarkdownIt): void {
  const fence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    if (token?.info.trim() === 'mermaid') return mermaidTag(token.content);
    return fence ? fence(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
  };
}
