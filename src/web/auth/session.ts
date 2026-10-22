/**
 * Session cookie and session store contract (R-015-2, TECH_DESIGN §5).
 *
 * F-02 owns the *web* side of the session: the cookie an httpOnly login sets,
 * how it is read back, and the guard that acts on it. The durable store
 * (Postgres `session` table, argon2id verification) belongs to B-13; the
 * interface below is the seam INT-01 swaps over. `MemorySessionStore` exists
 * for the preview and the tests — it is deterministic, holds nothing on disk
 * and is never constructed by the production entrypoint.
 */
import { randomBytes } from 'node:crypto';

/**
 * The canonical cookie pair, shared with the production auth surface
 * (src/api/server.ts and src/web/middleware/auth.ts). The API's names win:
 * production auth already issues `reels_session` + `reels_csrf`, so the web
 * side must read and write the same names or the two halves of one login can
 * never agree on the session.
 */
export const SESSION_COOKIE = 'reels_session';
export const CSRF_COOKIE = 'reels_csrf';

/**
 * Absolute lifetime, independent of browser session. The cookie itself carries
 * no Max-Age (no "remember me" in the product, UI_SPEC §6.1); closing the
 * browser ends the session, and the server ends it after this window anyway.
 */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** Cookie values longer than this are not ours; refuse them before lookup. */
const MAX_TOKEN_LENGTH = 512;

export interface SessionRecord {
  readonly operator: string;
  readonly expiresAt: number;
}

export interface CreatedSession {
  readonly token: string;
  readonly record: SessionRecord;
}

export interface SessionStore {
  create(operator: string, now?: number): CreatedSession | Promise<CreatedSession>;
  /** Null for unknown, revoked and expired tokens alike. */
  read(token: string, now?: number): SessionRecord | null | Promise<SessionRecord | null>;
  destroy(token: string): void | Promise<void>;
}

/** 32 random bytes, base64url: 43 characters, URL- and header-safe. */
export function createSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * `Secure` is deliberately omitted: the app is LAN-only HTTP (TECH_DESIGN
 * §11). `HttpOnly` keeps the token away from scripts; `SameSite=Lax` stops a
 * cross-site form from riding the session.
 */
export function serializeSessionCookie(token: string): string {
  return SESSION_COOKIE + '=' + token + '; Path=/; HttpOnly; SameSite=Lax';
}

/**
 * The synchroniser token, issued next to the session cookie on sign-in so the
 * page's state-changing forms can double-submit it. Same attributes as the
 * session cookie: httpOnly, SameSite=Lax, whole-site path, no Domain.
 */
export function serializeCsrfCookie(token: string): string {
  return CSRF_COOKIE + '=' + token + '; Path=/; HttpOnly; SameSite=Lax';
}

export function serializeClearedSessionCookie(): string {
  return SESSION_COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}

/** First exact-name match wins; accepts the raw `Cookie` header. */
export function serializeClearedCsrfCookie(): string {
  return CSRF_COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}

export function readSessionToken(cookieHeader: string | undefined): string | null {
  if (cookieHeader === undefined || cookieHeader.length === 0) return null;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    if (name !== SESSION_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    if (value.length === 0 || value.length > MAX_TOKEN_LENGTH) return null;
    return value;
  }
  return null;
}

export class MemorySessionStore implements SessionStore {
  private readonly ttlMs: number;
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(ttlMs: number = SESSION_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  create(operator: string, now: number = Date.now()): CreatedSession {
    const token = createSessionToken();
    const record: SessionRecord = { operator, expiresAt: now + this.ttlMs };
    this.sessions.set(token, record);
    return { token, record };
  }

  read(token: string, now: number = Date.now()): SessionRecord | null {
    const record = this.sessions.get(token);
    if (record === undefined) return null;
    if (record.expiresAt <= now) {
      this.sessions.delete(token);
      return null;
    }
    return record;
  }

  destroy(token: string): void {
    this.sessions.delete(token);
  }
}
