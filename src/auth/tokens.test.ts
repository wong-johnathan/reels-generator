import { describe, expect, it } from 'vitest';

import {
  constantTimeEqual,
  deriveCsrfToken,
  hashSessionToken,
  newSessionToken,
  SESSION_TOKEN_BYTES,
} from './tokens.js';

describe('session and CSRF tokens (R-015-2)', () => {
  it('mints a 32-byte base64url session token', () => {
    const token = newSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(SESSION_TOKEN_BYTES);
  });

  it('mints a fresh token every time', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => newSessionToken()));
    expect(tokens.size).toBe(500);
  });

  it('hashes a token to the sha256 hex that the session row stores', () => {
    const token = newSessionToken();
    const hash = hashSessionToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken(token)).toBe(hash);
    expect(hash).not.toContain(token);
  });

  it('derives a per-session, per-secret CSRF token', () => {
    const a = deriveCsrfToken('a'.repeat(32), hashSessionToken('token-a'));
    const b = deriveCsrfToken('a'.repeat(32), hashSessionToken('token-b'));
    const elsewhere = deriveCsrfToken('b'.repeat(32), hashSessionToken('token-a'));
    expect(a).not.toBe(b);
    expect(a).not.toBe(elsewhere);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).toBe(deriveCsrfToken('a'.repeat(32), hashSessionToken('token-a')));
  });

  it('compares in constant time and never throws on unequal lengths', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });
});
