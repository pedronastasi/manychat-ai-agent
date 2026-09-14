import { describe, it, expect } from 'vitest';
import { redactText, pseudonymize, REDACT_PATHS } from '../../src/observability/redact.ts';

/** Constitution C5 — no PII in logs. */

describe('redactText', () => {
  it('removes email addresses', () => {
    expect(redactText('escribime a ana.diaz+cursos@example.com')).toBe('escribime a [email]');
  });

  it('removes phone numbers in common local formats', () => {
    for (const phone of ['+54 9 11 2345-6789', '011 4567 8901', '(11) 2345 6789']) {
      expect(redactText(`llamame al ${phone}`)).not.toContain('2345');
    }
  });

  it('removes long digit runs such as document numbers', () => {
    expect(redactText('mi DNI es 30123456')).toBe('mi DNI es [number]');
  });

  it('leaves ordinary text and short numbers intact', () => {
    // Over-redaction makes logs useless; prices and counts must survive.
    expect(redactText('el curso dura 24 horas y son 4 semanas')).toBe(
      'el curso dura 24 horas y son 4 semanas',
    );
  });

  it('handles several kinds of PII in one message', () => {
    const out = redactText('soy ana, ana@x.com, tel +5491123456789');
    expect(out).toContain('[email]');
    expect(out).not.toContain('ana@x.com');
    expect(out).not.toContain('5491123456789');
  });

  it('is a no-op on empty input', () => {
    expect(redactText('')).toBe('');
  });
});

describe('pseudonymize', () => {
  it('is stable for the same subscriber, so a conversation can be correlated', () => {
    expect(pseudonymize('sub-1', 'demo')).toBe(pseudonymize('sub-1', 'demo'));
  });

  it('differs across subscribers', () => {
    expect(pseudonymize('sub-1', 'demo')).not.toBe(pseudonymize('sub-2', 'demo'));
  });

  it('differs across tenants for the same subscriber id', () => {
    // Subscriber ids are only unique within a page, so the tenant must salt it.
    expect(pseudonymize('sub-1', 'tenant-a')).not.toBe(pseudonymize('sub-1', 'tenant-b'));
  });

  it('never returns the original identifier', () => {
    const id = '998877';
    expect(pseudonymize(id, 'demo')).not.toContain(id);
  });

  it('produces a short fixed-width token', () => {
    expect(pseudonymize('x', 'demo')).toMatch(/^[a-z0-9]{7}$/);
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
