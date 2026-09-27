import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { createTestDatabase } from '../helpers/db.ts';
import type { Database } from '../../src/db/client.ts';
import { TurnHandler } from '../../src/routes/turn.ts';
import { GenerateTextRunner } from '../../src/agent/runner.ts';
import { SdkTranscriber } from '../../src/agent/transcriber.ts';
import { ManyChatAdapter } from '../../src/channels/manychat/adapter.ts';
import { ManyChatMediaFetcher } from '../../src/channels/manychat/media.ts';
import { FfmpegVideoSplitter } from '../../src/media/ffmpeg.ts';
import { MediaResolver } from '../../src/media/resolver.ts';
import { CatalogSchema, RulesSchema, type Rules } from '../../src/contracts/config.ts';
import { FENCE } from '../../src/agent/prompt.ts';
import { OutboxQueue } from '../../src/outbox/queue.ts';
import { BudgetGuard } from '../../src/conversation/budget.ts';
import {
  FakeContactFields,
  fakeManyChatApi,
  fakeMediaHost,
  mediaUrl,
  type FakeMediaFile,
} from '../helpers/manychat.ts';
import { mockModel, mockTranscriptionModel } from '../helpers/model.ts';
import { clip, ffmpegForTests, silentClip } from '../helpers/ffmpeg.ts';
import { buildServer } from '../../src/server.ts';
import { ConfigStore, loadEnv } from '../../src/config/loader.ts';
import type { FfmpegPaths } from '../../src/media/ffmpeg.ts';
import { readFileSync } from 'node:fs';

/**
 * specs/020 — Inbound Media, end to end below the HTTP route: the adapter
 * parses the payload, the resolver downloads from a fake media host (the
 * ManyChat HTTP boundary) and transcribes with a mock model (the model
 * boundary), and the real runner calls a mock answering model.
 */

const ffmpeg = await ffmpegForTests();

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

const FALLBACK = 'Could you type that for me? I cannot open files here.';
const ESCALATION = 'Passing you to a person.';

const rules = RulesSchema.parse({
  messages: { acknowledgement: 'One moment.', escalation: ESCALATION, mediaFallback: FALLBACK },
  escalationKeywords: ['speak to a human'],
  openingTrigger: { keywords: ['start workflow'], message: 'Welcome!' },
  budget: { dailyTokenCap: 100_000, dailyCostCapUsd: 1 },
  rateLimit: { turnsPerSubscriberPerHour: 30 },
});

const catalog = CatalogSchema.parse({
  businessName: 'Demo Academy',
  currency: 'USD',
  courses: [
    {
      id: 'c1',
      name: 'Starter Course',
      description: 'From zero.',
      price: { amount: 31700, currency: 'USD' },
      durationHours: 12,
      schedule: 'Mondays 7pm',
      enrollmentUrl: null,
    },
  ],
});

const ANSWER = {
  messages: ['Happy to help with that.'],
  escalate: false,
  escalation_reason: null,
  confidence: 0.9,
  closing_question: null,
};

const OGG = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);

interface Setup {
  /** What the transcriber hears; null for no TRANSCRIPTION_MODEL. */
  transcriber?: Parameters<typeof mockTranscriptionModel>[0] | null;
  acceptsImages?: boolean;
  ffmpeg?: boolean;
  rules?: Rules;
  raceDeadlineMs?: number;
  files?: Record<string, FakeMediaFile>;
}

function setup(over: Setup = {}) {
  const host = fakeMediaHost();
  host.files.set(mediaUrl('ogg'), { body: OGG, contentType: 'audio/ogg' });
  host.files.set(mediaUrl('jpeg'), { body: JPEG, contentType: 'image/jpeg' });
  host.files.set(mediaUrl('mp4'), { body: clip(), contentType: 'video/mp4' });
  for (const [url, file] of Object.entries(over.files ?? {})) host.files.set(url, file);

  const answering = mockModel(ANSWER);
  const activeRules = over.rules ?? rules;
  const runner = new GenerateTextRunner({
    model: answering.model,
    modelSpec: 'anthropic:claude-haiku-4-5',
    config: () => ({ persona: 'You are the front desk.', catalog, rules: activeRules }),
    maxOutputTokens: 400,
    temperature: 0.3,
  });

  const transcription =
    over.transcriber === null
      ? null
      : mockTranscriptionModel(over.transcriber ?? { text: 'how much is the course?' });
  const media = new MediaResolver({
    fetcher: new ManyChatMediaFetcher(host.fetch),
    transcriber: transcription
      ? new SdkTranscriber({
          model: transcription.model,
          modelSpec: 'openai:gpt-4o-mini-transcribe',
        })
      : null,
    splitter: over.ffmpeg === false ? null : new FfmpegVideoSplitter(),
    acceptsImages: over.acceptsImages ?? true,
  });

  const logger = { info: vi.fn(), error: vi.fn() };
  const handler = new TurnHandler({
    db,
    runner,
    rules: activeRules,
    raceDeadlineMs: over.raceDeadlineMs ?? 10_000,
    modelAbortMs: 20_000,
    logger,
    tokenWriter: contactFields,
    tokensEnforced: true,
    media,
  });

  return { handler, host, answering, transcription, logger };
}

