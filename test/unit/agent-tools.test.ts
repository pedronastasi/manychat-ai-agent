import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { z } from 'zod';
import {
  ActionStage,
  buildTools,
  MAX_ACTIONS_PER_TURN,
  describeAction,
  recordOf,
} from '../../src/agent/tools.ts';
import { actionsNote, stagedNotice, ACTION_NOTE_LINE } from '../../src/agent/prompt.ts';
import { ToolsSchema, NO_TOOLS } from '../../src/contracts/config.ts';
import type { Tools } from '../../src/contracts/config.ts';
import type { ActionRecord, StagedAction } from '../../src/contracts/agent.ts';
import { loadTenantConfig, ConfigError } from '../../src/config/loader.ts';
import { mkdtempSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManyChatHttpClient } from '../../src/channels/manychat/client.ts';

/**
 * specs/012-agent-tools.md § Verification.
 *
 * Items 1 (parameter rejection, empty-list exclusion), 2 (execute makes no
 * request), 4 (cap enforcement), 5 (request body pinning), 7 (collision
 * detection) and 10 (history note correctness).
 */

const tools: Tools = ToolsSchema.parse(
  JSON.parse(readFileSync('test/fixtures/config/tools.json', 'utf8')),
);

/* -------------------------------------------------------------------------- */
/* V1 — parameter schemas and empty-list exclusion                            */
/* -------------------------------------------------------------------------- */

