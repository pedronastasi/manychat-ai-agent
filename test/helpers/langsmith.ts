import { awaitAllCallbacks } from '@langchain/core/callbacks/promises';
import { Client } from 'langsmith';
import { clientConfig, Tracing } from '../../src/observability/tracing.ts';

/** The ID the fake LangSmith gives the project `demo`. */
export const PROJECT_ID = '5b0c8a2e-4f3d-4a6b-9c1e-7d2f3a4b5c6d';

/** A run as the client sent it to `/runs/batch`. */
export interface UploadedRun {
  id: string;
  name: string;
  run_type: string;
  start_time: string;
  end_time?: string;
  parent_run_id?: string;
  trace_id?: string;
  dotted_order?: string;
  session_name: string;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  extra: { metadata: Record<string, unknown> };
  error?: string;
}

/**
 * The LangSmith HTTP boundary, faked (specs/004), behind the real `langsmith`
 * client. Every request the client makes is kept, as the bytes it sent, and
 * answered as `answer` says. `/info` tells the client to upload JSON batches,
 * so runs can be read field by field; `multipart` leaves it on the client's
 * default, multipart ingestion, for tests that only search the bytes.
 */
export function fakeLangSmith(
  answer: (url: string, init?: RequestInit) => Promise<Response> | Response = () =>
    new Response('{}'),
  opts: { multipart?: boolean } = {},
) {
  const requests: { url: string; method: string; body: string }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    // Whatever the client sends, a string, a blob or a stream, as text.
    const body = init?.body ? await new Response(init.body).text() : '';
    requests.push({ url, method: init?.method ?? 'GET', body });
    // The project the outcome feedback names, as LangSmith returns a lookup by name.
    if (new URL(url).pathname === '/sessions') {
      return new Response(JSON.stringify([{ id: PROJECT_ID, name: 'demo' }]));
    }
    if (url.endsWith('/info')) {
      return new Response(
        JSON.stringify(
          opts.multipart ? {} : { batch_ingest_config: { use_multipart_endpoint: false } },
        ),
      );
    }
    return answer(url, init);
  }) as typeof globalThis.fetch;
  const warnings: { fields: object; message: string }[] = [];
  const logger = { warn: (fields: object, message: string) => warnings.push({ fields, message }) };

  const built: Tracing[] = [];
  const tracing = (fullText = false) => {
    const created = new Tracing({
      client: new Client(
        clientConfig({ endpoint: 'https://langsmith.test', apiKey: 'test-key', fullText, fetch }),
      ),
      logger,
      project: 'demo',
      fullText,
    });
    built.push(created);
    return created;
  };

  /** Waits for LangChain's background callbacks, then for what each client queued. */
  const settle = async () => {
    await awaitAllCallbacks();
    await Promise.all(built.map(created => created.flush()));
  };

  /** Every request that is not the client's `/info` probe or a project lookup. */
  const uploads = () =>
    requests.filter(
      request => !request.url.endsWith('/info') && new URL(request.url).pathname !== '/sessions',
    );

  const runs = (): UploadedRun[] =>
    requests
      .filter(request => request.url.endsWith('/runs/batch'))
      .flatMap(request => {
        const body = JSON.parse(request.body) as { post?: UploadedRun[]; patch?: UploadedRun[] };
        return [...(body.post ?? []), ...(body.patch ?? [])];
      });

  const feedback = () =>
    requests
      .filter(request => request.url.endsWith('/feedback'))
      .map(request => JSON.parse(request.body) as Record<string, unknown>);

  /** Every byte sent, for searching for what must not be in it. */
  const bytes = () => requests.map(request => request.body).join('\n');

  return { requests, uploads, warnings, tracing, settle, runs, feedback, bytes };
}
