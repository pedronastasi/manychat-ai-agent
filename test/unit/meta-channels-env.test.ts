import { describe, it, expect } from 'vitest';
import {
  EnvSchema,
  acceptedChannels,
  ownReplyFlows,
  replyFlowFor,
} from '../../src/contracts/config.ts';

/**
 * specs/048-one-deployment-every-meta-channel.md § Verification item 6, and
 * the boot checks of § The channel belongs to the request.
 */

const base = {
  AGENT_MODEL: 'anthropic:claude-haiku-4-5',
  PUBLIC_BASE_URL: 'https://agent.example.com',
  MANYCHAT_SHARED_SECRET: 'a'.repeat(32),
  DATABASE_URL: 'pglite',
};

describe('a channel accepted with no flow is a boot error (specs/048 V6)', () => {
  it('refuses Instagram with deferred delivery configured and no Instagram flow', () => {
    const parsed = EnvSchema.safeParse({
      ...base,
      CHANNELS: 'whatsapp,instagram',
      MANYCHAT_API_TOKEN: 'tok',
      MANYCHAT_REPLY_FLOW_NS: 'content_whatsapp_reply',
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map(issue => issue.path)).toContainEqual(['CHANNELS']);
  });

  it('boots once the Instagram flow is set', () => {
    const parsed = EnvSchema.safeParse({
      ...base,
      CHANNELS: 'whatsapp,instagram',
      MANYCHAT_API_TOKEN: 'tok',
      MANYCHAT_REPLY_FLOW_NS_INSTAGRAM: 'content_instagram_reply',
    });
    expect(parsed.success).toBe(true);
  });

  it.each(['instagram', 'messenger'])(
    'boots a %s-only deployment that kept its flow in MANYCHAT_REPLY_FLOW_NS, as before the spec',
    channel => {
      const env = EnvSchema.parse({
        ...base,
        CHANNEL: channel,
        MANYCHAT_API_TOKEN: 'tok',
        MANYCHAT_REPLY_FLOW_NS: 'content_single_channel_reply',
      });
      expect(replyFlowFor(env, channel)).toBe('content_single_channel_reply');
      expect(ownReplyFlows(env)).toEqual({ [channel]: 'content_single_channel_reply' });
    },
  );

  it('boots without an API token, when nothing is deferred at all', () => {
    expect(EnvSchema.safeParse({ ...base, CHANNELS: 'whatsapp,messenger' }).success).toBe(true);
  });
});

describe('the channels a deployment answers (specs/048 § The channel belongs to the request)', () => {
  it('defaults CHANNELS to CHANNEL, so a deployment that sets neither is unchanged', () => {
    expect(acceptedChannels(EnvSchema.parse(base))).toEqual(['whatsapp']);
    expect(acceptedChannels(EnvSchema.parse({ ...base, CHANNEL: 'messenger' }))).toEqual([
      'messenger',
    ]);
  });

  it.each([
    ['an unknown CHANNEL', { CHANNEL: 'carrier-pigeon' }],
    ['an unknown entry in CHANNELS', { CHANNELS: 'whatsapp,carrier-pigeon' }],
    ['CHANNELS without CHANNEL', { CHANNELS: 'instagram' }],
  ])('refuses %s at boot', (_label, env) => {
    expect(EnvSchema.safeParse({ ...base, ...env }).success).toBe(false);
  });
});