describe('tool parameter schemas (specs/012 V1)', () => {
  const parse = (schema: unknown, input: unknown) => (schema as z.ZodType).safeParse(input);

  it('rejects a flow id absent from config', () => {
    const stage = new ActionStage();
    const built = buildTools(tools, stage)!;
    expect(built.send_flow).toBeDefined();
    expect(parse(built.send_flow!.inputSchema, { flow: 'foundation_brochure' }).success).toBe(true);
    expect(parse(built.send_flow!.inputSchema, { flow: 'nonexistent_flow' }).success).toBe(false);
  });

  it('rejects a tag id absent from config', () => {
    const stage = new ActionStage();
    const built = buildTools(tools, stage)!;
    expect(parse(built.add_tag!.inputSchema, { tag: 'interested_foundation' }).success).toBe(true);
    expect(parse(built.add_tag!.inputSchema, { tag: 'nonexistent_tag' }).success).toBe(false);
  });

  it('rejects a field value absent from config', () => {
    const stage = new ActionStage();
    const built = buildTools(tools, stage)!;
    expect(
      parse(built.set_field!.inputSchema, {
        field: 'preferred_schedule',
        value: 'weekday_evenings',
      }).success,
    ).toBe(true);
    expect(
      parse(built.set_field!.inputSchema, {
        field: 'preferred_schedule',
        value: 'free_text_answer',
      }).success,
    ).toBe(false);
  });

  it('rejects a field id absent from config', () => {
    const stage = new ActionStage();
    const built = buildTools(tools, stage)!;
    expect(
      parse(built.set_field!.inputSchema, { field: 'nonexistent_field', value: 'weekday_evenings' })
        .success,
    ).toBe(false);
  });

  it('does not offer a tool whose list is empty', () => {
    const stage = new ActionStage();
    const empty: Tools = { flows: [], tags: [], fields: [] };
    expect(buildTools(empty, stage)).toBeUndefined();

    const flowsOnly: Tools = { flows: tools.flows, tags: [], fields: [] };
    const built = buildTools(flowsOnly, stage)!;
    expect(built.send_flow).toBeDefined();
    expect(built.add_tag).toBeUndefined();
    expect(built.remove_tag).toBeUndefined();
    expect(built.set_field).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* V2 — execute makes no request                                              */
/* -------------------------------------------------------------------------- */

describe('execute makes no request (specs/012 V2)', () => {
  it('staging an action makes zero fetch calls; performing makes one', async () => {
    const calls: unknown[] = [];
    const fetchSpy = ((...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('') });
    }) as unknown as typeof fetch;

    const client = new ManyChatHttpClient({
      apiToken: 'tok',
      replyField: 'ai_message',
      replyFlowNs: 'flow',
      tokenField: 'ai_token',
      requestsPerSecond: 1000,
      fetchImpl: fetchSpy,
    });

    // Staging actions writes to the ActionStage only — no network calls.
    const stage = new ActionStage();
    stage.stage({ tool: 'send_flow', id: 'foundation_brochure', flowNs: 'ns' });
    stage.stage({ tool: 'add_tag', id: 'interested_foundation', tag: 'tg' });
    stage.stage({
      tool: 'set_field',
      id: 'preferred_schedule',
      field: 'preferred_schedule',
      value: 'weekends',
    });

    expect(stage.staged).toHaveLength(3);
    expect(calls).toHaveLength(0);

    // Performing an action IS what calls fetch.
    await client.performAction('sub1', stage.staged[0]!);
    expect(calls.length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* V4 — cap enforcement                                                       */
/* -------------------------------------------------------------------------- */

describe('action cap (specs/012 V4)', () => {
  it(`rejects the ${MAX_ACTIONS_PER_TURN + 1}th action and records it as dropped`, () => {
    const stage = new ActionStage();
    stage.stage({ tool: 'send_flow', id: 'foundation_brochure', flowNs: 'ns' });
    stage.stage({ tool: 'add_tag', id: 'interested_foundation', tag: 'tg' });
    stage.stage({
      tool: 'set_field',
      id: 'preferred_schedule',
      field: 'preferred_schedule',
      value: 'weekends',
    });

    expect(stage.staged).toHaveLength(MAX_ACTIONS_PER_TURN);

    // Fourth: over the cap.
    const accepted = stage.stage({
      tool: 'remove_tag',
      id: 'interested_foundation',
      tag: 'interested-foundation-course',
    });
    expect(accepted).toBe(false);
    expect(stage.dropped).toHaveLength(1);

    const records = stage.records('staged');
    expect(records.filter(rec => rec.status === 'staged')).toHaveLength(MAX_ACTIONS_PER_TURN);
    expect(records.filter(rec => rec.status === 'dropped_over_cap')).toHaveLength(1);
  });

  it('de-duplicates a repeat of an already-staged action', () => {
    const stage = new ActionStage();
    stage.stage({ tool: 'send_flow', id: 'foundation_brochure', flowNs: 'ns1' });
    const repeat = stage.stage({ tool: 'send_flow', id: 'foundation_brochure', flowNs: 'ns1' });
    expect(repeat).toBe(true);
    expect(stage.staged).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* V5 — request body pinning                                                  */
/* -------------------------------------------------------------------------- */

describe('performAction request bodies (specs/012 V5)', () => {
  interface Call {
    url: string;
    body: Record<string, unknown>;
  }

  function clientCapturing(calls: Call[]) {
    return new ManyChatHttpClient({
      apiToken: 'tok',
      replyField: 'ai_message',
      replyFlowNs: 'content123_456',
      tokenField: 'ai_token',
      requestsPerSecond: 1000,
      fetchImpl: ((url: string, init: { body: string }) => {
        calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('') });
      }) as unknown as typeof fetch,
    });
  }

  it('sends a flow with subscriber_id and flow_ns', async () => {
    const calls: Call[] = [];
    await clientCapturing(calls).performAction('sub42', {
      tool: 'send_flow',
      id: 'foundation_brochure',
      flowNs: 'content00000000000000_000001',
    });
    expect(calls).toEqual([
      {
        url: 'https://api.manychat.com/fb/sending/sendFlow',
        body: { subscriber_id: 'sub42', flow_ns: 'content00000000000000_000001' },
      },
    ]);
  });

  it('adds a tag with subscriber_id and tag_name', async () => {
    const calls: Call[] = [];
    await clientCapturing(calls).performAction('sub42', {
      tool: 'add_tag',
      id: 'interested_foundation',
      tag: 'interested-foundation-course',
    });
    expect(calls).toEqual([
      {
        url: 'https://api.manychat.com/fb/subscriber/addTagByName',
        body: { subscriber_id: 'sub42', tag_name: 'interested-foundation-course' },
      },
    ]);
  });

  it('removes a tag with subscriber_id and tag_name', async () => {
    const calls: Call[] = [];
    await clientCapturing(calls).performAction('sub42', {
      tool: 'remove_tag',
      id: 'interested_foundation',
      tag: 'interested-foundation-course',
    });
    expect(calls).toEqual([
      {
        url: 'https://api.manychat.com/fb/subscriber/removeTagByName',
        body: { subscriber_id: 'sub42', tag_name: 'interested-foundation-course' },
      },
    ]);
  });

  it('sets a field with subscriber_id, field_name and a configured value', async () => {
    const calls: Call[] = [];
    await clientCapturing(calls).performAction('sub42', {
      tool: 'set_field',
      id: 'preferred_schedule',
      field: 'preferred_schedule',
      value: 'weekday_evenings',
    });
    expect(calls).toEqual([
      {
        url: 'https://api.manychat.com/fb/subscriber/setCustomFieldByName',
        body: {
          subscriber_id: 'sub42',
          field_name: 'preferred_schedule',
          field_value: 'weekday_evenings',
        },
      },
    ]);
  });

  it('always carries the current turn subscriber_id, never a model-supplied one', async () => {
    const calls: Call[] = [];
    const client = clientCapturing(calls);
    await client.performAction('real-sub', {
      tool: 'send_flow',
      id: 'x',
      flowNs: 'ns',
    });
    expect(calls[0]!.body.subscriber_id).toBe('real-sub');
  });
});

/* -------------------------------------------------------------------------- */
/* V7 — collision detection at config load                                    */
/* -------------------------------------------------------------------------- */

describe('collision detection (specs/012 V7)', () => {
  const FIXTURES = 'test/fixtures/config';
  let dir: string;

  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-tools-'));
    for (const name of ['prompt.md', 'catalog.json', 'rules.json']) {
      copyFileSync(join(FIXTURES, name), join(dir, name));
    }
  };

  const teardown = () => rmSync(dir, { recursive: true, force: true });

  it('rejects a flow whose flowNs equals MANYCHAT_REPLY_FLOW_NS', () => {
    setup();
    try {
      writeFileSync(
        join(dir, 'tools.json'),
        JSON.stringify({
          flows: [{ id: 'clash', flowNs: 'reply_flow_ns', description: 'Clashing flow.' }],
        }),
      );
      expect(() => loadTenantConfig(dir, { replyFlowNs: 'reply_flow_ns' })).toThrow(ConfigError);
      expect(() => loadTenantConfig(dir, { replyFlowNs: 'reply_flow_ns' })).toThrow(/delivery/i);
    } finally {
      teardown();
    }
  });

  it('rejects a field whose field equals MANYCHAT_REPLY_FIELD', () => {
    setup();
    try {
      writeFileSync(
        join(dir, 'tools.json'),
        JSON.stringify({
          fields: [
            {
              id: 'clash',
              field: 'ai_message',
              values: ['a'],
              description: 'Clashing field.',
            },
          ],
        }),
      );
      expect(() => loadTenantConfig(dir, { replyField: 'ai_message' })).toThrow(ConfigError);
    } finally {
      teardown();
    }
  });

  it('rejects a field whose field equals MANYCHAT_TOKEN_FIELD', () => {
    setup();
    try {
      writeFileSync(
        join(dir, 'tools.json'),
        JSON.stringify({
          fields: [
            {
              id: 'clash',
              field: 'ai_token',
              values: ['a'],
              description: 'Clashing field.',
            },
          ],
        }),
      );
      expect(() => loadTenantConfig(dir, { tokenField: 'ai_token' })).toThrow(ConfigError);
    } finally {
      teardown();
    }
  });

  it('loads without error when no collision exists', () => {
    setup();
    try {
      copyFileSync(join(FIXTURES, 'tools.json'), join(dir, 'tools.json'));
      const config = loadTenantConfig(dir, {
        replyFlowNs: 'other_flow_ns',
        replyField: 'other_field',
        tokenField: 'other_token',
      });
      expect(config.tools).toEqual(tools);
    } finally {
      teardown();
    }
  });

  it('loads a tenant with no tools.json as NO_TOOLS', () => {
    setup();
    try {
      const config = loadTenantConfig(dir);
      expect(config.tools).toEqual(NO_TOOLS);
    } finally {
      teardown();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* V10 — history note correctness                                             */
/* -------------------------------------------------------------------------- */

describe('history notes (specs/012 V10)', () => {
  it('includes performed actions in the note', () => {
    const actions: ActionRecord[] = [
      { tool: 'send_flow', id: 'foundation_brochure', status: 'performed' },
      { tool: 'add_tag', id: 'interested_foundation', status: 'performed' },
    ];
    const note = actionsNote(actions);
    expect(note).toContain('send_flow foundation_brochure');
    expect(note).toContain('add_tag interested_foundation');
  });

  it('includes the value for a performed set_field', () => {
    const actions: ActionRecord[] = [
      { tool: 'set_field', id: 'preferred_schedule', value: 'weekends', status: 'performed' },
    ];
    expect(actionsNote(actions)).toContain('set_field preferred_schedule=weekends');
  });

  it('omits discarded actions from the note', () => {
    const actions: ActionRecord[] = [
      { tool: 'send_flow', id: 'foundation_brochure', status: 'discarded' },
    ];
    expect(actionsNote(actions)).toBeNull();
  });

  it('omits failed actions from the note', () => {
    const actions: ActionRecord[] = [
      { tool: 'send_flow', id: 'foundation_brochure', status: 'failed', error: 'ManyChat refused' },
    ];
    expect(actionsNote(actions)).toBeNull();
  });

  it('omits staged actions from the note', () => {
    const actions: ActionRecord[] = [
      { tool: 'send_flow', id: 'foundation_brochure', status: 'staged' },
    ];
    expect(actionsNote(actions)).toBeNull();
  });

  it('returns null for empty or absent actions', () => {
    expect(actionsNote([])).toBeNull();
    expect(actionsNote(null)).toBeNull();
    expect(actionsNote(undefined)).toBeNull();
  });

  it('shows only the performed subset when a turn has mixed statuses', () => {
    const actions: ActionRecord[] = [
      { tool: 'send_flow', id: 'foundation_brochure', status: 'performed' },
      { tool: 'add_tag', id: 'interested_foundation', status: 'failed', error: 'refused' },
      {
        tool: 'set_field',
        id: 'preferred_schedule',
        value: 'weekends',
        status: 'dropped_over_cap',
      },
    ];
    const note = actionsNote(actions)!;
    expect(note).toContain('send_flow foundation_brochure');
    expect(note).not.toContain('add_tag');
    expect(note).not.toContain('set_field');
  });
});

describe('ACTION_NOTE_LINE regex (specs/012 V10)', () => {
  it('matches the note the system writes', () => {
    expect(ACTION_NOTE_LINE.test('[actions performed: send_flow foundation_brochure]')).toBe(true);
  });

  it('matches a model copying the pattern', () => {
    expect(ACTION_NOTE_LINE.test('[actions staged: send_flow x]')).toBe(true);
  });

  it('does not match ordinary prose', () => {
    expect(ACTION_NOTE_LINE.test('I can help you with that.')).toBe(false);
    expect(ACTION_NOTE_LINE.test('Here are some actions you can take.')).toBe(false);
  });
});

describe('staged notice (specs/012)', () => {
  it('lists what was staged for step two', () => {
    const stage = new ActionStage();
    stage.stage({ tool: 'send_flow', id: 'foundation_brochure', flowNs: 'ns' });
    const notice = stagedNotice(stage);
    expect(notice).toContain('send_flow foundation_brochure');
    expect(notice).toContain('Now write the reply');
  });

  it('reports nothing staged when the model called no tools', () => {
    const stage = new ActionStage();
    const notice = stagedNotice(stage);
    expect(notice).toContain('None of your tool calls were staged');
  });

  it('mentions dropped actions over the cap', () => {
    const stage = new ActionStage();
    stage.stage({ tool: 'send_flow', id: 'a', flowNs: 'ns' });
    stage.stage({ tool: 'add_tag', id: 'b', tag: 't' });
    stage.stage({ tool: 'remove_tag', id: 'c', tag: 't' });
    stage.stage({ tool: 'add_tag', id: 'd', tag: 't2' }); // over cap
    const notice = stagedNotice(stage);
    expect(notice).toContain('Not staged');
    expect(notice).toContain('add_tag d');
  });
});

describe('describeAction', () => {
  it('formats a flow action', () => {
    expect(describeAction({ tool: 'send_flow', id: 'brochure' })).toBe('send_flow brochure');
  });

  it('formats a set_field action with value', () => {
    expect(describeAction({ tool: 'set_field', id: 'schedule', value: 'evenings' })).toBe(
      'set_field schedule=evenings',
    );
  });
});

describe('recordOf', () => {
  it('produces an ActionRecord with status', () => {
    const action: StagedAction = { tool: 'send_flow', id: 'x', flowNs: 'ns' };
    const record = recordOf(action, 'performed');
    expect(record).toEqual({ tool: 'send_flow', id: 'x', status: 'performed' });
  });

  it('includes value for set_field', () => {
    const action: StagedAction = { tool: 'set_field', id: 'f', field: 'fld', value: 'v' };
    const record = recordOf(action, 'staged');
    expect(record).toEqual({ tool: 'set_field', id: 'f', value: 'v', status: 'staged' });
  });

  it('includes error when given', () => {
    const action: StagedAction = { tool: 'add_tag', id: 't', tag: 'tg' };
    const record = recordOf(action, 'failed', 'ManyChat 400');
    expect(record.error).toBe('ManyChat 400');
  });

  it('omits flowNs, tag and field from the record', () => {
    const flow = recordOf({ tool: 'send_flow', id: 'x', flowNs: 'ns' }, 'performed');
    expect('flowNs' in flow).toBe(false);
    const tag = recordOf({ tool: 'add_tag', id: 'x', tag: 'tg' }, 'performed');
    expect('tag' in tag).toBe(false);
    const field = recordOf({ tool: 'set_field', id: 'x', field: 'fld', value: 'v' }, 'performed');
    expect('field' in field).toBe(false);
  });
});
