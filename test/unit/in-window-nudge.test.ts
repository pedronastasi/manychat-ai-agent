import { afterAll, describe, it, expect } from 'vitest';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { ActionStage, buildTools } from '../../src/agent/tools.ts';
import { buildSystemPrompt, FENCE, nudgeNotice } from '../../src/agent/prompt.ts';
import { GenerateTextRunner } from '../../src/agent/runner.ts';
import { NO_TOOLS } from '../../src/contracts/config.ts';
import { ConfigError, loadTenantConfig } from '../../src/config/loader.ts';
import { ManyChatHttpClient } from '../../src/channels/manychat/client.ts';
import { mockModel } from '../helpers/model.ts';
import { manychatAnswer } from '../helpers/manychat.ts';
import { asProspect } from '../helpers/intent.ts';

/**
 * specs/025-in-window-nudge.md § Verification items 1, 2 (the tool offer) and
 * 6 (the trigger note), against the fictional demo tenant in
 * test/fixtures/config.
 */

const FIXTURE = 'test/fixtures/config';
const tenant = loadTenantConfig(FIXTURE);
const tools = tenant.tools!;

const scratch = mkdtempSync(join(tmpdir(), 'nudge-config-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The fixture tenant with its `nudge` section replaced, loaded as at boot. */
function loadWithNudge(nudge: unknown) {
  const dir = mkdtempSync(join(scratch, 'tenant-'));
  for (const file of ['prompt.md', 'catalog.json', 'rules.json']) {
    copyFileSync(join(FIXTURE, file), join(dir, file));
  }
  const raw = JSON.parse(readFileSync(join(FIXTURE, 'tools.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  if (nudge === undefined) delete raw.nudge;
  else raw.nudge = nudge;
  writeFileSync(join(dir, 'tools.json'), JSON.stringify(raw));
  return () => loadTenantConfig(dir);
}

const reply = {
  messages: ['Just checking in.'],
  escalate: false,
  escalation_reason: null,
  confidence: 0.9,
  closing_question: null,
};

const toolNames = (call: LanguageModelV4CallOptions | undefined) =>
  (call?.tools ?? []).map(entry => entry.name);

describe('the nudge section is checked at load (specs/025 V1)', () => {
  it('accepts a delay of exactly 1380 minutes', () => {
    const load = loadWithNudge({ delays: [{ id: 'latest', minutes: 1380 }] });
    expect(load().tools?.nudge?.delays).toEqual([{ id: 'latest', minutes: 1380 }]);
  });

  it('refuses a delay over 1380 minutes', () => {
    const load = loadWithNudge({ delays: [{ id: 'too_late', minutes: 1381 }] });
    expect(load).toThrow(ConfigError);
    expect(load).toThrow(/1380/);
  });

  it('refuses an empty humanActiveTag', () => {
    const load = loadWithNudge({
      delays: [{ id: 'tomorrow', minutes: 1200 }],
      humanActiveTag: '',
    });
    expect(load).toThrow(ConfigError);
  });

  it('refuses a humanActiveTag the agent can add or remove', () => {
    const load = loadWithNudge({
      delays: [{ id: 'tomorrow', minutes: 1200 }],
      humanActiveTag: tools.tags[0]!.tag,
    });
    expect(load).toThrow(/humanActiveTag/);
  });

  it('offers schedule_nudge with a nudge section and not without one', () => {
    const withNudge = buildTools(tools, new ActionStage(), asProspect());
    expect(Object.keys(withNudge!)).toContain('schedule_nudge');

    const withoutNudge = loadWithNudge(undefined)().tools!;
    expect(withoutNudge.nudge).toBeUndefined();
    expect(Object.keys(buildTools(withoutNudge, new ActionStage(), asProspect())!)).not.toContain(
      'schedule_nudge',
    );
  });

  it('offers schedule_nudge to a tenant whose only tool is the nudge', () => {
    const only = { ...NO_TOOLS, nudge: tools.nudge };
    expect(Object.keys(buildTools(only, new ActionStage(), asProspect())!)).toEqual([
      'schedule_nudge',
    ]);
    expect(buildSystemPrompt('', tenant.catalog, tenant.rules, only).staticPrefix).toContain(
      'FOLLOW-UPS',
    );
  });

  it('never shows the model humanActiveTag', () => {
    const { staticPrefix } = buildSystemPrompt('', tenant.catalog, tenant.rules, tools);
    const description = String(
      buildTools(tools, new ActionStage(), asProspect())!.schedule_nudge!.description,
    );
    expect(staticPrefix).not.toContain(tools.nudge!.humanActiveTag!);
    expect(description).not.toContain(tools.nudge!.humanActiveTag!);
  });
});

describe('a nudge turn is offered no schedule_nudge (specs/025 V2)', () => {
  it('stages the delay the model names, with its minutes', async () => {
    const stage = new ActionStage();
    const built = buildTools(tools, stage, asProspect());
    const execute = built!.schedule_nudge!.execute!;
    await execute({ delay: 'tomorrow' } as never, {
      toolCallId: 'test',
      messages: [],
      context: {},
    });
    expect(stage.staged).toEqual([{ tool: 'schedule_nudge', id: 'tomorrow', minutes: 1200 }]);
  });

  it('builds no schedule_nudge for a nudge turn', () => {
    const built = buildTools(tools, new ActionStage(), asProspect(undefined), undefined, {
      nudgeTurn: true,
    });
    expect(Object.keys(built!)).not.toContain('schedule_nudge');
    expect(Object.keys(built!)).toContain('send_flow');
  });

  it('sends the model no schedule_nudge on a nudge turn, and does on a contact turn', async () => {
    const { model, calls } = mockModel(reply);
    const runner = new GenerateTextRunner({
      model,
      modelSpec: 'mock:demo',
      config: () => tenant,
      maxOutputTokens: 400,
      temperature: 0,
    });
    await runner.run({ text: 'hi', history: [] });
    await runner.run({ text: '', history: [], nudge: { since: new Date() } });

    expect(toolNames(calls[0])).toContain('schedule_nudge');
    expect(toolNames(calls[1])).not.toContain('schedule_nudge');
    expect(toolNames(calls[1])).toContain('send_flow');
  });
});

describe('the trigger note sits outside the fence (specs/025 V6)', () => {
  it('sends the note unfenced, after fenced history', async () => {
    const { model, calls } = mockModel(reply);
    const runner = new GenerateTextRunner({
      model,
      modelSpec: 'mock:demo',
      config: () => tenant,
      maxOutputTokens: 400,
      temperature: 0,
    });
    const since = new Date('2026-01-15T10:00:00Z');
    await runner.run({
      text: '',
      history: [
        { role: 'user', text: 'can i pay in instalments?' },
        { role: 'agent', text: 'Yes, in three monthly payments.' },
      ],
      nudge: { since },
    });

    const prompt = calls[0]!.prompt;
    const users = prompt.filter(entry => entry.role === 'user');
    const texts = (entry: (typeof prompt)[number]) =>
      typeof entry.content === 'string'
        ? [entry.content]
        : entry.content.flatMap(part => (part.type === 'text' ? [part.text] : []));

    // The contact's earlier words are fenced (C4).
    expect(texts(users[0]!).join(' ')).toContain(FENCE);
    // The trigger is the last message, the system's own, and unfenced.
    const trigger = texts(users.at(-1)!);
    expect(trigger).toContain(nudgeNotice(since));
    expect(trigger.join(' ')).not.toContain(FENCE);
    expect(nudgeNotice(since)).toBe(
      '[no reply from the contact since 2026-01-15T10:00:00.000Z; decide whether to follow up]',
    );
  });
});

describe('schedule_nudge never reaches ManyChat (specs/025)', () => {
  it('refuses to send schedule_nudge to ManyChat', async () => {
    const client = new ManyChatHttpClient({
      apiToken: 'test-token',
      baseUrl: 'https://api.example.com',
      replyField: 'ai_message',
      replyFlowNs: 'reply_flow',
      tokenField: 'ai_token',
      fetchImpl: () => Promise.resolve(manychatAnswer()),
    });
    await expect(
      client.performAction('1000001', { tool: 'schedule_nudge', id: 'tomorrow', minutes: 1200 }),
    ).rejects.toThrow(/not a ManyChat action/);
  });
});

describe('nudges after different questions follow up differently (specs/025 V7)', () => {
  it('the golden suite holds an instalment and a schedule nudge, answered differently', async () => {
    const { loadCases } = await import('../../evals/cases.ts');
    const { createMockModel } = await import('../../src/agent/mock-provider.ts');
    const cases = loadCases('evals/golden').filter(testCase => testCase.nudge);
    expect(cases.map(testCase => testCase.id).sort()).toEqual([
      'nudge-after-instalments',
      'nudge-after-schedule',
    ]);

    const runner = new GenerateTextRunner({
      model: createMockModel('demo'),
      modelSpec: 'mock:demo',
      config: () => tenant,
      maxOutputTokens: 400,
      temperature: 0,
    });
    const replies = await Promise.all(
      cases.map(testCase =>
        runner.run({ text: '', history: testCase.history, nudge: { since: new Date() } }),
      ),
    );
    expect(replies.every(result => !result.reply.escalate)).toBe(true);
    expect(replies[0]!.reply.messages.join(' ')).not.toBe(replies[1]!.reply.messages.join(' '));
  });

  it('the mock declines a nudge with nothing to pick up', async () => {
    const { createMockModel } = await import('../../src/agent/mock-provider.ts');
    const runner = new GenerateTextRunner({
      model: createMockModel('demo'),
      modelSpec: 'mock:demo',
      config: () => tenant,
      maxOutputTokens: 400,
      temperature: 0,
    });
    const result = await runner.run({
      text: '',
      history: [{ role: 'user', text: 'hello!' }],
      nudge: { since: new Date() },
    });
    expect(result.reply.escalate).toBe(true);
  });
});
