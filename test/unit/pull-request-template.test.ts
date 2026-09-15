import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * specs/006-pull-requests.md § Verification.
 *
 * The template is the only place the repository states why a change was made,
 * and the only moment an author is asked whether they are about to paste tenant
 * data into a public page. Both properties are invisible to every other test:
 * nothing breaks when the template quietly becomes a summary form again.
 */

const TEMPLATE_PATH = '.github/pull_request_template.md';
const template = readFileSync(TEMPLATE_PATH, 'utf8');

const headings = [...template.matchAll(/^## (.+)$/gm)].map(m => m[1]!.trim());

/** Lines a reader sees, once the author-facing prompts are stripped. */
const rendered = template
  .replace(/<!--[\s\S]*?-->/g, '')
  .split('\n')
  .map(l => l.trimEnd())
  .filter(l => l.length > 0);

const checkboxes = template.match(/^- \[ \] .*/gm) ?? [];

describe('the pull request template', () => {
  it('opens with Why', () => {
    // The whole point of the spec. A template that opens with "Summary" or
    // "Changes" is a worse-formatted version of the diff.
    expect(headings[0]).toBe('Why');
  });

  it('asks for what changed and for verification', () => {
    expect(headings).toContain('What changed');
    expect(headings).toContain('Verification');
  });

  it('carries no prose outside HTML comments', () => {
    // An author who fills in the sections and deletes nothing must still
    // produce a body with no instructions rendered in it. So every visible
    // line is a heading, a table row, a rule, or a checkbox (with its
    // indented continuation lines).
    const structural = /^(## |\||---$|- \[ \] |\s+\S)/;
    const prose = rendered.filter(l => !structural.test(l));
    expect(prose).toEqual([]);
  });

  it('has exactly the two checks a job cannot do', () => {
    // specs/006 § What the template deliberately does not contain: a checkbox
    // for work CI already verifies teaches authors to tick without reading.
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes.join(' ')).toMatch(/tenant data/i);
    expect(checkboxes.join(' ')).toMatch(/specs updated/i);
  });

  it.each(['test', 'lint', 'format', 'typecheck', 'coverage', 'eval', 'build'])(
    'does not ask the author to confirm %s, which CI enforces',
    word => {
      for (const box of checkboxes) {
        expect(box.toLowerCase()).not.toContain(word);
      }
    },
  );

  it('is written in English (C9)', () => {
    // Same cheap guard as specs/005: accented characters are the signal that
    // prose in another language has been pasted in.
    expect(template).not.toMatch(/[À-ɏ]/);
  });
});
