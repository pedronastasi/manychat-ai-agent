import { describe, it, expect } from 'vitest';
import { TraceUploader } from '../../src/observability/tracing.ts';
import type { ProjectedRun } from '../../src/observability/tracing.ts';

/**
 * specs/052-traces-carry-shape-not-text.md § The uploader never holds a turn:
 * the queue's bound, the order runs and feedback leave in, and the one send
 * on shutdown. The LangSmith boundary is faked (specs/004).
 */

const run = (id: string): ProjectedRun => ({
  id,
  name: 'model',
  run_type: 'chain',
  start_time: new Date(0).toISOString(),
  session_name: 'demo',
  inputs: {},
  outputs: {},
  extra: { metadata: {} },
});

function uploader(limit?: number) {
  const sent: { path: string; body: { post?: ProjectedRun[]; key?: string } }[] = [];
  const warnings: string[] = [];
  const instance = new TraceUploader({
    endpoint: 'https://langsmith.test/',
    apiKey: 'test-key',
    logger: { warn: (_fields, message) => warnings.push(message) },
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({
        path: String(url).replace('https://langsmith.test', ''),
        body: JSON.parse(String(init?.body)) as { post?: ProjectedRun[] },
      });
      return new Response('{}');
    },
    // Long enough that nothing leaves until the test sends it.
    flushDelayMs: 60_000,
    ...(limit !== undefined ? { limit } : {}),
  });
  return { instance, sent, warnings };
}

describe('the uploader never holds a turn (specs/052)', () => {
  it('drops the oldest past its bound, and says so once', async () => {
    const { instance, sent, warnings } = uploader(2);
    for (const id of ['first', 'second', 'third', 'fourth']) instance.run(run(id));
    await instance.flush();
    expect(sent.flatMap(request => request.body.post ?? []).map(entry => entry.id)).toEqual([
      'third',
      'fourth',
    ]);
    expect(warnings).toEqual(['trace queue full; dropping the oldest']);
  });

  it('sends runs and feedback in the order they were queued', async () => {
    const { instance, sent } = uploader();
    instance.run(run('root'));
    instance.feedback('root', 'outcome', 'answered_inline');
    instance.run(run('next-turn'));
    await instance.flush();
    expect(sent.map(request => request.path)).toEqual(['/runs/batch', '/feedback', '/runs/batch']);
  });

  it('sends what is queued once on close, and then nothing on its own', async () => {
    const { instance, sent } = uploader();
    instance.run(run('queued'));
    await instance.close();
    expect(sent).toHaveLength(1);
    instance.run(run('after-close'));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(sent).toHaveLength(1);
  });
});
