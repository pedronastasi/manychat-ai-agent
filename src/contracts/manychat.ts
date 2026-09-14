import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Inbound: what ManyChat POSTs to us                                          */
/* -------------------------------------------------------------------------- */

/**
 * ManyChat sends whatever fields the Dynamic Block is configured to send, so we
 * pin the minimum we require and reject the rest.
 *
 * `.strict()` is deliberate (ADR-0003): against a vendor UI we do not control, a
 * surprise field should be a loud 400, not a silently ignored change.
 */
export const ManyChatInbound = z
  .object({
    subscriber_id: z.union([z.string(), z.number()]).transform(String),
    text: z.string().max(4096),
    first_name: z.string().nullish(),
    last_name: z.string().nullish(),
    locale: z.string().nullish(),
    channel: z.string().nullish(),
  })
  .strict();
export type ManyChatInbound = z.infer<typeof ManyChatInbound>;

/* -------------------------------------------------------------------------- */
/* Outbound: Dynamic Block v2                                                  */
/* -------------------------------------------------------------------------- */

/** Platform hard limits — specs/002-channel-contract.md. */
export const MANYCHAT_MAX_MESSAGES = 10;
export const MANYCHAT_MAX_QUICK_REPLIES = 11;
export const MANYCHAT_MAX_ACTIONS = 5;

const HttpsUrl = z.string().url().startsWith('https://', 'ManyChat requires HTTPS URLs');

export const ManyChatButton = z.discriminatedUnion('type', [
  z.object({ type: z.literal('url'), caption: z.string(), url: HttpsUrl }),
  z.object({ type: z.literal('call'), caption: z.string(), phone: z.string() }),
  z.object({ type: z.literal('flow'), caption: z.string(), target: z.string() }),
  z.object({ type: z.literal('node'), caption: z.string(), target: z.string() }),
]);

export const ManyChatMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string().min(1),
    buttons: z.array(ManyChatButton).optional(),
  }),
  z.object({
    type: z.literal('image'),
    url: HttpsUrl,
    buttons: z.array(ManyChatButton).optional(),
  }),
  z.object({ type: z.literal('file'), url: HttpsUrl }),
]);

export type ManyChatMessage = z.infer<typeof ManyChatMessage>;
export type ManyChatButton = z.infer<typeof ManyChatButton>;

export const ManyChatAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add_tag'), tag_name: z.string() }),
  z.object({ action: z.literal('remove_tag'), tag_name: z.string() }),
  z.object({
    action: z.literal('set_field_value'),
    field_name: z.string(),
    value: z.union([z.string(), z.number(), z.boolean()]),
  }),
  z.object({ action: z.literal('unset_field_value'), field_name: z.string() }),
]);

export const ManyChatQuickReply = z.discriminatedUnion('type', [
  z.object({ type: z.literal('flow'), caption: z.string(), target: z.string() }),
  z.object({ type: z.literal('node'), caption: z.string(), target: z.string() }),
]);

/**
 * Registers a callback for the contact's NEXT message, which is what keeps the
 * conversation loop in this service rather than in ManyChat's flow builder
 * (specs/002 § Owning the conversation loop).
 */
export const ExternalMessageCallback = z.object({
  url: HttpsUrl,
  method: z.literal('post'),
  headers: z.record(z.string(), z.string()).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  timeout: z.number().int().positive().max(86_400),
});

export const ManyChatResponse = z.object({
  version: z.literal('v2'),
  content: z.object({
    messages: z.array(ManyChatMessage).min(1).max(MANYCHAT_MAX_MESSAGES),
    actions: z.array(ManyChatAction).max(MANYCHAT_MAX_ACTIONS).optional(),
    // Omitted entirely on channels that do not support them. An empty array is
    // NOT equivalent — see specs/002 § Channel capability matrix.
    quick_replies: z.array(ManyChatQuickReply).max(MANYCHAT_MAX_QUICK_REPLIES).optional(),
    external_message_callback: ExternalMessageCallback.optional(),
  }),
});
export type ManyChatResponse = z.infer<typeof ManyChatResponse>;
