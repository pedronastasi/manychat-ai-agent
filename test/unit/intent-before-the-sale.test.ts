import { describe, it, expect } from 'vitest';
import {
  ActionStage,
  MAX_ACTIONS_PER_TURN,
  buildTools,
  contactActionsFrom,
} from '../../src/agent/tools.ts';
import type { ContactActions } from '../../src/agent/tools.ts';
import { ContactReads } from '../../src/agent/contact.ts';
import type { FlowSends } from '../../src/agent/flows.ts';
import { buildSystemPrompt, intentNotice } from '../../src/agent/prompt.ts';
import { ManyChatAdapter } from '../../src/channels/manychat/adapter.ts';
import { ToolsSchema } from '../../src/contracts/config.ts';
import type { Tools } from '../../src/contracts/config.ts';
import type { ActionRecord } from '../../src/contracts/agent.ts';
import { ContactRecord } from '../../src/contracts/manychat.ts';
import { loadTenantConfig } from '../../src/config/loader.ts';

/**
 * specs/034-intent-before-the-sale.md § Verification items 1, 2 and 3, against
 * the fictional demo tenant in test/fixtures/config.
 */

const tenant = loadTenantConfig('test/fixtures/config');
const tools: Tools = tenant.tools!;

type Raw = Record<string, unknown> & { fields: Record<string, unknown>[] };
const raw = (): Raw => structuredClone(tools);
const messages = (input: Raw) => {
  const result = ToolsSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map(issue => issue.message);
};
const intentOf = (input: Raw) => input.fields.find(field => field.intent)!;

/** Calls a built tool's `execute` the way the SDK does. */
async function call(built: ReturnType<typeof buildTools>, name: string, input: object) {
  return (await built![name]!.execute!(input as never, {
    toolCallId: 'test',
    messages: [],
    context: {},
  })) as Record<string, unknown>;
}

/** A flow sender that records every request: the ManyChat boundary. */
function sender() {
  const requests: string[] = [];
  const flows = {
    send: (actions: { id: string }[]) => {
      requests.push(...actions.map(action => action.id));
      return Promise.resolve(
        actions.map(action => [{ tool: 'send_flow', id: action.id, status: 'performed' }]),
      );
    },
  } as unknown as FlowSends;
  return { flows, requests };
}

const unknownContact: ContactActions = { sentFlows: new Set() };
const prospect: ContactActions = { sentFlows: new Set(), intent: 'prospect' };

/* -------------------------------------------------------------------------- */
/* V1 — the intent field is checked at load                                   */
/* -------------------------------------------------------------------------- */

describe('the intent field is checked at load (specs/034 V1)', () => {
  it('accepts the demo tenant, whose funnel has an intent field', () => {
    expect(messages(raw())).toEqual([]);
  });

  it('refuses a funnel field without an intent field', () => {
    const input = raw();
    input.fields = input.fields.filter(field => !field.intent);
    expect(messages(input)).toContain('a field marked "funnel" needs a field marked "intent"');
  });

  it.each([
    [['prospect', 'not_prospect']],
    [['not_prospect', 'prospect', 'student']],
    [['prospect']],
  ])('refuses intent values %j', values => {
    const input = raw();
    intentOf(input).values = values;
    expect(messages(input).join()).toMatch(
      /"intent" field's values must be not_prospect, prospect/,
    );
  });

  it('refuses two intent fields', () => {
    const input = raw();
    input.fields.push({ ...intentOf(input), id: 'second_intent', field: 'second_intent' });
    expect(messages(input)).toContain('only one field may be marked "intent"');
  });

  it.each(['funnel', 'course'])('refuses a field marked both intent and %s', flag => {
    const input = raw();
    intentOf(input)[flag] = true;
    expect(messages(input)).toContain(
      'a field may not be marked both "intent" and "funnel" or "course"',
    );
  });

  it('refuses an opening flow without an intent field, which could never send it', () => {
    const input = raw();
    input.fields = input.fields.filter(field => !field.intent && !field.funnel);
    (input.flows as Record<string, unknown>[]).push({
      id: 'welcome_note',
      flowNs: 'content00000000000000_000201',
      description: 'A welcome note.',
      role: 'opening',
    });
    expect(messages(input)).toContain('an "opening" flow needs a field marked "intent"');
  });
});

/* -------------------------------------------------------------------------- */
/* V2 — until intent is prospect, the sale's tools refuse                     */
/* -------------------------------------------------------------------------- */