const adapter = new ManyChatAdapter({ sendText: async () => {}, writeToken: async () => {} });

/** What ManyChat POSTs, parsed as the route parses it. */
const inbound = (text: string, subscriberId = 's1') =>
  adapter.parse(
    { subscriber_id: subscriberId, text, ai_token: contactFields.tokenOf(subscriberId) },
    { tenantId: 'demo', channel: 'whatsapp' },
  );

/** The last user message the answering model was sent, split into its parts. */
function lastUserMessage(call: LanguageModelV4CallOptions) {
  const user = call.prompt.filter(message => message.role === 'user').at(-1)!;
  const parts = user.content as { type: string; text?: string; mediaType?: string }[];
  return {
    texts: parts.flatMap(part => (part.type === 'text' ? [part.text!] : [])),
    files: parts.filter(part => part.type === 'file'),
  };
}

const userRows = async () =>
  (await db.query.turns.findMany({ orderBy: (turns, { asc }) => [asc(turns.seq)] })).filter(
    turn => turn.role === 'user',
  );
const agentRows = async () =>
  (await db.query.turns.findMany({ orderBy: (turns, { asc }) => [asc(turns.seq)] })).filter(
    turn => turn.role === 'agent',
  );

describe('specs/020 § A voice note or a video is transcribed, then treated exactly like typed text', () => {
  it('hands the runner the fenced transcript, marked as one, and stores it in place of the URL', async () => {
    const { handler, answering, transcription } = setup();
    const out = await handler.handle(inbound(mediaUrl('ogg')));

    expect(out.outcome).toBe('answered_inline');
    expect(out.reply.messages).toEqual(['Happy to help with that.']);
    // The transcriber heard the downloaded bytes, not the link.
    expect([...(transcription!.calls[0]!.audio as Uint8Array)]).toEqual([...OGG]);

    const { texts, files } = lastUserMessage(answering.calls[0]!);
    expect(files).toEqual([]);
    expect(
      texts.some(text => text.includes(FENCE) && text.includes('how much is the course?')),
    ).toBe(true);
    expect(texts.some(text => text.startsWith('MEDIA:') && text.includes('transcript'))).toBe(true);
    expect(JSON.stringify(answering.calls[0]!.prompt)).not.toContain('manybot-files');

    const [row] = await userRows();
    expect(row).toMatchObject({ text: 'how much is the course?', mediaKind: 'audio' });
  });

  it('matches escalation keywords against the transcript, so a spoken request hands off', async () => {
    const { handler, answering } = setup({
      transcriber: { text: 'I want to speak to a human now' },
    });
    const out = await handler.handle(inbound(mediaUrl('ogg')));

    expect(out.outcome).toBe('escalated_precheck');
    expect(out.reply).toMatchObject({ escalate: true, messages: [ESCALATION] });
    expect(answering.calls).toHaveLength(0);
    expect((await db.query.conversations.findFirst())!.escalatedAt).toBeInstanceOf(Date);
    expect((await userRows())[0]!.text).toBe('I want to speak to a human now');
  });

  it('never matches the opening trigger, which the flow sends and no contact speaks', async () => {
    const { handler, answering } = setup({ transcriber: { text: 'start workflow' } });
    const out = await handler.handle(inbound(mediaUrl('ogg')));
    expect(out.outcome).toBe('answered_inline');
    expect(answering.calls).toHaveLength(1);
  });

  it('puts the transcript in the next turn history, as a typed message would be', async () => {
    const { handler, answering } = setup();
    await handler.handle(inbound(mediaUrl('ogg')));
    await handler.handle(inbound('and on weekends?'));

    const history = JSON.stringify(answering.calls[1]!.prompt);
    expect(history).toContain('how much is the course?');
    expect(history).not.toContain('manybot-files');
  });

  it('records transcription as spend against the daily budget', async () => {
    const { handler } = setup({ transcriber: { text: 'hello there', durationInSeconds: 60 } });
    await handler.handle(inbound(mediaUrl('ogg')));

    // One minute at $0.003, plus the answering model's own call.
    const answeringCost = (1000 * 1 + 50 * 5) / 1_000_000;
    const counter = await db.query.budgetCounters.findFirst();
    expect(Number(counter!.costUsd)).toBeCloseTo(0.003 + answeringCost, 6);
  });
});

