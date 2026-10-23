import { z } from 'zod';

/**
 * What the eval judge returns for one criterion (specs/016 § A verdict is
 * binary, and a failure quotes the reply). Model output is untrusted input on
 * this path exactly as on the request path (C3): output that does not parse is
 * an invalid sample, never a pass.
 */
export const Verdict = z.object({
  verdict: z.enum(['pass', 'fail']),
  /** A verbatim span of the reply. Non-empty on `fail`, checked as a substring. */
  evidence: z.string(),
  reason: z.string(),
});
export type Verdict = z.infer<typeof Verdict>;

/** A turn of a calibration item's history, as a case's (specs/009). */
const CalibrationTurn = z.object({
  role: z.enum(['user', 'agent']),
  text: z.string(),
});

/**
 * A hand-labelled reply the judge must agree with before its verdicts count
 * (specs/016 § A judge that has not passed calibration grades nothing). The
 * reply is written by hand, never generated, so the thing measured against
 * does not move between runs.
 */
export const CalibrationItem = z.object({
  id: z.string(),
  history: z.array(CalibrationTurn).default([]),
  text: z.string(),
  reply: z.array(z.string()).min(1),
  /** A fixed rubric dimension's name, or a free-text criterion. */
  criterion: z.string(),
  label: z.enum(['pass', 'fail']),
});
export type CalibrationItem = z.infer<typeof CalibrationItem>;
