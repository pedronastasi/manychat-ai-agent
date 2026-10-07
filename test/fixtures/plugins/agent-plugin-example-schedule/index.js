// An invented plugin for the specs/039 tests: it reads the seats left on a
// course from a timetable that does not exist. The advanced course's timetable
// is "down", so a read of it fails. `read` reports what it was given through
// the logger the agent hands it, which is how the tests observe it.
import { definePlugin, defineReadTool } from 'manychat-ai-agent';

export default definePlugin({
  name: 'example-schedule',
  apiVersion: 2,
  tools: [
    defineReadTool({
      name: 'class_availability',
      description:
        'Look up the seats left on a course and when its next intake starts, when the contact asks whether there is room or when they could start.',
      parameters: {
        course: { type: 'enum', values: ['foundation', 'advanced'] },
        query: { type: 'query', maxLength: 120, optional: true },
      },
      result: {
        seatsLeft: { type: 'number', integer: true, min: 0 },
        nextStart: { type: 'enum', values: ['this_month', 'next_month', 'later'] },
        waitlist: { type: 'boolean' },
        summary: { type: 'text', maxLength: 300, optional: true },
      },
      read(call) {
        call.logger.info('availability read', {
          given: Object.keys(call).sort().join(','),
          subscriber: call.subscriberId,
          params: JSON.stringify(call.params),
        });
        if (call.params.course === 'advanced') throw new Error('timetable unavailable');
        return {
          seatsLeft: 4,
          nextStart: 'next_month',
          waitlist: false,
          summary: 'The next foundation intake starts next month, on weekday evenings.',
        };
      },
    }),
  ],
});
