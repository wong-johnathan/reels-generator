import { describe, expect, it } from 'vitest';

import {
  MemorySessionStore,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  createSessionToken,
  readSessionToken,
  serializeClearedSessionCookie,
  serializeSessionCookie,
} from '../../src/web/auth/session.js';

/**
 * S-01 session mechanics (R-015-2; TECH_DESIGN §5 session table).
 *
 * The store is an interface so B-13 can supply the Postgres-backed one; this
 * card owns the cookie contract and a deterministic in-memory store for the
 * preview and the tests. No test touches the network or the database.
 */

describe('session token', () => {
  it('is 32 random bytes in base64url — 43 characters, no padding', () => {
    const token = createSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token).not.toContain('=');
  });

  it('never repeats', () => {
    const tokens = new Set(Array.from({ length: 64 }, () => createSessionToken()));
    expect(tokens.size).toBe(64);
  });
});

describe('session cookie (R-015-2)', () => {
  it('serialises httpOnly, SameSite=Lax on the whole site, with no Secure flag on LAN HTTP', () => {
    expect(serializeSessionCookie('abc')).toBe(
      SESSION_COOKIE + '=abc; Path=/; HttpOnly; SameSite=Lax',
    );
  });

  it('clears with Max-Age=0 and the same attributes', () => {
    expect(serializeClearedSessionCookie()).toBe(
      SESSION_COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    );
  });
});

describe('readSessionToken', () => {
  it('reads the token from a cookie header with other cookies around it', () => {
    expect(readSessionToken('theme=dark; session=abc123; other=1')).toBe('abc123');
  });

  it('tolerates missing headers and empty values', () => {
    expect(readSessionToken(undefined)).toBeNull();
    expect(readSessionToken('')).toBeNull();
    expect(readSessionToken('session=')).toBeNull();
    expect(readSessionToken('theme=dark')).toBeNull();
  });

  it('does not match a cookie whose name merely ends in "session"', () => {
    expect(readSessionToken('xsession=abc')).toBeNull();
    expect(readSessionToken('session_extra=abc')).toBeNull();
  });

  it('rejects an oversized value instead of trusting it', () => {
    expect(readSessionToken('session=' + 'a'.repeat(513))).toBeNull();
  });
});

describe('MemorySessionStore', () => {
  it('creates a session that reads back for the same operator', () => {
    const store = new MemorySessionStore();
    const { token, record } = store.create('operator', 1_000);
    expect(record.operator).toBe('operator');
    expect(record.expiresAt).toBe(1_000 + SESSION_TTL_MS);
    expect(store.read(token, 1_001)?.operator).toBe('operator');
  });

  it('expires exactly at expires_at, and forgets the row', () => {
    const store = new MemorySessionStore();
    const { token, record } = store.create('operator', 0);
    expect(store.read(token, record.expiresAt - 1)).not.toBeNull();
    expect(store.read(token, record.expiresAt)).toBeNull();
    expect(store.read(token, 0)).toBeNull();
  });

  it('honours an injected ttl', () => {
    const store = new MemorySessionStore(60_000);
    const { record } = store.create('operator', 5_000);
    expect(record.expiresAt).toBe(65_000);
  });

  it('destroy removes only that session and is idempotent', () => {
    const store = new MemorySessionStore();
    const first = store.create('operator', 0);
    const second = store.create('operator', 0);
    store.destroy(first.token);
    store.destroy(first.token);
    expect(store.read(first.token, 0)).toBeNull();
    expect(store.read(second.token, 0)).not.toBeNull();
  });

  it('keeps sessions isolated between store instances', () => {
    const first = new MemorySessionStore();
    const second = new MemorySessionStore();
    const { token } = first.create('operator', 0);
    expect(second.read(token, 0)).toBeNull();
  });

  it('defaults to a twelve-hour absolute lifetime', () => {
    expect(SESSION_TTL_MS).toBe(12 * 60 * 60 * 1000);
  });
});
