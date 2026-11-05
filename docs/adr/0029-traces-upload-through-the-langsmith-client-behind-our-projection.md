# ADR-0029 — Traces upload through the LangSmith client, behind our projection

**Status:** accepted · **Date:** 2026-11-05

## Context

`052` lets a turn's trace reach the tenant's LangSmith workspace as a projection
the service writes (ADR-0028). Something has to carry the projected runs. A
first draft of this ADR chose a small uploader of our own over the official
`langsmith` client, and the draft was built. Reading `langsmith` 0.11.0 had
turned up three behaviours that clash with `052`: it reports an upload failure
with `console.error`, past the redacting logger; with
`LANGSMITH_FAILED_TRACES_DIR` set it writes failed batches to disk for replay;
and its first upload asks the server's `/info` which endpoint to use.

Weighed again before merge, none of the three justified owning an uploader.
The failures it prints carry run IDs and status codes, and the runs it would
print are already projections with no text in them. The disk fallback is one
environment variable, which boot can refuse. The `/info` probe is harmless. The
uploader, meanwhile, posted to `/runs/batch`, which the library itself calls
deprecated, gave up the vendor's retries and multipart ingestion, and needed a
shutdown fix of its own in review.

The client cannot do the projection itself: its hide functions see a run's
inputs or outputs alone, never the run type, the graph node or the tools the
turn offered, and the projection needs all three.

## Decision

Each run is projected by our per-turn tracer and handed to the official
`langsmith` client with `createRun`, configured in code, with its own hide
functions set as a second allowlist.

## Consequences

- The vendor's client does the queueing, batching, multipart ingestion and
  retries, and follows LangSmith's API as it changes. `langsmith` becomes a
  direct dependency, pinned to 0.11.0, the version `052`'s table was read
  against.
- The bytes are cut twice: once by the projection, with the turn's context,
  and again by the client's hide functions and anonymizer, so a bug in either
  alone does not leak text.
- Every switch that could change what is sent or where is set in code:
  tracing mode, debug, sampling rate, runtime metadata, the queue's bytes.
  The two the client reads only from the environment,
  `LANGSMITH_FAILED_TRACES_DIR` and `LANGSMITH_RUNS_ENDPOINTS`, stop boot while
  tracing is on.
- Cost: a failed batch is reported by the client on stderr, with the status
  and the server's response body, outside the redacting logger. What it could
  print is projected already, so no contact or tenant text is in it; the C5
  exception is that line's format, not its content.
- Cost: a failed batch is retried in the background, up to 4 times by the
  client's own policy, rather than dropped at once. Retries never touch a
  turn, and on shutdown the 5 s deadline cuts them short.
- Cost: a new client version can add a field, an endpoint or an environment
  variable. The second allowlist drops a new field; reading each release's
  changelog is the check for the rest.
- Revisit if the client gains an environment-only switch that sends runs
  elsewhere, or if its own hide functions ever receive the run's context, at
  which point the projection could move into them.
