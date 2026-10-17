import type { AgentReply, TurnOutcome } from '../contracts/agent.ts';
import type { Binding } from '../conversation/tokens.ts';

export interface TurnResult {
  reply: AgentReply;
  outcome: TurnOutcome;
  conversationId: string;
  binding: Binding;
  /**
   * Performs the actions staged on an inline turn. The caller runs it once the
   * response has been sent, never before (specs/012 § Actions follow the
   * text). It never throws.
   */
  afterResponse?: () => Promise<void>;
  /**
   * The response carries no message: a flow sent this turn is still playing,
   * and the reply follows it from the outbox (specs/030). `reply` is still
   * set, for the log line.
   */
  silent?: boolean;
}
