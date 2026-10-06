import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

/**
 * specs/010-release-workflow.md § The Release PR does not run CI, and that is
 * accepted; specs/011-dependency-updates.md § Auto-merge is a claim about CI.
 *
 * The Claude reviewer skips the Release PR and Renovate's pull requests by
 * their author. Matched on the actor instead, a person re-running a check or
 * merging main into one of their branches would start a review of it.
 */

const workflow = parse(readFileSync('.github/workflows/claude-code-review.yml', 'utf8')) as {
  jobs: Record<string, { if: string; steps: { with?: Record<string, string> }[] }>;
};
const job = workflow.jobs['claude-review']!;
const clauses = job.if.split('&&').map(clause => clause.trim());

describe('the Claude reviewer skips bot pull requests (specs/010, specs/011)', () => {
  it.each(['renovate[bot]', 'github-actions[bot]'])('skips pull requests authored by %s', bot => {
    expect(clauses).toContain(`github.event.pull_request.user.login != '${bot}'`);
  });

  it('decides by the author, never by who started the run', () => {
    expect(job.if).not.toMatch(/github\.(triggering_)?actor/);
  });

  it('lets no bot run the action, now that none can reach it', () => {
    for (const step of job.steps) expect(step.with ?? {}).not.toHaveProperty('allowed_bots');
  });
});
