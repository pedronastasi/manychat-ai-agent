import { awaitAllCallbacks } from '@langchain/core/callbacks/promises';
import { TraceUploader, Tracing } from '../../src/observability/tracing.ts';
import type { ProjectedRun } from '../../src/observability/tracing.ts';

/**
 * The LangSmith HTTP boundary, faked (specs/004): every request the uploader
 * makes is kept, as the bytes it sent, and answered as `answer` says. Nothing
 * here stands in for the projection, which runs for real.
 */
export function fakeLangSmith(
  answer: (url: string, init?: RequestInit) => Promise<Response> | Response = () =>
    new Response('{}'),
) {
  const requests: { url: string; body: string; headers: Record<string, string> }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(url),
      body: typeof init?.body === 'string' ? init.body : '',
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return answer(String(url), init);
  }) as typeof globalThis.fetch;
  const warnings: { fields: object; message: string }[] = [];
  const logger = { warn: (fields: object, message: string) => warnings.push({ fields, message }) };
  const uploader = new TraceUploader({
    endpoint: 'https://langsmith.test',
    apiKey: 'test-key',
    logger,
    fetch,
    flushDelayMs: 1,
  });
  const tracing = (fullText = false) => new Tracing({ uploader, project: 'demo', fullText });

  /** Waits for LangChain's background callbacks, then for the uploads they queued. */
  const settle = async () => {
    await awaitAllCallbacks();
    await uploader.flush();
  };

  const runs = (): ProjectedRun[] =>
    requests
      .filter(request => request.url.endsWith('/runs/batch'))
      .flatMap(request => (JSON.parse(request.body) as { post: ProjectedRun[] }).post);

  const feedback = () =>
    requests
      .filter(request => request.url.endsWith('/feedback'))
      .map(request => JSON.parse(request.body) as Record<string, unknown>);

  /** Every byte sent, for searching for what must not be in it. */
  const bytes = () => requests.map(request => request.body).join('\n');

  return { requests, warnings, uploader, tracing, settle, runs, feedback, bytes };
}
