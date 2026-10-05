import { pino } from 'pino';
import { REDACT_PATHS, mediaScrubbingStream } from './redact.ts';

/** The redaction every process logger carries, server or worker (Constitution C5). */
export function loggerOptions(level: string) {
  return { level, redact: { paths: REDACT_PATHS, remove: true } };
}

/** A logger for processes without Fastify, redacted the same way the server's is. */
export function createLogger(
  level: string,
  destination: { write(line: string): unknown } = process.stdout,
) {
  return pino(loggerOptions(level), mediaScrubbingStream(destination));
}
