import type { AgentResult } from '../agent/runner.ts';
import type { InboundMessage } from '../contracts/agent.ts';
import type { Rules } from '../contracts/config.ts';
import { checkKeywords, matchOpeningTrigger } from '../conversation/budget.ts';
import type { ConversationStore } from '../conversation/store.ts';
import type { Binding } from '../conversation/tokens.ts';
import type { NudgeStore } from '../nudge/store.ts';
import { withConversation } from './logger.ts';
import type { TurnLogger } from './logger.ts';
import { plainReply } from './replies.ts';
import type { TurnResult } from './result.ts';

/**
 * Whether a message can be left to the contact's next turn to answer
 * (specs/046 § A waiting message is folded into the next one). The next turn
 * reads it from history, so it must be text the model can read there, and
 * nothing a check of its own words would have answered differently.
 */
export function foldable(inbound: InboundMessage, rules: Rules): boolean {
  return (
    !inbound.media &&
    !matchOpeningTrigger(inbound.text, rules) &&
    checkKeywords(inbound.text, rules).allowed
  );
}

/**
 * Whether the model's reply is dropped because the contact kept writing while
 * it ran, and their next turn answers everything they wrote (specs/046 § A
 * reply the contact wrote past is superseded). Never one that sent a flow,
 * which has reached them, or that escalates, and never a media turn's:
 * history keeps only its marker, so the turn behind could not see what the
 * contact sent.
 */
export function supersedes(
  result: AgentResult,
  turn: { rules: Rules; media: boolean; followed: boolean; flowsSent: number },
): boolean {
  return (
    turn.rules.foldBursts &&
    !turn.media &&
    turn.followed &&
    turn.flowsSent === 0 &&
    !result.reply.escalate &&
    !result.modelError
  );
}

export interface MessageFoldDeps {
  store: ConversationStore;
  nudges: NudgeStore;
  rules: Rules;
  logger: TurnLogger;
}

/**
 * Records a message the contact's next turn answers, and nothing else: no
 * model call, no reply, and a silent response (specs/046).
 */
export class MessageFold {
  private readonly deps: MessageFoldDeps;

  constructor(deps: MessageFoldDeps) {
    this.deps = deps;
  }

  async fold(inbound: InboundMessage, binding: Binding): Promise<TurnResult> {
    const { store, nudges, rules, logger } = this.deps;
    const conversation = await store.startTurn(
      {
        tenantId: inbound.tenantId,
        subscriberId: inbound.subscriberId,
        channel: inbound.channel,
        idleResetHours: rules.idleResetHours,
      },
      new Date(),
    );
    await nudges.cancel(conversation.id, 'contact_replied');
    await store.recordUserMessage(conversation.id, inbound.text, { bound: true });
    withConversation(logger, conversation.id).info(
      { outcome: 'folded' },
      'message folded into the next turn',
    );
    return {
      reply: plainReply([]),
      outcome: 'folded',
      conversationId: conversation.id,
      binding,
      silent: true,
    };
  }
}