describe('the sale’s tools refuse until the contact is a prospect (specs/034 V2)', () => {
  const NOT_PROSPECT = { staged: false, reason: 'not_prospect' };

  it.each([undefined, 'not_prospect'] as const)(
    'refuses every sale tool for intent %s, with no request and no slot of the cap',
    async intent => {
      const stage = new ActionStage();
      const { flows, requests } = sender();
      const contact = { ...unknownContact, ...(intent ? { intent } : {}) };
      const built = buildTools(tools, stage, contact, undefined, { flows });

      expect(await call(built, 'send_flow', { flow: 'student_results' })).toEqual({
        sent: false,
        reason: 'not_prospect',
      });
      expect(await call(built, 'add_tag', { tag: 'interested_foundation' })).toEqual(NOT_PROSPECT);
      expect(await call(built, 'remove_tag', { tag: 'interested_foundation' })).toEqual(
        NOT_PROSPECT,
      );
      expect(await call(built, 'schedule_nudge', { delay: 'tomorrow' })).toEqual(NOT_PROSPECT);
      for (const [field, value] of [
        ['funnel_stage', 'qualifying'],
        ['prior_experience', 'none'],
        ['course', 'foundation'],
      ]) {
        expect(await call(built, 'set_field', { field, value })).toEqual(NOT_PROSPECT);
      }
      expect(requests).toEqual([]);
      expect(stage.staged).toEqual([]);
      expect(stage.dropped).toEqual([]);

      // None took a slot: the whole cap is still free.
      for (let index = 0; index < MAX_ACTIONS_PER_TURN; index++) {
        expect(
          await call(built, 'write_note', { note: 'goal', text: `Wants ${index} things.` }),
        ).toEqual({ staged: true });
      }
    },
  );

  it('refuses them when staged as well, on a turn with no flow sender', async () => {
    const built = buildTools(tools, new ActionStage(), unknownContact);
    expect(await call(built, 'send_flow', { flow: 'student_results' })).toEqual(NOT_PROSPECT);
  });

  it('leaves get_contact and write_note unaffected', async () => {
    const stage = new ActionStage();
    const reads = new ContactReads({
      reader: {
        readContact: () => Promise.resolve(ContactRecord.parse({ tags: [], custom_fields: [] })),
      },
      subscriberId: 's1',
      logger: { warn: () => {} },
    });
    const built = buildTools(tools, stage, unknownContact, reads);

    expect(await call(built, 'write_note', { note: 'goal', text: 'Asks for a friend.' })).toEqual({
      staged: true,
    });
    expect(await call(built, 'get_contact', {})).toHaveProperty('tags', []);
  });

  it('accepts them once prospect is performed', async () => {
    const { flows, requests } = sender();
    const built = buildTools(tools, new ActionStage(), prospect, undefined, { flows });

    expect(await call(built, 'send_flow', { flow: 'student_results' })).toEqual({ sent: true });
    expect(await call(built, 'set_field', { field: 'funnel_stage', value: 'qualifying' })).toEqual({
      staged: true,
    });
    expect(requests).toEqual(['student_results']);
  });

  it('accepts them in the same turn once prospect is staged earlier in it', async () => {
    const stage = new ActionStage();
    const { flows, requests } = sender();
    const built = buildTools(tools, stage, unknownContact, undefined, { flows });

    expect(await call(built, 'set_field', { field: 'intent', value: 'prospect' })).toEqual({
      staged: true,
    });
    expect(await call(built, 'send_flow', { flow: 'student_results' })).toEqual({ sent: true });
    expect(await call(built, 'add_tag', { tag: 'interested_foundation' })).toEqual({
      staged: true,
    });
    expect(requests).toEqual(['student_results']);
  });

  it('accepts unknown to not_prospect, and not_prospect to prospect', async () => {
    const stage = new ActionStage();
    const built = buildTools(tools, stage, unknownContact);
    expect(await call(built, 'set_field', { field: 'intent', value: 'not_prospect' })).toEqual({
      staged: true,
    });
    expect(await call(built, 'set_field', { field: 'intent', value: 'prospect' })).toEqual({
      staged: true,
    });
  });

  it('refuses a write from prospect back to not_prospect, performed or staged', async () => {
    const performed = buildTools(tools, new ActionStage(), prospect);
    expect(await call(performed, 'set_field', { field: 'intent', value: 'not_prospect' })).toEqual({
      staged: false,
    });

    const stage = new ActionStage();
    const staged = buildTools(tools, stage, unknownContact);
    await call(staged, 'set_field', { field: 'intent', value: 'prospect' });
    expect(await call(staged, 'set_field', { field: 'intent', value: 'not_prospect' })).toEqual({
      staged: false,
    });
  });

  it('applies no gate to a tenant without an intent field', async () => {
    const noIntent = ToolsSchema.parse({ flows: tools.flows.filter(flow => !flow.role) });
    const built = buildTools(noIntent, new ActionStage(), unknownContact);
    expect(await call(built, 'send_flow', { flow: 'student_results' })).toEqual({ staged: true });
  });
});

