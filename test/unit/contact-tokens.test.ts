import { describe, it, expect } from 'vitest';
import { bindingFor, generateToken, hashToken } from '../../src/conversation/tokens.ts';

/** specs/019 § Each contact's token lives in ManyChat, never in a response. */

describe("specs/019 § Each contact's token lives in ManyChat, never in a response", () => {
  it('generates 32 random bytes as base64url', () => {
    const token = generateToken();
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateToken()).not.toBe(token);
  });

  it('stores a SHA-256 hash, never the token', () => {
    const token = generateToken();
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).not.toContain(token);
  });
});

describe("specs/019 § A request without the contact's current token reads no history", () => {
  const current = generateToken();
  const previous = generateToken();
  const state = { tokenHash: hashToken(current), previousTokenHash: hashToken(previous) };

  it('binds the current token and the previous one', () => {
    expect(bindingFor(state, current)).toBe('bound');
    expect(bindingFor(state, previous)).toBe('bound');
  });

  it('leaves a missing, empty or wrong token unbound', () => {
    expect(bindingFor(state, null)).toBe('unbound');
    expect(bindingFor(state, '')).toBe('unbound');
    expect(bindingFor(state, generateToken())).toBe('unbound');
    // The hash itself is not the token.
    expect(bindingFor(state, state.tokenHash)).toBe('unbound');
  });

  it('treats a contact with no token issued as their first request', () => {
    expect(bindingFor(undefined, current)).toBe('first');
    expect(bindingFor({ tokenHash: null, previousTokenHash: null }, null)).toBe('first');
  });

  it('binds nothing to a previous token that was never issued', () => {
    expect(bindingFor({ ...state, previousTokenHash: null }, previous)).toBe('unbound');
  });
});
