// An invented plugin for the specs/036 tests: it logs a lead to a CRM that
// does not exist. `perform` reports what it was given through the logger the
// agent hands it, which is how the tests observe it.
import { definePlugin, defineTool } from 'manychat-ai-agent';

export default definePlugin({
  name: 'example-crm',
  apiVersion: 1,
  tools: [
    defineTool({
      name: 'crm_log_lead',
      description: 'Log the contact as a lead in the CRM once they have named a course.',
      parameters: {
        temperature: { type: 'enum', values: ['warm', 'hot'] },
        seats: { type: 'number', integer: true, min: 1, max: 4, optional: true },
        callback: { type: 'boolean' },
        summary: { type: 'note', maxLength: 120, optional: true },
      },
      perform(call) {
        call.logger.info('lead logged', {
          given: Object.keys(call).sort().join(','),
          subscriber: call.subscriberId,
          params: JSON.stringify(call.params),
        });
      },
    }),
  ],
});
