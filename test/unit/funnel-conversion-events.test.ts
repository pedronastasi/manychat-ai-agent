import { afterAll, describe, it, expect } from 'vitest';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { z } from 'zod';
import { ActionStage, buildTools } from '../../src/agent/tools.ts';
import type { ContactActions } from '../../src/agent/tools.ts';
import { actionsNote, buildSystemPrompt } from '../../src/agent/prompt.ts';
import type { Tools } from '../../src/contracts/config.ts';
import { ActionRecord } from '../../src/contracts/agent.ts';
import { ConfigError, loadTenantConfig } from '../../src/config/loader.ts';

/**
 * specs/027-funnel-conversion-events.md § Verification items 1, 2 and 7,
 * against the fictional demo tenant in test/fixtures/config with an invented
 * `events` list added.
 */

const FIXTURE = 'test/fixtures/config';
const tenant = loadTenantConfig(FIXTURE);

const EVENTS: Tools['events'] = [
  { id: 'lead_qualified', stage: 'nurturing', flowNs: 'content00000000000000_000101' },
  { id: 'offer_made', stage: 'offered', flowNs: 'content00000000000000_000102' },
  { id: 'checkout_started', stage: 'link_sent', flowNs: 'content00000000000000_000103' },
];
const tools: Tools = { ...tenant.tools!, events: EVENTS };

const fixtureTools = JSON.parse(readFileSync(`${FIXTURE}/tools.json`, 'utf8')) as {
  flows: { flowNs: string }[];
  fields: Record<string, unknown>[];
  events?: unknown[];
};

/* -------------------------------------------------------------------------- */
/* V1 — events are checked at load                                            */
/* -------------------------------------------------------------------------- */

describe('events are checked at load (specs/027 V1)', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  /** The demo tenant with its tools.json edited, as a load to assert on. */
  function loadWith(edit: (raw: typeof fixtureTools) => void, reserved = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'events-'));
    dirs.push(dir);
    for (const file of ['prompt.md', 'catalog.json', 'rules.json']) {
      copyFileSync(join(FIXTURE, file), join(dir, file));
    }
    const raw = structuredClone(fixtureTools);
    raw.events = structuredClone(EVENTS);
    edit(raw);
    writeFileSync(join(dir, 'tools.json'), JSON.stringify(raw));
    return () => loadTenantConfig(dir, reserved);
  }

  const events = (raw: typeof fixtureTools) => raw.events as Record<string, unknown>[];

  it('loads a tenant with one event per stage', () => {
    expect(loadWith(() => {})().tools!.events).toEqual(EVENTS);
  });

  it('defaults to no events', () => {
    expect(tenant.tools!.events).toEqual([]);
  });

  it('refuses two entries for one stage', () => {
    const load = loadWith(raw => {
      events(raw).push({
        id: 'second',
        stage: 'nurturing',
        flowNs: 'content00000000000000_000199',
      });
    });
    expect(load).toThrow(ConfigError);
    expect(load).toThrow(/at most one event per stage/);
  });

  it('refuses an entry on new', () => {
    const load = loadWith(raw => {
      events(raw).push({ id: 'arrived', stage: 'new', flowNs: 'content00000000000000_000199' });
    });
    expect(load).toThrow(/stage "new"/);
  });

  it('refuses a stage that is not a funnel stage', () => {
    const load = loadWith(raw => {
      events(raw).push({ id: 'paid', stage: 'enrolled', flowNs: 'content00000000000000_000199' });
    });
    expect(load).toThrow(ConfigError);
  });

  it('refuses a flowNs equal to a flows[] entry', () => {
    const load = loadWith(raw => {
      events(raw)[0]!.flowNs = raw.flows[0]!.flowNs;
    });
    expect(load).toThrow(/may not be a flow's or another event's/);
  });

  it('refuses a flowNs equal to another event', () => {
    const load = loadWith(raw => {
      events(raw)[1]!.flowNs = events(raw)[0]!.flowNs;
    });
    expect(load).toThrow(/may not be a flow's or another event's/);
  });

  it('refuses a flowNs equal to the reply flow', () => {
    const load = loadWith(() => {}, { replyFlowNs: EVENTS[2]!.flowNs });
    expect(load).toThrow(/event 'checkout_started' is MANYCHAT_REPLY_FLOW_NS/);
  });

  it('refuses events without a funnel field', () => {
    const load = loadWith(raw => {
      raw.fields = raw.fields.filter(field => !field.funnel);
    });
    expect(load).toThrow(/events need a field marked "funnel"/);
  });
});

/* -------------------------------------------------------------------------- */
/* V2 — the model never sees an event                                         */
/* -------------------------------------------------------------------------- */

describe('no event reaches the model (specs/027 V2)', () => {
  const secrets = EVENTS.flatMap(event => [event.id, event.flowNs]);

  /** Every word a built tool shows the model: its description and parameter schema. */
  async function rendered(built: ReturnType<typeof buildTools>) {
    const { asSchema } = await import('ai');
    const parts: string[] = [];
    for (const [name, entry] of Object.entries(built!)) {
      // Every description here is a plain string; a computed one would escape this check.
      expect(typeof entry.description).toBe('string');
      parts.push(name, entry.description as string);
      parts.push(JSON.stringify(await asSchema(entry.inputSchema as z.ZodType).jsonSchema));
    }
    return parts.join('\n');
  }

  const contacts: ContactActions[] = [
    { sentFlows: new Set() },
    { sentFlows: new Set(), funnelStage: 'qualifying' },
    { sentFlows: new Set(), funnelStage: 'offered' },
  ];

  it.each(contacts)(
    'offers no event id or flowNs in any tool (stage $funnelStage)',
    async contact => {
      const text = await rendered(buildTools(tools, new ActionStage(), contact, undefined));
      expect(text).toContain('set_field');
      for (const secret of secrets) expect(text).not.toContain(secret);
    },
  );

  it('leaves events out of the system instructions', () => {
    const prompt = buildSystemPrompt(tenant.persona, tenant.catalog, tenant.rules, tools);
    const text = JSON.stringify(prompt);
    expect(text).toContain('SALES');
    for (const secret of [...secrets, 'send_event']) expect(text).not.toContain(secret);
  });
});

/* -------------------------------------------------------------------------- */
/* V7 — the history note omits events                                         */
/* -------------------------------------------------------------------------- */

describe('the history note omits send_event (specs/027 V7)', () => {
  it('lists the funnel write and leaves its event out', () => {
    const actions = ActionRecord.array().parse([
      { tool: 'set_field', id: 'funnel_stage', value: 'nurturing', status: 'performed' },
      { tool: 'send_event', id: 'lead_qualified', status: 'performed' },
    ]);
    expect(actionsNote(actions)).toBe('[actions performed: set_field funnel_stage=nurturing]');
  });

  it('writes no note for a turn whose only performed entry is an event', () => {
    expect(actionsNote([{ tool: 'send_event', id: 'lead_qualified', status: 'performed' }])).toBe(
      null,
    );
  });
});
