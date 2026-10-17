import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { idsOf, STAGED } from './copy.ts';
import { NOT_PROSPECT } from './turn.ts';
import type { ToolTurn } from './turn.ts';

/** `schedule_nudge`: a follow-up if the contact goes quiet; never on a nudge turn (specs/025). */
export function addScheduleNudge(turn: ToolTurn, tools: ToolSet) {
  const { config, stage, options } = turn;
  if (config.nudge && !options.nudgeTurn) {
    const delays = new Map(config.nudge.delays.map(delay => [delay.id, delay]));
    const listing = config.nudge.delays
      .map(delay => `- ${delay.id}: in ${delay.minutes} minutes`)
      .join('\n');
    tools.schedule_nudge = tool({
      description:
        `Give yourself one more turn later, if the contact has not written by then.\n${listing}\n` +
        `A later call replaces an earlier one. ${STAGED}`,
      inputSchema: z.object({ delay: z.enum(idsOf(config.nudge.delays)) }),
      // A non-prospect is never followed up (specs/034).
      execute: ({ delay }) =>
        turn.closed()
          ? NOT_PROSPECT
          : {
              staged: stage.stage({
                tool: 'schedule_nudge',
                id: delay,
                minutes: delays.get(delay)!.minutes,
              }),
            },
    });
  }
}
