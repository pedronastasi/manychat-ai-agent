# Writing a plugin channel

For a tenant whose contacts write somewhere other than ManyChat. A plugin
channel lets the agent answer on that platform as it answers on ManyChat,
without you patching the package.

> **The channel API is provisional.** It may change in any minor release of
> the agent until a second adapter has been built against it. A plugin names
> the version it was written for, `channelApiVersion: 0`, and an agent that
> no longer supports that version refuses to start rather than run your
> channel wrongly. Read the release notes before each upgrade.

The contract this guide follows is
[spec 038](../../specs/038-plugin-channels.md). Where the two disagree, the
spec wins. Packaging, listing the plugin in `config/plugins.json`, checking it
and running it in the image are the same as for a tool, and are in
[Writing a plugin tool](writing-a-plugin.md).

Throughout, `agent-plugin-example-chat` stands for your plugin and
`example-chat` for its channel.

## What a plugin channel can and cannot do

The channel translates, and decides nothing:

- The agent mounts it at `/v1/channels/example-chat/message`, beside
  ManyChat's route. It sits behind the same shared secret, rate limit and error
  handling.
- Each request runs through the same turn as ManyChat's, with the same budget,
  the same race against the deadline and the same per-contact order. A reply
  that loses the race reaches the contact through the same outbox.
- The channel reads who wrote and what they wrote. The tenant, the channel's
  name and the time are the agent's.
- The agent keeps a contact as `example-chat:<their id>`. A contact on your
  platform never shares history with a ManyChat contact who happens to have
  the same id.

On a plugin channel, everything that acts on a ManyChat contact is off:

- **Tools:** `config/tools.json` tools (flows, tags, fields, notes, nudges) are
  not offered, and the prompt does not describe them. Plugin tools are still
  offered.
- **Contact data:** `get_contact` is not offered.
- **Media:** never downloaded; the contact gets `rules.messages.mediaFallback`.

## Define the channel

```js
import { defineChannel, definePlugin } from 'manychat-ai-agent';
import { z } from 'zod';

const Inbound = z.object({
  contact: z.object({ id: z.string().min(1), name: z.string().optional() }),
  message: z.object({ text: z.string() }),
  token: z.string().optional(),
});

export default definePlugin({
  name: 'example-chat',
  apiVersion: 1,
  channelApiVersion: 0,
  channels: [
    defineChannel({
      name: 'example-chat',
      inbound: Inbound,
      maxMessages: 3,
      parse: body => ({
        subscriberId: body.contact.id,
        text: body.message.text,
        contactName: body.contact.name ?? null,
        contactToken: body.token ?? null,
      }),
      render: reply => ({ replies: reply.messages }),
      async push({ subscriberId, reply, signal }) {
        const response = await fetch('https://chat.example.com/api/send', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ to: subscriberId, messages: reply.messages }),
          signal,
        });
        if (!response.ok) throw new Error(`chat answered ${response.status}`);
      },
      async writeToken({ subscriberId, token, signal }) {
        // Store it where the platform sends it back with each of the contact's messages.
      },
    }),
  ],
});
```

Each field has rules:

- **`channelApiVersion`** is the number you wrote against, as a literal. Never
  import the agent's own constant for it, because that always matches whatever
  agent is installed.
- **`name`** is lowercase letters, digits and hyphens. It is your route's path
  segment. It is neither `manychat` nor another plugin's channel.
- **`inbound`** checks each request body before anything reads it. A body
  that fails gets `400`, and the model is never called. A Zod schema is the
  usual choice, but anything with the same `safeParse` works.
- **`maxMessages`** is how many messages one response may hold. A longer reply
  is joined into the last one, never cut.
- **`parse`** gets the checked body. It returns `subscriberId` and `text`, and
  optionally `contactName`, `locale`, `contactToken` and `media`
  (`{ kind, url }`). The agent checks what it returns too. If it throws or
  returns something malformed, the contact gets the escalation message.
- **`render`** turns a reply into the response body your platform expects.
  `reply.messages` is empty when the response must say nothing, because the
  reply is coming from the outbox.
- **`push`** sends a reply outside the request, for a turn that lost the race.
  If it throws, the outbox retries it, as it retries a failed ManyChat send.
  Pass `signal` to anything that waits: after 10 seconds the agent stops
  waiting and aborts it.
- **`writeToken`** is optional. See the next section.

The published image installs nothing of yours beside the plugin, so a plugin
that imports `zod` bundles it.

## Contact tokens

The shared secret proves who sent the request, but not which contact sent the
message. A contact token proves that
([spec 019](../../specs/019-contact-tokens.md)). The agent issues each contact
a token and gives it to `writeToken`. Your platform stores it for the contact
and sends it back with every message, where `parse` returns it as
`contactToken`.

A channel without `writeToken` gets no tokens. While `CONTACT_TOKENS_ENFORCED`
is on, every turn on that channel is then unbound: it answers from the message
alone and reads no history. The agent logs a warning at startup when this
applies.
