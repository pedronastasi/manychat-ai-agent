import { describe, it, expect, afterEach } from 'vitest';
import { cpSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LangGraphRunner } from '../../src/agent/langgraph-runner.ts';
import { fixtureEval } from '../../src/observability/tracing.ts';
import { fixtureTenant, scriptedTurns } from '../helpers/conversations.ts';
import { fakeLangSmith } from '../helpers/langsmith.ts';

/**
 * specs/052-traces-carry-shape-not-text.md § Verification, Eval scope: only
 * the fixture tenant on the golden set traces with text, decided by resolved
 * path, so a copy of the fixture tenant elsewhere is traced like a live turn.
 */

const FIXTURE = 'test/fixtures/config';
const GOLDEN = 'evals/golden';
const INBOUND = 'What time does the evening group start?';

let scratch: string | undefined;
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

/** A copy of the fixture tenant in a directory of its own. */
function copiedFixture(): string {
  scratch = mkdtempSync(join(tmpdir(), 'trace-scope-'));
  const copy = join(scratch, 'config');
  cpSync(FIXTURE, copy, { recursive: true });
  return copy;
}

async function uploadedInputs(fullText: boolean) {
  const langsmith = fakeLangSmith();
  const runner = new LangGraphRunner({
    model: scriptedTurns([{}]).model,
    modelSpec: 'mock:demo',
    config: () => fixtureTenant,
    maxOutputTokens: 400,
    temperature: 0.3,
  });
  const trace = langsmith.tracing(fullText).turn({ conversation: 'eval-case', kind: 'inbound' });
  await runner.run({ text: INBOUND, history: [], trace });
  await langsmith.settle();
  return langsmith;
}

describe('eval runs on the fixture tenant are the only traces with text (specs/052 V10)', () => {
  it('allows text for the fixture tenant on the golden set', () => {
    expect(fixtureEval(FIXTURE, GOLDEN)).toBe(true);
    expect(fixtureEval(`./${FIXTURE}/`, `${GOLDEN}/../golden`)).toBe(true);
  });

  it('refuses a copy of the fixture tenant in another directory', () => {
    expect(fixtureEval(copiedFixture(), GOLDEN)).toBe(false);
  });

  it('reads a link to the fixture tenant by what it resolves to', () => {
    scratch = mkdtempSync(join(tmpdir(), 'trace-scope-'));
    const link = join(scratch, 'config');
    symlinkSync(join(process.cwd(), FIXTURE), link);
    // A link resolves to the fixture itself, so it is the fixture's text.
    expect(fixtureEval(link, GOLDEN)).toBe(true);
  });

  it("refuses a tenant's own config and suite", () => {
    expect(fixtureEval('config', GOLDEN)).toBe(false);
    expect(fixtureEval(FIXTURE, 'test/fixtures')).toBe(false);
    expect(fixtureEval(FIXTURE, 'no/such/suite')).toBe(false);
  });

  it('uploads full inputs for the fixture tenant on the golden set', async () => {
    const { bytes } = await uploadedInputs(fixtureEval(FIXTURE, GOLDEN));
    expect(bytes()).toContain(INBOUND);
  });

  it('uploads the live projection for a copy of the fixture tenant', async () => {
    const { bytes, runs } = await uploadedInputs(fixtureEval(copiedFixture(), GOLDEN));
    expect(bytes()).not.toContain(INBOUND);
    expect(runs().every(run => Object.keys(run.inputs).length === 0)).toBe(true);
  });
});
