import { describe, it, expect } from 'vitest';
import { redactText, REDACT_PATHS } from '../../src/observability/redact.ts';

/** Constitution C5 — no PII in logs. */

describe('redactText', () => {
  it('removes email addresses', () => {
    expect(redactText('email me at ana.diaz+courses@example.com')).toBe('email me at [email]');
  });

  it('removes phone numbers in common local formats', () => {
    for (const phone of ['+54 9 11 2345-6789', '011 4567 8901', '(11) 2345 6789']) {
      expect(redactText(`llamame al ${phone}`)).not.toContain('2345');
    }
  });

  it('removes long digit runs such as document numbers', () => {
    expect(redactText('my ID number is 30123456')).toBe('my ID number is [number]');
  });

  it('leaves ordinary text and short numbers intact', () => {
    // Over-redaction makes logs useless; prices and counts must survive.
    expect(redactText('the course runs 24 hours over 4 weeks')).toBe(
      'the course runs 24 hours over 4 weeks',
    );
  });

  it('handles several kinds of PII in one message', () => {
    const out = redactText('i am ana, ana@x.com, tel +5491123456789');
    expect(out).toContain('[email]');
    expect(out).not.toContain('ana@x.com');
    expect(out).not.toContain('5491123456789');
  });

  it('is a no-op on empty input', () => {
    expect(redactText('')).toBe('');
  });
});

describe('REDACT_PATHS', () => {
  it('covers credentials, message text and contact names', () => {
    for (const path of [
      'req.headers.authorization',
      'req.body.text',
      'req.body.first_name',
      'env.ANTHROPIC_API_KEY',
      'env.MANYCHAT_SHARED_SECRET',
      'env.DATABASE_URL',
    ]) {
      expect(REDACT_PATHS).toContain(path);
    }
  });
});
