/**
 * Constitution C5 for `agent worker` (specs/033): the standalone workers log
 * through the same redaction as the server, not through `console`.
 */
import { describe, it, expect } from 'vitest';
import { createLogger } from '../../src/observability/logger.ts';

describe('the worker logger redacts like the server logger (C5, specs/033)', () => {
  const capture = () => {
    const lines: string[] = [];
    return { lines, logger: createLogger('info', { write: (line: string) => lines.push(line) }) };
  };

  it('removes secret fields outright', () => {
    const { lines, logger } = capture();
    logger.info({ client: { apiToken: 'invented-token-value' } }, 'sending');
    expect(lines.join('')).not.toContain('invented-token-value');
  });

  it('scrubs a media URL from a raw error string', () => {
    const { lines, logger } = capture();
    const url = 'https://manybot-files.s3.example-region.amazonaws.com/invented/clip.ogg';
    logger.error({ err: `download failed for ${url}` }, 'outbox delivery failed');
    expect(lines.join('')).not.toContain(url);
    expect(lines.join('')).toContain('[media-url]');
  });

  it('honours the level', () => {
    const lines: string[] = [];
    createLogger('warn', { write: (line: string) => lines.push(line) }).info('quiet');
    expect(lines).toEqual([]);
  });
});