describe('specs/020 § An image goes to the model once, as bytes, and history keeps only a marker', () => {
  it('sends the downloaded bytes, never the URL, and records the marker', async () => {
    const { handler, answering, transcription } = setup();
    const out = await handler.handle(inbound(mediaUrl('jpeg')));

    expect(out.outcome).toBe('answered_inline');
    expect(transcription!.calls).toHaveLength(0);
    const { texts, files } = lastUserMessage(answering.calls[0]!);
    expect(files).toHaveLength(1);
    expect(files[0]!.mediaType).toBe('image/jpeg');
    // No contact text came with it, so nothing is fenced.
    expect(texts.some(text => text.includes(FENCE))).toBe(false);
    expect(texts.some(text => text.startsWith('MEDIA:') && text.includes('image'))).toBe(true);
    expect(JSON.stringify(answering.calls[0]!.prompt)).not.toContain('manybot-files');

    const [row] = await userRows();
    expect(row).toMatchObject({ text: '[image]', mediaKind: 'image' });
  });

  it('shows the next turn the marker and not the image', async () => {
    const { handler, answering } = setup();
    await handler.handle(inbound(mediaUrl('jpeg')));
    await handler.handle(inbound('so can I learn that?'));

    const second = answering.calls[1]!;
    const everyPart = second.prompt.flatMap(message =>
      typeof message.content === 'string' ? [] : (message.content as { type: string }[]),
    );
    expect(everyPart.filter(part => part.type === 'file')).toEqual([]);
    expect(JSON.stringify(second.prompt)).toContain('[image]');
  });
});

describe.skipIf(!ffmpeg)('specs/020 § A video is read as still frames and a transcript', () => {
  it('sends frames and transcript when the model takes images and transcription is set', async () => {
    const { handler, answering, transcription } = setup({
      transcriber: { text: 'can I learn this design?' },
    });
    const out = await handler.handle(inbound(mediaUrl('mp4')));

    expect(out.outcome).toBe('answered_inline');
    // The soundtrack, as Ogg, not the video file itself.
    expect(
      Buffer.from((transcription!.calls[0]!.audio as Uint8Array).subarray(0, 4)).toString(),
    ).toBe('OggS');
    const { texts, files } = lastUserMessage(answering.calls[0]!);
    expect(files.length).toBeGreaterThan(0);
    expect(files.length).toBeLessThanOrEqual(4);
    expect(files.every(file => file.mediaType === 'image/jpeg')).toBe(true);
    const notice = texts.find(text => text.startsWith('MEDIA:'))!;
    expect(notice).toContain(`${files.length} still frames`);
    expect(notice).toContain('transcript of its soundtrack');
    expect(
      texts.some(text => text.includes(FENCE) && text.includes('can I learn this design?')),
    ).toBe(true);
    expect((await userRows())[0]).toMatchObject({
      text: 'can I learn this design?',
      mediaKind: 'video',
    });
  });

  it('sends frames only, and says so, without TRANSCRIPTION_MODEL', async () => {
    const { handler, answering } = setup({ transcriber: null });
    await handler.handle(inbound(mediaUrl('mp4')));

    const { texts, files } = lastUserMessage(answering.calls[0]!);
    expect(files).toHaveLength(4);
    expect(texts.find(text => text.startsWith('MEDIA:'))).toContain('You did not hear it');
    expect(texts.some(text => text.includes(FENCE))).toBe(false);
    expect((await userRows())[0]).toMatchObject({ text: '[video]', mediaKind: 'video' });
  });

  it('sends the transcript only, and says so, when the model takes no images', async () => {
    const { handler, answering } = setup({ acceptsImages: false });
    await handler.handle(inbound(mediaUrl('mp4')));

    const { texts, files } = lastUserMessage(answering.calls[0]!);
    expect(files).toEqual([]);
    expect(texts.find(text => text.startsWith('MEDIA:'))).toContain('You did not see it');
    expect((await userRows())[0]).toMatchObject({
      text: 'how much is the course?',
      mediaKind: 'video',
    });
  });

  it('takes the fallback, without downloading, when it can have neither', async () => {
    const { handler, host, answering } = setup({ acceptsImages: false, transcriber: null });
    const out = await handler.handle(inbound(mediaUrl('mp4')));

    expect(out.outcome).toBe('media_fallback');
    expect(host.requested).toEqual([]);
    expect(answering.calls).toHaveLength(0);
    expect((await userRows())[0]).toMatchObject({ text: '[video]', mediaKind: 'video' });
  });

  it('still reaches the model as frames when the clip has no audio track', async () => {
    const { handler, answering, transcription } = setup({
      files: { [mediaUrl('mp4')]: { body: silentClip(), contentType: 'video/mp4' } },
    });
    const out = await handler.handle(inbound(mediaUrl('mp4')));

    expect(out.outcome).toBe('answered_inline');
    expect(transcription!.calls).toHaveLength(0);
    expect(lastUserMessage(answering.calls[0]!).files).toHaveLength(4);
    expect((await userRows())[0]).toMatchObject({ text: '[video]', mediaKind: 'video' });
  });

  it('takes the fallback for a silent clip when the model takes no images', async () => {
    const { handler } = setup({
      acceptsImages: false,
      files: { [mediaUrl('mp4')]: { body: silentClip(), contentType: 'video/mp4' } },
    });
    expect((await handler.handle(inbound(mediaUrl('mp4')))).outcome).toBe('media_fallback');
  });
});

