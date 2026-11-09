import { agentTool, type AgentTools } from './define.ts';
import { z } from 'zod';
import { catalogOf, idsOf, STAGED } from './copy.ts';
import { NOT_PROSPECT } from './turn.ts';
import type { ToolTurn } from './turn.ts';

/** `add_tag` and `remove_tag`: the tenant's tags (specs/012). */
export function addTagTools(turn: ToolTurn, tools: AgentTools) {
  const { config, stage } = turn;
  if (config.tags.length > 0) {
    const tags = new Map(config.tags.map(entry => [entry.id, entry]));
    const input = z.object({ tag: z.enum(idsOf(config.tags)) });
    tools.add_tag = agentTool('add_tag', {
      description: `Add one of these tags to the contact.\n${catalogOf(config.tags)}\n${STAGED}`,
      inputSchema: input,
      execute: ({ tag }) =>
        turn.closed()
          ? NOT_PROSPECT
          : { staged: stage.stage({ tool: 'add_tag', id: tag, tag: tags.get(tag)!.tag }) },
    });
    tools.remove_tag = agentTool('remove_tag', {
      description: `Remove one of these tags from the contact.\n${catalogOf(config.tags)}\n${STAGED}`,
      inputSchema: input,
      execute: ({ tag }) =>
        turn.closed()
          ? NOT_PROSPECT
          : { staged: stage.stage({ tool: 'remove_tag', id: tag, tag: tags.get(tag)!.tag }) },
    });
  }
}
