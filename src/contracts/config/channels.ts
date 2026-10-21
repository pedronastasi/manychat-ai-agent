import { z } from 'zod';

/**
 * Channel differences are data, not branches (ADR-0005). The renderer consults
 * this rather than testing `if (channel === 'whatsapp')`.
 */
export const ChannelCapabilities = z.object({
  /** WhatsApp and Telegram silently drop quick replies — omit the key entirely. */
  supportsQuickReplies: z.boolean(),
  maxButtonsPerMessage: z.number().int().nonnegative(),
  maxMessages: z.number().int().positive(),
  maxActions: z.number().int().nonnegative(),
});
export type ChannelCapabilities = z.infer<typeof ChannelCapabilities>;

export const CHANNEL_CAPABILITIES: Record<string, ChannelCapabilities> = {
  whatsapp: {
    supportsQuickReplies: false,
    maxButtonsPerMessage: 3,
    // One, not ten. ManyChat accepts a ten-message array on WhatsApp and
    // delivers only the first, so the platform limit and the delivered limit
    // are different numbers. Ten was the platform's; this is the one that
    // decides what a contact actually reads, and the renderer joins the rest
    // into it rather than dropping them.
    maxMessages: 1,
    maxActions: 5,
  },
  instagram: {
    supportsQuickReplies: true,
    maxButtonsPerMessage: 3,
    maxMessages: 10,
    maxActions: 5,
  },
  messenger: {
    supportsQuickReplies: true,
    maxButtonsPerMessage: 3,
    maxMessages: 10,
    maxActions: 5,
  },
  telegram: {
    supportsQuickReplies: false,
    maxButtonsPerMessage: 10,
    maxMessages: 10,
    maxActions: 5,
  },
};

/**
 * The channels ManyChat delivers a deferred reply to only inside Meta's
 * 24-hour window: they have no template a flow could leave it with
 * (specs/048 § Outside the window, only WhatsApp has a way back).
 */
export const WINDOW_BOUND_CHANNELS: ReadonlySet<string> = new Set(['instagram', 'messenger']);

/** Meta's free-form messaging window, from the contact's last message on a channel. */
export const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

export function capabilitiesFor(channel: string): ChannelCapabilities {
  const caps = CHANNEL_CAPABILITIES[channel];
  if (!caps) {
    throw new Error(
      `Unknown channel '${channel}'. Known: ${Object.keys(CHANNEL_CAPABILITIES).join(', ')}`,
    );
  }
  return caps;
}
