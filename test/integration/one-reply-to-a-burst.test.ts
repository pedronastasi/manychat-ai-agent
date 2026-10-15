import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { asc } from 'drizzle-orm';
import { createTestDatabase } from '../helpers/db.ts';
import type { Database } from '../../src/db/client.ts';
import { turns } from '../../src/db/schema.ts';
import { TurnHandler } from '../../src/routes/turn.ts';
import type { TurnResult } from '../../src/routes/turn.ts';
import { TurnLanes } from '../../src/conversation/turns.ts';
import type { AgentRunner, AgentResult, AgentTurnInput } from '../../src/agent/runner.ts';
import { ActionStage, buildTools } from '../../src/agent/tools.ts';
import { RulesSchema } from '../../src/contracts/config.ts';
import type { Tools } from '../../src/contracts/config.ts';
import type { InboundMessage } from '../../src/contracts/agent.ts';
import { loadTenantConfig } from '../../src/config/loader.ts';
import { FakeContactFields, fakeMediaHost, mediaUrl } from '../helpers/manychat.ts';
import { MediaResolver } from '../../src/media/resolver.ts';
import { ManyChatMediaFetcher } from '../../src/channels/manychat/media.ts';
import { asProspect } from '../helpers/intent.ts';

/**
 * specs/045-one-reply-to-a-burst-of-bubbles.md § Verification items 2 to 5.
 * The model is the only fake besides ManyChat: each call records the history
 * it was given and answers after a delay the test chooses. Every message is
 * invented.
 */

let db: Database;
let close: () => Promise<void>;
let contactFields: FakeContactFields;
beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
  contactFields = new FakeContactFields();
});
afterEach(async () => {
  await close();
});

const baseRules = {
  messages: { acknowledgement: 'One moment.', escalation: 'Passing you to a person.' },
  budget: { dailyTokenCap: 100_000, dailyCostCapUsd: 5 },
  rateLimit: { turnsPerSubscriberPerHour: 60 },
  escalationKeywords: ['refund'],
  openingTrigger: { keywords: ['start workflow'], message: 'Hi! How can I help?' },
};

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const result = (text: string, toolsOffered = false): AgentResult => ({
  reply: {
    messages: [text],
    escalate: false,
    escalation_reason: null,
    confidence: 0.9,
    closing_question: null,
  },
  model: 'mock:demo',
  usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, costUsd: 0.001 },
  interventions: [],
  latencyMs: 5,
  toolsOffered,
});

/** Answers "reply to <text>" after `delayMs(text)`, keeping the history each call saw. */
function recordingRunner(delayMs: (text: string) => number) {
  const seen: { text: string; history: string[] }[] = [];
  const runner: AgentRunner = {
    run: async ({ text, history }: AgentTurnInput) => {
      seen.push({ text, history: history.map(turn => `${turn.role}: ${turn.text}`) });
      await sleep(delayMs(text));
      return result(`reply to ${text}`);
    },
  };
  return { runner, seen };
}

const inbound = (text: string): InboundMessage => ({
  tenantId: 'demo',
  subscriberId: 's1',
  text,
  channel: 'whatsapp',
  contactName: null,
  locale: null,
  contactToken: null,
  receivedAt: new Date(),
});

function handler(
  runner: AgentRunner,
  lanes: TurnLanes,
  opts: {
    raceDeadlineMs?: number;
    foldBursts?: boolean;
    tools?: Tools;
    tokensEnforced?: boolean;
    media?: MediaResolver;
  } = {},
) {
  return new TurnHandler({
    db,
    runner,
    rules: RulesSchema.parse({ ...baseRules, foldBursts: opts.foldBursts ?? false }),
    tools: opts.tools,
    logger,
    raceDeadlineMs: opts.raceDeadlineMs ?? 2_000,
    modelAbortMs: 10_000,
    tokenWriter: contactFields,
    tokensEnforced: opts.tokensEnforced ?? false,
    actions: { performAction: () => Promise.resolve() },
    lanes,
    media: opts.media,
  });
}

const recorded = async () =>
  (await db.select().from(turns).orderBy(asc(turns.seq))).map(turn => ({
    line: `${turn.role}: ${turn.text}`,
    outcome: turn.outcome,
  }));

const queuedReplies = async () =>
  (await db.query.outbox.findMany({ orderBy: (row, { asc: up }) => [up(row.createdAt)] }))
    .filter(row => row.kind === 'reply')
    .map(row => (row.payload as { messages: string[] }).messages);

