import { describe, it, expect } from 'vitest';
import { awaitAllCallbacks } from '@langchain/core/callbacks/promises';
import { clientConfig, TRACE_QUEUE_BYTES } from '../../src/observability/tracing.ts';
import { fakeLangSmith } from '../helpers/langsmith.ts';

/**
 * specs/052-traces-carry-shape-not-text.md § The uploader never holds a turn,
 * and the table of § Setting LangChain's tracing variable …: the official
 * client as the service configures it (ADR-0029), and the shutdown deadline.
 * Every value here is invented (C1).
 */

const live = clientConfig({
  endpoint: 'https://langsmith.test',
  apiKey: 'test-key',
  fullText: false,
});

describe('the client is configured in code (specs/052)', () => {
  it('sets what the table requires, whatever the environment says', () => {
    expect(live).toMatchObject({
      apiUrl: 'https://langsmith.test',
      autoBatchTracing: true,
      blockOnRootRunFinalization: false,
      omitTracedRuntimeInfo: true,
      maxIngestMemoryBytes: TRACE_QUEUE_BYTES,
      tracingMode: 'langsmith',
      debug: false,
      tracingSamplingRate: 1,
    });
  });

  it('hides nothing for an eval on the fixture tenant', () => {
    const full = clientConfig({ endpoint: 'https://langsmith.test', apiKey: 'k', fullText: true });
    expect(full).toMatchObject({ hideInputs: false, hideOutputs: false, hideMetadata: false });
    expect(full.anonymizer).toBeUndefined();
  });
});

describe("the client's hide functions are a second allowlist (specs/052)", () => {
  const hide = <T>(value: unknown): T => value as T;
  const hideInputs = hide<(inputs: object) => object>(live.hideInputs);
  const hideOutputs = hide<(outputs: object) => object>(live.hideOutputs);
  const hideMetadata = hide<(metadata: object) => object>(live.hideMetadata);
  const anonymizer = hide<(values: object) => object>(live.anonymizer);

  it('sends no input at all', () => {
    expect(hideInputs({ messages: ['a message the contact wrote'] })).toEqual({});
  });

  it('keeps token counts and tool names, and drops everything else', () => {
    expect(
      hideOutputs({
        usage_metadata: { input_tokens: 10, output_tokens: 2, total_tokens: 12, note: 'text' },
        tools: ['write_note', { name: 'not a string' }],
        generations: [[{ text: 'a reply the contact would read' }]],
      }),
    ).toEqual({
      usage_metadata: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      tools: ['write_note'],
    });
  });

  it('keeps only allowlisted metadata', () => {
    expect(
      hideMetadata({ conversation: 'c-1', langgraph_node: 'model', subscriber: 'someone' }),
    ).toEqual({ conversation: 'c-1', langgraph_node: 'model' });
  });

  it('lets a class name through as the error, and nothing that reads as a sentence', () => {
    expect(anonymizer({ error: 'AbortError' })).toEqual({ error: 'AbortError' });
    expect(anonymizer({ error: 'Error: the contact asked about weekends' })).toEqual({
      error: 'Error',
    });
  });
});

describe('shutdown never waits past its deadline (specs/052)', () => {
  it('stops waiting on a hung endpoint and says so', async () => {
    // Never answers, and honours the request's signal as a real connection does.
    const langsmith = fakeLangSmith(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const tracing = langsmith.tracing();
    const trace = tracing.turn({ conversation: 'c-1', kind: 'inbound' });
    await trace.open([]);
    await trace.close();
    trace.outcome('answered_inline');
    await awaitAllCallbacks();

    const started = Date.now();
    await tracing.close(100);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(langsmith.warnings.map(warning => warning.message)).toContain(
      'trace send cut short at shutdown',
    );
  });
});