describe('specs/020 § Media the agent cannot read gets the tenant\'s "please type it" reply', () => {
  const cases: [string, Setup, string, boolean][] = [
    ['an unrecognised extension', {}, mediaUrl('pdf'), false],
    ['a voice note with no TRANSCRIPTION_MODEL', { transcriber: null }, mediaUrl('ogg'), false],
    ['a voice note with nothing said', { transcriber: { text: '   ' } }, mediaUrl('ogg'), true],
    ['an image the model cannot take', { acceptsImages: false }, mediaUrl('jpeg'), false],
    ['a video on a server without ffmpeg', { ffmpeg: false }, mediaUrl('mp4'), false],
  ];

  it.each(cases)('replies with mediaFallback to %s', async (_label, over, url, fetched) => {
    const { handler, host, answering } = setup(over);
    const out = await handler.handle(inbound(url));

    expect(out.outcome).toBe('media_fallback');
    expect(out.reply).toMatchObject({ messages: [FALLBACK], escalate: false });
    expect(answering.calls).toHaveLength(0);
    expect(host.requested.length > 0).toBe(fetched);
    expect((await agentRows())[0]).toMatchObject({ outcome: 'media_fallback', text: FALLBACK });
    // A marker for its kind, never the URL.
    expect((await userRows())[0]!.text).toMatch(/^\[(voice note|image|video|media)\]$/);
    expect((await db.query.conversations.findFirst())!.escalatedAt).toBeNull();
  });

  it('records an unrecognised file under the [media] marker', async () => {
    const { handler } = setup();
    await handler.handle(inbound(mediaUrl('pdf')));
    expect((await userRows())[0]).toMatchObject({ text: '[media]', mediaKind: 'unsupported' });
  });

  it('hands off instead when the tenant has written no mediaFallback (C6)', async () => {
    const withoutCopy = RulesSchema.parse({
      ...rules,
      messages: { acknowledgement: 'One moment.', escalation: ESCALATION },
    });
    const { handler } = setup({ rules: withoutCopy });
    const out = await handler.handle(inbound(mediaUrl('pdf')));

    expect(out.outcome).toBe('escalated_precheck');
    expect(out.reply).toMatchObject({ escalate: true, messages: [ESCALATION] });
    expect((await db.query.conversations.findFirst())!.escalatedAt).toBeInstanceOf(Date);
  });
});

