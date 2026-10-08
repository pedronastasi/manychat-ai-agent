// An invented channel for the specs/038 tests: a chat widget that does not
// exist. `push` reports what it was given through the logger the agent hands
// it, which is how the tests observe a deferred delivery.
import { z } from 'zod';
import { defineChannel, definePlugin } from 'manychat-ai-agent';

export default definePlugin({
  name: 'example-widget',
  apiVersion: 2,
  channels: [
    defineChannel({
      name: 'example-widget',
      apiVersion: 0,
      inbound: z
        .object({
          visitor: z.string().min(1).max(64),
          says: z.string().max(2000),
          nickname: z.string().max(64).optional(),
        })
        .strict(),
      parse: request => ({
        subscriberId: request.visitor,
        text: request.says,
        contactName: request.nickname ?? null,
      }),
      render: reply => ({ say: reply.messages, handoff: reply.escalate }),
      push(call) {
        if (call.reply.messages.some(message => message.includes('unreachable'))) {
          throw new Error('the widget is unreachable');
        }
        call.logger.info('reply pushed', {
          given: Object.keys(call).sort().join(','),
          subscriber: call.subscriberId,
          messages: call.reply.messages.join(' | '),
          handoff: call.reply.escalate,
        });
      },
    }),
  ],
});
