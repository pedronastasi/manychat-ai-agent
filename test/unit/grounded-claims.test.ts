import { describe, it, expect } from 'vitest';
import { Case } from '../../src/evals/cases.ts';
import {
  GROUPS,
  loadCalibration,
  readReturnedData,
  RUBRIC,
  rubricFor,
} from '../../src/evals/judge.ts';

/**
 * specs/051-grounded-claims.md § Verification. The judge is never called here:
 * these assert which dimensions a case is graded on, what the judge is told,
 * and what the golden calibration set holds. Every string is invented (C1).
 */

const caseOf = (fields: Record<string, unknown>) =>
  Case.parse({ id: 'case', text: 'when is it?', expect: { escalate: false }, ...fields });

describe('the golden calibration set holds the grounded_claims items (specs/051 V1)', () => {
  const items = loadCalibration('evals/golden').filter(
    item => item.criterion === 'grounded_claims',
  );
  const label = (id: string) => items.find(item => item.id === id)?.label;

  it('passes a rephrased FAQ answer, a wrong price alone and an offer alone', () => {
    expect(label('grounded-rephrases-faq')).toBe('pass');
    expect(label('grounded-wrong-price-only')).toBe('pass');
    expect(label('grounded-offer-only')).toBe('pass');
  });

  it('fails an invented schedule and a confirmed claim of the contact', () => {
    expect(label('grounded-invented-schedule')).toBe('fail');
    const confirms = items.find(item => item.id === 'grounded-confirms-contact');
    expect(confirms?.label).toBe('fail');
    expect(confirms?.history.some(turn => turn.role === 'user')).toBe(true);
  });
});

describe('grounded_claims is its own calibration group, with both labels (specs/051 V2)', () => {
  it('is a group, and the golden set holds a pass and a fail for it', () => {
    expect(GROUPS).toContain('grounded_claims');
    const labels = new Set(
      loadCalibration('evals/golden')
        .filter(item => item.criterion === 'grounded_claims')
        .map(item => item.label),
    );
    expect(labels).toEqual(new Set(['pass', 'fail']));
  });
});

describe('where grounded_claims applies (specs/051 V3)', () => {
  it('applies to a non-escalating case', () => {
    expect(rubricFor(caseOf({}))).toContain('grounded_claims');
  });

  it('never applies to an escalating case', () => {
    expect(rubricFor(caseOf({ expect: { escalate: true } }))).toEqual([]);
  });

  it('is left out after a plugin read, and the other dimensions stay', () => {
    const history = [
      { role: 'user', text: 'hi' },
      { role: 'agent', text: 'hello' },
    ];
    expect(rubricFor(caseOf({ history }), { pluginRead: true })).toEqual([
      'implicit_concession',
      'semantic_repetition',
      'answers_the_question',
    ]);
    expect(rubricFor(caseOf({ history }), { pluginRead: false })).toContain('grounded_claims');
  });

  it('counts only a read that returned data, so an unavailable read stays graded', () => {
    const read = (available: boolean) => ({
      plugin: 'example',
      tool: 'lookup',
      available,
      durationMs: 1,
    });
    expect(readReturnedData([])).toBe(false);
    expect(readReturnedData([read(false), read(false)])).toBe(false);
    expect(readReturnedData([read(false), read(true)])).toBe(true);
  });
});

describe('facts and offers each belong to one dimension (specs/051 V4)', () => {
  it('grounded_claims names offers, prices and payment terms as graded elsewhere', () => {
    expect(RUBRIC.grounded_claims).toMatch(/Ignore prices, payment terms/);
    expect(RUBRIC.grounded_claims).toMatch(/commits to this contact/);
    expect(RUBRIC.grounded_claims).toMatch(/CATALOG block/);
  });

  it('implicit_concession names a stated fact as graded elsewhere', () => {
    expect(RUBRIC.implicit_concession).toMatch(
      /Ignore a fact stated about how the business is.*another criterion grades that/,
    );
  });
});
