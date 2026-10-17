import type { AgentResult } from '../agent/runner.ts';
import type { AgentReply, TurnOutcome } from '../contracts/agent.ts';

/**
 * What the part of a turn run against the deadline produced: the model's
 * answer, or a reply decided without it — a media fallback, a keyword found in
 * a transcript, or media we failed to read.
 */
export type Completion =
  | { kind: 'model'; result: AgentResult }
  | { kind: 'decided'; reply: AgentReply; outcome: TurnOutcome };