/** Sends `texts` 20 ms apart, the first one's model taking `firstMs`. */
async function burst(
  texts: string[],
  opts: { firstMs?: number; raceDeadlineMs?: number; foldBursts?: boolean } = {},
) {
  const lanes = new TurnLanes(20_000);
  const { runner, seen } = recordingRunner(text => (text === texts[0] ? (opts.firstMs ?? 300) : 0));
  const pending: Promise<TurnResult>[] = [];
  for (const text of texts) {
    pending.push(handler(runner, lanes, opts).handle(inbound(text)));
    await sleep(20);
  }
  return { results: await Promise.all(pending), seen };
}

const sent = (results: TurnResult[]) =>
  results.filter(found => !found.silent).map(found => found.reply.messages);

describe('bubbles that wait behind a running turn (specs/045 V2)', () => {
  it('are folded into the last one, which answers them together', async () => {
    const { results, seen } = await burst(['hi', 'I wanted to ask', 'about the', 'evening course']);

    expect(seen.map(call => call.text)).toEqual(['hi', 'evening course']);
    expect(results.map(found => found.outcome)).toEqual([
      'answered_inline',
      'folded',
      'folded',
      'answered_inline',
    ]);
    expect(sent(results)).toEqual([['reply to hi'], ['reply to evening course']]);
    expect(seen[1]!.history).toEqual([
      'user: hi',
      'agent: reply to hi',
      'user: I wanted to ask',
      'user: about the',
    ]);
  });

  it('leaves a lone second message to run its own turn', async () => {
    const { results, seen } = await burst(['hi', 'how much is it?']);
    expect(seen.map(call => call.text)).toEqual(['hi', 'how much is it?']);
    expect(sent(results)).toEqual([['reply to hi'], ['reply to how much is it?']]);
  });
});

describe('bubbles that are never folded (specs/045 V3)', () => {
  it('a message with an escalation keyword runs its own turn', async () => {
    const { results } = await burst(['hi', 'I want a refund', 'now']);
    expect(results[1]!.outcome).toBe('escalated_precheck');
  });

  it('the opening sentinel runs its own turn, and is not a turn to fold into', async () => {
    const { results } = await burst(['hi', 'tell me more', 'start workflow']);
    expect(results.map(found => found.outcome)).toEqual([
      'answered_inline',
      'answered_inline',
      'answered_scripted',
    ]);
  });

  it('a turn that reads no history is not one to fold into (specs/019)', async () => {
    // A new contact's bubbles all arrive before the first turn issues their
    // token, so every one of them is a `first` turn, which reads no history
    // while tokens are enforced.
    const lanes = new TurnLanes(20_000);
    const { runner, seen } = recordingRunner(text => (text === 'hi' ? 300 : 0));
    const opts = { foldBursts: true, tokensEnforced: true };
    const results = await Promise.all(
      ['hi', 'I wanted to ask', 'about the evening course'].map(text =>
        handler(runner, lanes, opts).handle(inbound(text)),
      ),
    );
    expect(results.map(found => found.outcome)).toEqual([
      'answered_inline',
      'answered_inline',
      'answered_inline',
    ]);
    expect(seen.map(call => call.text)).toEqual([
      'hi',
      'I wanted to ask',
      'about the evening course',
    ]);
  });

  it('a media message runs its own turn', async () => {
    const lanes = new TurnLanes(20_000);
    const { runner } = recordingRunner(text => (text === 'hi' ? 300 : 0));
    const first = handler(runner, lanes).handle(inbound('hi'));
    await sleep(20);
    const voice = handler(runner, lanes).handle({
      ...inbound(''),
      media: { kind: 'audio', url: 'https://media.example.com/clip.ogg' },
    });
    await sleep(20);
    const last = handler(runner, lanes).handle(inbound('thanks'));
    const results = await Promise.all([first, voice, last]);
    expect(results[1].outcome).not.toBe('folded');
  });
});