/* -------------------------------------------------------------------------- */
/* V3 — the INTENT notice follows the record                                  */
/* -------------------------------------------------------------------------- */

const at = (actions: ActionRecord[]) => [{ createdAt: new Date(), actions }];
const write = (id: string, value: string, status: ActionRecord['status'] = 'performed') =>
  ({ tool: 'set_field', id, value, status }) as ActionRecord;
const since = new Date(0);

describe('the INTENT notice follows the last performed write (specs/034 V3)', () => {
  it('reads the last performed intent write', () => {
    const turns = [...at([write('intent', 'not_prospect')]), ...at([write('intent', 'prospect')])];
    expect(contactActionsFrom(turns, tools, since).intent).toBe('prospect');
  });

  it('ignores a write that was discarded or failed', () => {
    const turns = at([
      write('intent', 'prospect', 'discarded'),
      write('intent', 'prospect', 'failed'),
    ]);
    expect(contactActionsFrom(turns, tools, since).intent).toBeUndefined();
  });

  it('reads a contact past new with no intent write as a prospect (the rollout rule)', () => {
    expect(
      contactActionsFrom(at([write('funnel_stage', 'nurturing')]), tools, since),
    ).toMatchObject({ intent: 'prospect' });
    expect(contactActionsFrom(at([write('funnel_stage', 'new')]), tools, since).intent).toBe(
      undefined,
    );
    // The rule does not spend the opening: the contact never staged the write.
    expect(
      contactActionsFrom(at([write('funnel_stage', 'nurturing')]), tools, since).openingSpent,
    ).toBeUndefined();
  });

  it('spends the opening on a staged prospect write, whatever became of it', () => {
    for (const status of ['performed', 'discarded', 'failed'] as const) {
      const turns = at([write('intent', 'prospect', status)]);
      expect(contactActionsFrom(turns, tools, since).openingSpent).toBe(true);
    }
    const dropped = at([write('intent', 'prospect', 'dropped_over_cap')]);
    expect(contactActionsFrom(dropped, tools, since).openingSpent).toBeUndefined();
  });

  it('says what the server knows, in English, outside the fence', () => {
    expect(intentNotice('prospect')).toBe('INTENT: This contact is a prospect.');
    expect(intentNotice('not_prospect')).toContain('(not_prospect)');
    expect(intentNotice(undefined)).toContain('Nothing recorded shows yet');
    expect(intentNotice(undefined, 'advanced')).toContain(
      'They arrived through the advert for course advanced: record prospect.',
    );
  });

  it('ignores an intent value in the inbound request, which is refused outright', () => {
    const adapter = new ManyChatAdapter({
      sendText: async () => {},
      writeToken: async () => {},
      performAction: async () => {},
    });
    expect(() =>
      adapter.parse(
        { subscriber_id: '1', text: 'hi', intent: 'prospect' },
        { tenantId: 'demo', channel: 'whatsapp' },
      ),
    ).toThrow();
  });

  it('states the criteria and the front desk in the system instructions', () => {
    const { staticPrefix } = buildSystemPrompt(tenant.persona, tenant.catalog, tenant.rules, tools);
    expect(staticPrefix).toContain('INTENT');
    expect(staticPrefix).toContain('Record not_prospect when they say they are already enrolled');
    expect(staticPrefix).toContain('never the enrolment');
    expect(staticPrefix).toContain('Once the contact is a prospect, you take them');
    // Rule 8 continues the conversation, not the sale (specs/034 § A non-prospect).
    expect(staticPrefix).toContain('continue the conversation with high confidence');
    expect(staticPrefix).not.toContain('continue the sales flow');
  });
});
