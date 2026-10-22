import { describe, it, expect, afterEach } from 'vitest';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { z } from 'zod';
import { ToolsSchema } from '../../src/contracts/config.ts';
import type { Tools } from '../../src/contracts/config.ts';
import { ConfigError, loadTenantConfig } from '../../src/config/loader.ts';
import { ActionStage, buildTools, toolsOn } from '../../src/agent/tools.ts';
import { GenerateTextRunner } from '../../src/agent/runner.ts';
import { mockModel } from '../helpers/model.ts';
import { asProspect } from '../helpers/intent.ts';

/**
 * specs/049-a-flow-is-authored-per-channel.md § Verification items 1 and 2:
 * what `tools.json` may say, and which flows a turn on each channel is
 * offered. Against the fictional demo tenant in test/fixtures/config, with
 * invented namespaces.
 */

const FIXTURE = 'test/fixtures/config';
const fixture = loadTenantConfig(FIXTURE);

const flow = (flowNs: unknown, id = 'student_work') => ({
  id,
  flowNs,
  description: 'Photos of work by invented students.',
});

/** The fixture's tools with `flows` and `events` replaced. */
const withFlows = (flows: unknown[], events: unknown[] = []): Tools =>
  ToolsSchema.parse({ ...fixture.tools, flows, events });

const issuesOf = (raw: unknown) => {
  const parsed = ToolsSchema.safeParse(raw);
  return parsed.success ? [] : parsed.error.issues.map(issue => issue.message);
};

/** The flow ids `send_flow` offers, or undefined when it is not offered. */
const enumOf = (tools: Tools, channel: string) => {
  const built = buildTools(tools, new ActionStage(), asProspect(), undefined, { channel });
  const schema = built?.send_flow?.inputSchema as z.ZodObject | undefined;
  return (schema?.shape.flow as z.ZodEnum | undefined)?.options as string[] | undefined;
};

describe('flowNs is a string or a map per channel (specs/049 V1)', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('loads a string and a map', () => {
    const tools = withFlows([
      flow('content00000000000000_000201', 'one'),
      flow(
        { whatsapp: 'content00000000000000_000202', instagram: 'content00000000000000_000203' },
        'two',
      ),
    ]);
    expect(tools.flows.map(entry => entry.flowNs)).toEqual([
      'content00000000000000_000201',
      { whatsapp: 'content00000000000000_000202', instagram: 'content00000000000000_000203' },
    ]);
  });

  it.each([
    ['an empty map', {}],
    ['a key outside the three channels', { telegram: 'content00000000000000_000204' }],
    ['an empty value', { instagram: '' }],
  ])('refuses %s', (_case, flowNs) => {
    expect(issuesOf({ flows: [flow(flowNs)] })).not.toEqual([]);
  });

  it("refuses an event whose value is a flow's, under another channel's key", () => {
    expect(
      issuesOf({
        ...fixture.tools,
        flows: [flow({ whatsapp: 'content00000000000000_000205' })],
        events: [
          {
            id: 'checkout',
            stage: 'link_sent',
            flowNs: { instagram: 'content00000000000000_000205' },
          },
        ],
      }),
    ).toContain("an event's flowNs may not be a flow's or another event's");
  });

  it('loads an event that names one tracking flow on two channels', () => {
    const shared = 'content00000000000000_000206';
    expect(
      issuesOf({
        ...fixture.tools,
        flows: [flow('content00000000000000_000207')],
        events: [
          { id: 'checkout', stage: 'link_sent', flowNs: { whatsapp: shared, instagram: shared } },
        ],
      }),
    ).toEqual([]);
  });

  it("refuses a map value that is any channel's reply flow, whichever key it sits under", () => {
    dir = mkdtempSync(join(tmpdir(), 'flow-per-channel-'));
    cpSync(FIXTURE, dir, { recursive: true });
    writeFileSync(
      join(dir, 'tools.json'),
      JSON.stringify({
        flows: [flow({ whatsapp: 'content_instagram_reply' })],
      }),
    );

    expect(() =>
      loadTenantConfig(dir, {
        replyFlowNs: 'content_whatsapp_reply',
        channelReplyFlows: { instagram: 'content_instagram_reply' },
      }),
    ).toThrow(ConfigError);
    expect(() =>
      loadTenantConfig(dir, {
        replyFlowNs: 'content_whatsapp_reply',
        channelReplyFlows: { instagram: 'content_instagram_reply' },
      }),
    ).toThrow(/flow 'student_work' is MANYCHAT_REPLY_FLOW_NS_INSTAGRAM/);
  });
});

describe('a turn sees only the flows its channel has (specs/049 V2)', () => {
  const tools = withFlows([
    flow('content00000000000000_000211', 'whatsapp_only'),
    flow({ instagram: 'content00000000000000_000212' }, 'instagram_only'),
    flow(
      { whatsapp: 'content00000000000000_000213', messenger: 'content00000000000000_000214' },
      'both',
    ),
  ]);

  it("offers a string flow on CHANNEL's turns and never on another channel's", () => {
    expect(enumOf(tools, 'whatsapp')).toEqual(['whatsapp_only', 'both']);
    expect(enumOf(tools, 'instagram')).toEqual(['instagram_only']);
    expect(enumOf(tools, 'messenger')).toEqual(['both']);
  });

  it('reads a string as the deployment default, whichever channel that is', () => {
    const onInstagram = toolsOn(tools, 'instagram', 'instagram');
    expect(onInstagram.flows.map(entry => [entry.id, entry.flowNs])).toEqual([
      ['whatsapp_only', 'content00000000000000_000211'],
      ['instagram_only', 'content00000000000000_000212'],
    ]);
  });

  it('does not offer send_flow on a turn whose channel has no flow', () => {
    const whatsappOnly = withFlows([flow('content00000000000000_000215')]);
    expect(enumOf(whatsappOnly, 'whatsapp')).toEqual(['student_work']);
    expect(enumOf(whatsappOnly, 'instagram')).toBeUndefined();
  });

  it("is what the runner offers the model, on the turn's channel", async () => {
    const offered = async (channel: string | undefined) => {
      const { model, calls } = mockModel({
        messages: ['Here you go.'],
        escalate: false,
        escalation_reason: null,
        closing_question: null,
        confidence: 0.9,
      });
      const runner = new GenerateTextRunner({
        model,
        modelSpec: 'mock:demo',
        config: () => ({ ...fixture, tools }),
        maxOutputTokens: 500,
        temperature: 0,
      });
      await runner.run({
        text: 'Can I see some work?',
        history: [],
        contact: asProspect(),
        channel,
      });
      const sendFlow = calls[0]?.tools?.find(entry => entry.name === 'send_flow') as
        { inputSchema: { properties: { flow: { enum: string[] } } } } | undefined;
      return sendFlow?.inputSchema.properties.flow.enum;
    };

    expect(await offered('instagram')).toEqual(['instagram_only']);
    // No channel is the deployment's default, WhatsApp unless CHANNEL says otherwise.
    expect(await offered(undefined)).toEqual(['whatsapp_only', 'both']);
  });
});