describe('a reply the contact wrote past, with foldBursts (specs/045 V4)', () => {
  it('is superseded inline, and the last bubble answers everything', async () => {
    const { results, seen } = await burst(['hi', 'I wanted to ask', 'about the evening course'], {
      foldBursts: true,
    });

    expect(results.map(found => found.outcome)).toEqual([
      'superseded',
      'folded',
      'answered_inline',
    ]);
    expect(sent(results)).toEqual([['reply to about the evening course']]);
    expect(seen[1]!.history).toEqual(['user: hi', 'user: I wanted to ask']);

    const rows = await recorded();
    expect(rows.find(row => row.outcome === 'superseded')?.line).toBe('agent: reply to hi');
    const spent = await db.query.turns.findFirst({
      where: (row, { eq }) => eq(row.outcome, 'superseded'),
    });
    expect(spent?.costUsd).not.toBeNull();
  });

  it('is superseded from the outbox, after the holding line', async () => {
    const { results } = await burst(['hi', 'I wanted to ask', 'about the evening course'], {
      foldBursts: true,
      firstMs: 400,
      raceDeadlineMs: 150,
    });
    expect(results[0]!.reply.messages).toEqual(['One moment.']);
    expect(results[0]!.silent).toBeUndefined();
    for (let tries = 0; tries < 150; tries++) {
      if ((await queuedReplies()).length > 0) break;
      await sleep(20);
    }
    await sleep(100);
    expect(await queuedReplies()).toEqual([['reply to about the evening course']]);
    expect((await recorded()).map(row => row.outcome)).toContain('superseded');
  });
});

/**
 * The real resolver over ManyChat's media host, faked at the HTTP boundary
 * (specs/004): an image is read as one image for the model, on its own turn.
 */
function imageReader() {
  const host = fakeMediaHost();
  host.files.set(mediaUrl('jpeg'), {
    body: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]),
    contentType: 'image/jpeg',
  });
  return new MediaResolver({
    fetcher: new ManyChatMediaFetcher(host.fetch),
    transcriber: null,
    splitter: null,
    acceptsImages: true,
  });
}

describe('a media reply the contact wrote past, with foldBursts (specs/045 V4)', () => {
  it('is still sent: the turn behind reads only its marker', async () => {
    const lanes = new TurnLanes(20_000);
    const recording = recordingRunner(text => (text === '' ? 300 : 0));
    const images: number[] = [];
    const runner: AgentRunner = {
      run: input => {
        if (input.media) images.push(input.media.images.length);
        return recording.runner.run(input);
      },
    };
    const opts = { foldBursts: true, media: imageReader() };
    const pending: Promise<TurnResult>[] = [];
    for (const message of [
      { ...inbound(''), media: { kind: 'image' as const, url: mediaUrl('jpeg') } },
      inbound('how much'),
      inbound('is this one?'),
    ]) {
      pending.push(handler(runner, lanes, opts).handle(message));
      await sleep(20);
    }
    const results = await Promise.all(pending);
    expect(images).toEqual([1]);
    expect(results[0]!.outcome).toBe('answered_inline');
    expect(results[0]!.silent).toBeUndefined();
  });
});

const fixture = loadTenantConfig('test/fixtures/config').tools!;
const tools: Tools = {
  ...fixture,
  flows: fixture.flows.map(flow => ({ ...flow, settleSeconds: undefined })),
};

describe('a first reply that is still sent (specs/045 V5)', () => {
  it('without foldBursts', async () => {
    const { results } = await burst(['hi', 'I wanted to ask', 'about the evening course']);
    expect(sent(results)).toEqual([['reply to hi'], ['reply to about the evening course']]);
  });

  it('when it sent a flow', async () => {
    const lanes = new TurnLanes(20_000);
    const flow = 'fitting_it_in';
    const runner: AgentRunner = {
      run: async ({ text, stage = new ActionStage(), contact, flows }) => {
        if (text === 'hi') {
          const built = buildTools(tools, stage, asProspect(contact), undefined, { flows });
          await built?.send_flow?.execute?.({ flow } as never, {
            toolCallId: 'test',
            messages: [],
            context: {},
          });
          await sleep(300);
        }
        return result(`reply to ${text}`, true);
      },
    };
    const opts = { foldBursts: true, tools };
    const pending: Promise<TurnResult>[] = [];
    for (const text of ['hi', 'I wanted to ask', 'about the evening course']) {
      pending.push(handler(runner, lanes, opts).handle(inbound(text)));
      await sleep(20);
    }
    const results = await Promise.all(pending);
    expect(results[0]!.outcome).toBe('answered_inline');
    expect(results[0]!.reply.messages).toEqual(['reply to hi']);
  });
});