describe("specs/020 § A failure we caused hands off; a format we don't support asks the contact to type", () => {
  const failures: [string, Setup, string][] = [
    [
      'a 500 from the media host',
      { files: { [mediaUrl('ogg')]: { status: 500 } } },
      mediaUrl('ogg'),
    ],
    [
      'a redirect',
      { files: { [mediaUrl('ogg')]: { status: 302, location: 'https://elsewhere.example.com/' } } },
      mediaUrl('ogg'),
    ],
    [
      'a wrong Content-Type',
      { files: { [mediaUrl('jpeg')]: { body: JPEG, contentType: 'text/html' } } },
      mediaUrl('jpeg'),
    ],
    [
      'an oversized body',
      {
        files: {
          [mediaUrl('jpeg')]: { body: new Uint8Array(6 * 1024 * 1024), contentType: 'image/jpeg' },
        },
      },
      mediaUrl('jpeg'),
    ],
    [
      'a throwing transcriber',
      { transcriber: { error: new Error('provider down') } },
      mediaUrl('ogg'),
    ],
  ];

  it.each(failures)('escalates with outcome error on %s', async (_label, over, url) => {
    const { handler, answering, logger } = setup(over);
    const out = await handler.handle(inbound(url));

    expect(out.outcome).toBe('error');
    expect(out.reply).toMatchObject({ escalate: true, messages: [ESCALATION] });
    expect(answering.calls).toHaveLength(0);
    expect((await agentRows())[0]!.outcome).toBe('error');
    expect((await db.query.conversations.findFirst())!.escalatedAt).toBeInstanceOf(Date);
    // The log names the step that failed, never the URL.
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ reason: expect.any(String) }),
      'media unreadable',
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('manybot-files');
  });

  it.skipIf(!ffmpeg)('escalates with outcome error on a video ffmpeg rejects', async () => {
    const corrupt = Buffer.concat([clip().subarray(0, 64), Buffer.alloc(4096, 0x5a)]);
    const { handler } = setup({
      files: { [mediaUrl('mp4')]: { body: corrupt, contentType: 'video/mp4' } },
    });
    const out = await handler.handle(inbound(mediaUrl('mp4')));
    expect(out.outcome).toBe('error');
    expect(out.reply.escalate).toBe(true);
  });
});

describe('specs/020 § Download and transcription run inside the race', () => {
  it('acknowledges a transcriber slower than the deadline, and the answer lands in the outbox', async () => {
    const { handler } = setup({
      raceDeadlineMs: 200,
      transcriber: { text: 'how much is the course?', delayMs: 600 },
    });
    const out = await handler.handle(inbound(mediaUrl('ogg')));

    expect(out.outcome).toBe('deferred');
    expect(out.reply.messages).toEqual(['One moment.']);

    await vi.waitFor(
      async () => {
        const [queued] = await new OutboxQueue(db).claimBatch(10);
        expect(queued).toMatchObject({ payload: { messages: ['Happy to help with that.'] } });
      },
      { timeout: 5000 },
    );
    expect((await userRows())[0]!.text).toBe('how much is the course?');
    expect((await agentRows())[0]!.outcome).toBe('deferred');
  });

  it('delivers an escalation the late transcript produces through the outbox too', async () => {
    const { handler } = setup({
      raceDeadlineMs: 200,
      transcriber: { text: 'let me speak to a human', delayMs: 600 },
    });
    expect((await handler.handle(inbound(mediaUrl('ogg')))).outcome).toBe('deferred');

    await vi.waitFor(
      async () => {
        const [queued] = await new OutboxQueue(db).claimBatch(10);
        expect(queued).toMatchObject({ payload: { messages: [ESCALATION] } });
      },
      { timeout: 5000 },
    );
    expect((await agentRows())[0]!.outcome).toBe('escalated_precheck');
    expect((await db.query.conversations.findFirst())!.escalatedAt).toBeInstanceOf(Date);
  });

  it('checks the budget before downloading, so a contact over a limit costs nothing', async () => {
    await new BudgetGuard(db).recordSpend('demo', 0, 5);
    const { handler, host } = setup();
    const out = await handler.handle(inbound(mediaUrl('ogg')));

    expect(out.outcome).toBe('escalated_precheck');
    expect(host.requested).toEqual([]);
    expect((await userRows())[0]).toMatchObject({ text: '[voice note]', mediaKind: 'audio' });
  });
});

