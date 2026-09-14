# ADR-0004 — Postgres outbox instead of a Redis queue

**Status:** accepted · **Date:** 2026-09-14

## Context

The deferred push path needs durable hand-off from the request to a worker.
The reflexive choice is Redis with BullMQ.

## Decision

A Postgres `outbox` table polled with `SELECT ... FOR UPDATE SKIP LOCKED`.

## Consequences

- No second datastore to run, back up, secure, or explain in the README.
- The enqueue shares a transaction with the conversation write, so a message can
  never be recorded as sent without being queued.
- `SKIP LOCKED` gives safe concurrent workers without external coordination.
- Polling adds latency (bounded by the poll interval) and load that a push-based
  queue avoids. At this volume — tens of messages an hour — this is irrelevant.
- If throughput ever reaches thousands of messages per minute, revisit. The
  worker interface is narrow enough to swap the transport behind it.
