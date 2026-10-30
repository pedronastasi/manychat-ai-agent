# ADR-0029 — Traces upload through our own uploader, not the LangSmith client

**Status:** accepted · **Date:** 2026-10-30

## Context

`052` lets a turn's trace reach the tenant's LangSmith workspace as a projection
the service writes (ADR-0028). Something has to carry the projected runs. The
reflexive choice is the official `langsmith` client, already installed beside
`@langchain/core`: its `hideInputs`, `hideOutputs` and `anonymizer` hooks take
a projection, it batches in the background, and it bounds its queue. Its case
is real: it is maintained by the vendor, it follows their API as it changes,
and it is what `052`'s table was first written against.

Read on 2026-10-30 from `langsmith` 0.11.0, three of its behaviours break
`052`. It reports an upload failure with `console.error` and `console.warn`,
past the redacting logger. With `LANGSMITH_FAILED_TRACES_DIR` set it writes a
failed batch to disk for later replay, where `052` drops a failed upload and
never retries it. And its first upload asks the server's `/info` which
endpoint to use, a request and a code path no test here controls. Each could be
patched around, but every patch is a rule about the library that the next
version can quietly undo.

## Decision

A class of ours, `TraceUploader`, posts projected runs to LangSmith's
`/runs/batch` and outcome feedback to `/feedback` with `fetch`, from a queue of
at most 1,000 entries, in the background.

## Consequences

- Every byte that leaves is built in `src/observability/tracing.ts`, and every
  failure goes through the redacting logger, once, by status or class. Nothing
  is written to disk and nothing is retried.
- No new dependency: the tracer builds on `@langchain/core`'s `BaseTracer`,
  which the runner already depends on.
- The HTTP boundary is one injected `fetch`, so the tests fake LangSmith there
  and read the exact bytes sent (`052 § Verification`).
- Cost: `/runs/batch` is the path the library's own source calls deprecated in
  favour of multipart ingestion. If LangSmith retires it, uploads fail. They
  fail as logged, dropped uploads, never as failed turns, but traces stop until
  the uploader changes.
- Cost: whatever the vendor improves in its client, retries, compression and
  new endpoints among them, is not inherited and has to be written here if
  wanted.
- Revisit if LangSmith retires `/runs/batch`, or if the official client gains a
  way to report failures through a caller's logger and to turn off its disk
  fallback in code, at which point its maintenance is worth more than this
  class.
