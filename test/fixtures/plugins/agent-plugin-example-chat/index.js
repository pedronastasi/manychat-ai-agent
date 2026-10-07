// An invented chat platform for the specs/038 tests. Its requests look like
// { contact: { id, name? }, message: { text }, token? } and its responses like
// { replies: [...] }. Nothing it sends leaves the process: `push` and
// `writeToken` record what they were given in `globalThis.exampleChat`, which
// is how the tests observe them.
import { defineChannel, definePlugin } from 'manychat-ai-agent';

const sent = (globalThis.exampleChat ??= { pushed: [], tokens: [], failing: false });

// A Zod schema is what a real plugin declares. This is the contract one meets,
// written out, because the fixture installs nothing but the agent.
const inbound = {
  safeParse(value) {
    const ok =
      typeof value === 'object' &&
      value !== null &&
      typeof value.contact?.id === 'string' &&
      value.contact.id.length > 0 &&
      typeof value.message?.text === 'string' &&
      (value.token === undefined || typeof value.token === 'string');
    return ok
      ? { success: true, data: value }
      : { success: false, error: new Error('not an example-chat request') };
  },
};

export default definePlugin({
  name: 'example-chat',
  apiVersion: 1,
  // The literal this plugin was written against, never the agent's constant:
  // importing that would match whatever agent is installed.
  channelApiVersion: 0,
  channels: [
    defineChannel({
      name: 'example-chat',
      inbound,
      maxMessages: 2,
      parse: body => ({
        subscriberId: body.contact.id,
        text: body.message.text,
        contactName: body.contact.name ?? null,
        contactToken: body.token ?? null,
      }),
      render: reply => ({ replies: reply.messages }),
      async push({ subscriberId, reply }) {
        if (sent.failing) throw new Error('example-chat is down');
        sent.pushed.push({ subscriberId, messages: [...reply.messages] });
      },
      async writeToken({ subscriberId, token }) {
        sent.tokens.push({ subscriberId, token });
      },
    }),
  ],
});
