import { knownOffering } from '../agent/tools.ts';
import { describeWriteError } from '../channels/manychat/client.ts';
import type { InboundMessage } from '../contracts/agent.ts';
import type { Rules, Tools } from '../contracts/config.ts';
import type {
  ConversationRecord,
  ConversationStore,
  KnownConversation,
} from '../conversation/store.ts';
import { bindingFor } from '../conversation/tokens.ts';
import type { Binding, ContactTokens } from '../conversation/tokens.ts';
import type { NudgeStore } from '../nudge/store.ts';
import { withConversation } from './logger.ts';
import type { TurnLogger } from './logger.ts';
import { mediaMarker } from './media.ts';

/**
 * A plugin channel's contact is bound by the channel's own auth: it has no
 * token to present, and none is issued (specs/038).
 */
export function bindingOf(
  known: KnownConversation | undefined,
  inbound: InboundMessage,
  channel: string | undefined,
): Binding {
  return channel !== undefined ? 'bound' : bindingFor(known, inbound.contactToken);
}

export interface TurnAdmissionDeps {
  store: ConversationStore;
  tokens: ContactTokens;
  nudges: NudgeStore;
  rules: Rules;
  tools: Tools;
  /** CONTACT_TOKENS_ENFORCED: false only while tokens reach existing contacts. */
  tokensEnforced: boolean;
  /** The plugin channel the turn arrived on (specs/038); ManyChat when absent. */
  channel?: string | undefined;
  logger: TurnLogger;
}

/** A turn let into the contact's conversation, with their message recorded. */
export interface Admitted {
  known: KnownConversation | undefined;
  binding: Binding;
  /** Whether the turn may change the contact's own state (specs/019). */
  bound: boolean;
  /** Whether the turn may read the contact's history, and their record (specs/019, 024). */
  readsHistory: boolean;
  conversation: ConversationRecord;
  /** Names the conversation on every line (ADR-0014). */
  logger: TurnLogger;
  /** The contact's message, whose text a transcript later replaces (specs/020). */
  userTurnId: string;
  /** The offering kept before this turn, if the catalog still has it (specs/028). */
  keptOffering: string | undefined;
  /** The offering the request carried, if the catalog has it (specs/028). */
  requestOffering: string | undefined;
}

/**
 * Lets a request into the contact's conversation: proves whose it is
 * (specs/019), starts the turn, keeps the offering the request carries
 * (specs/028), records the contact's message, and issues a token where one is
 * owed. Nothing here reaches the model.
 */
export class TurnAdmission {
  private readonly deps: TurnAdmissionDeps;

  constructor(deps: TurnAdmissionDeps) {
    this.deps = deps;
  }

  async admit(inbound: InboundMessage, now: Date): Promise<Admitted> {
    const { store, nudges, rules, tools, tokensEnforced, channel } = this.deps;

    // The shared secret proved the caller; the token proves the contact
    // (specs/019). Without it the request is answered from its own message
    // alone, and neither reads nor extends the contact's history.
    const known = await store.find(inbound.tenantId, inbound.subscriberId);
    const binding = bindingOf(known, inbound, channel);
    // During the rollout a request without the token is treated as it was
    // before specs/019, so nobody loses context before their token lands.
    const bound = binding !== 'unbound' || !tokensEnforced;
    // A contact with no token yet starts their history here: whatever came
    // before was never proved to be theirs.
    const readsHistory = binding === 'bound' || !tokensEnforced;

    // Only a bound turn counts toward the cap or moves the idle gap; the
    // per-contact rate limit bounds the rest (specs/019 § Only bound turns
    // enter history and the turn cap).
    const conversation =
      !bound && known
        ? known
        : await store.startTurn(
            {
              tenantId: inbound.tenantId,
              subscriberId: inbound.subscriberId,
              channel: inbound.channel,
              idleResetHours: rules.idleResetHours,
            },
            now,
          );
    const logger = withConversation(this.deps.logger, conversation.id);

    // The request's offering is ManyChat's value now, which already holds every
    // write this service performed, so it wins over the one kept here
    // (specs/028). It narrows this turn's flows bound or not, but only a
    // bound request may store it: an unbound one must not change the
    // contact's own state (specs/019). The kept one is checked too, since a
    // reload may have dropped its offering from the catalog.
    const keptOffering = knownOffering(known?.offering, tools);
    const requestOffering = knownOffering(inbound.offering, tools);
    if (bound && requestOffering !== undefined && requestOffering !== keptOffering) {
      await store.setOffering(conversation.id, requestOffering);
    }
    // The contact wrote, so the follow-up waiting for their silence is moot
    // (specs/025). Any message, bound or not: it errs toward sending nothing.
    await nudges.cancel(conversation.id, 'contact_replied');
    const media = inbound.media;
    const userTurnId = await store.recordUserMessage(
      conversation.id,
      media ? mediaMarker(media.kind) : inbound.text,
      { bound, mediaKind: media?.kind },
    );

    // Watched as a share of all turns: a flow that stopped sending the field
    // shows up here and nowhere else.
    if (binding === 'unbound') logger.info({ binding, enforced: tokensEnforced }, 'unbound turn');

    // A contact without a token gets one, and so does an unbound request,
    // which repairs a cleared field or a lost write. It goes only to the real
    // contact's field, so a forger gains nothing by triggering it.
    if (binding !== 'bound') {
      const issued = await this.deps.tokens.issue(
        {
          tenantId: inbound.tenantId,
          subscriberId: inbound.subscriberId,
          conversationId: conversation.id,
        },
        now,
      );
      issued?.written.catch((error: unknown) => {
        logger.error({ error: describeWriteError(error) }, 'contact token write failed');
      });
    }

    return {
      known,
      binding,
      bound,
      readsHistory,
      conversation,
      logger,
      userTurnId,
      keptOffering,
      requestOffering,
    };
  }
}