describe('specs/020 § The URL never reaches storage or logs', () => {
  it('leaves no row holding the URL, whatever the turn did', async () => {
    const { handler } = setup({ raceDeadlineMs: 200, transcriber: { text: 'hi', delayMs: 400 } });
    for (const url of [mediaUrl('ogg'), mediaUrl('jpeg'), mediaUrl('pdf')]) {
      await handler.handle(inbound(url));
    }
    await vi.waitFor(async () => expect(await new OutboxQueue(db).claimBatch(10)).toHaveLength(1), {
      timeout: 5000,
    });

    const everything = JSON.stringify([
      await db.query.turns.findMany(),
      await db.query.conversations.findMany(),
      await db.query.outbox.findMany(),
    ]);
    expect(everything).not.toContain('manybot-files');
    expect(everything).not.toContain('0123456789abcdef');
  });
});

describe('specs/020 § The URL never reaches storage or logs, through the route', () => {
  const SECRET = 'a'.repeat(32);

  async function makeApp(logs: string[], api = fakeManyChatApi(), ffmpegPaths?: FfmpegPaths) {
    const answering = mockModel(ANSWER);
    const { app } = await buildServer({
      env: loadEnv({
        AGENT_MODEL: 'anthropic:claude-haiku-4-5',
        TRANSCRIPTION_MODEL: 'openai:gpt-4o-mini-transcribe',
        PUBLIC_BASE_URL: 'https://agent.example.com',
        MANYCHAT_SHARED_SECRET: SECRET,
        MANYCHAT_API_TOKEN: 'tok',
        DATABASE_URL: 'postgres://unused',
        LOG_LEVEL: 'trace',
      }),
      db,
      configStore: new ConfigStore('test/fixtures/config'),
      runner: new GenerateTextRunner({
        model: answering.model,
        modelSpec: 'anthropic:claude-haiku-4-5',
        config: () => ({ persona: 'P.', catalog, rules }),
        maxOutputTokens: 400,
        temperature: 0.3,
      }),
      manychatFetch: api.fetch,
      transcriptionModel: mockTranscriptionModel({ text: 'how much is the course?' }).model,
      ...(ffmpegPaths ? { ffmpegPaths } : {}),
      logStream: { write: (line: string) => void logs.push(line) },
    });
    await app.ready();
    return app;
  }

  const post = (app: Awaited<ReturnType<typeof makeApp>>, text: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/channels/manychat/message',
      headers: { authorization: `Bearer ${SECRET}` },
      payload: { subscriber_id: '42', text },
    });

  it('logs no line holding the URL, on an answer, a failure or an unrecognised shape', async () => {
    const logs: string[] = [];
    const api = fakeManyChatApi();
    api.media.files.set(mediaUrl('ogg'), { body: OGG, contentType: 'audio/ogg' });
    api.media.files.set(mediaUrl('jpeg'), { status: 500 });
    const app = await makeApp(logs, api);

    const answered = await post(app, mediaUrl('ogg'));
    expect(answered.statusCode).toBe(200);
    expect(answered.json().content.messages[0].text).toBe('Happy to help with that.');

    const failed = await post(app, mediaUrl('jpeg'));
    expect(failed.json().content.messages[0].text).toBe(
      (JSON.parse(readFileSync('test/fixtures/config/rules.json', 'utf8')) as Rules).messages
        .escalation,
    );

    const changed = mediaUrl('ogg').replace('/wa/', '/whatsapp/');
    await post(app, changed);
    await app.close();

    expect(logs.some(line => line.includes('media_url_unmatched'))).toBe(true);
    expect(logs.some(line => line.includes('media unreadable'))).toBe(true);
    for (const line of logs) {
      expect(line).not.toContain('manybot-files');
      expect(line).not.toContain('0123456789abcdef');
      expect(line).not.toContain('100000000000001');
    }
    // The unrecognised shape is stored as the text it is treated as; the two
    // recognised ones are not.
    const texts = (await userRows()).map(row => row.text);
    expect(texts.slice(0, 2)).toEqual(['how much is the course?', '[image]']);
  });

  it('logs once at boot what it can read, including a missing ffmpeg', async () => {
    const logs: string[] = [];
    const app = await makeApp(logs, fakeManyChatApi(), {
      ffmpeg: '/nonexistent/ffmpeg',
      ffprobe: '/nonexistent/ffprobe',
    });
    await app.close();

    const boot = logs.filter(line => line.includes('media capabilities'));
    expect(boot).toHaveLength(1);
    expect(JSON.parse(boot[0]!)).toMatchObject({
      transcription: 'openai:gpt-4o-mini-transcribe',
      images: true,
      ffmpeg: false,
    });
  });
});
