import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * specs/040-readme-is-a-landing-page.md § Verification.
 *
 * The cap measures length, not purpose: a walkthrough appended to the README
 * fails here, and a short one that slips under the cap is review's to catch.
 */

const MAX_LINES = 200;

describe('the README (specs/040 § The README holds the problem, one line per capability, and a map)', () => {
  const lines = readFileSync('README.md', 'utf8').trimEnd().split('\n');

  it(`is at most ${MAX_LINES} lines, so steps and reference live in a guide`, () => {
    expect(lines.length).toBeLessThanOrEqual(MAX_LINES);
  });
});
