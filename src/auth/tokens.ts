/**
 * Session and CSRF tokens — R-015-2, TECH_DESIGN §3.2 + §10.
 *
 * A session cookie carries 32 random bytes; the `session` row stores only its
 * sha256 (`token_hash`), so a database read cannot be replayed as a cookie. The
 * CSRF token is derived from the session secret and that hash, which keeps the
 * synchroniser token out of the schema and makes it stable for the life of the
 * session (and useless for any other session or deployment).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_TOKEN_BYTES = 32;

/** A fresh 256-bit session token, base64url (43 characters, cookie-safe). */
export function newSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}

/** The value stored in `session.token_hash`. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** The per-session synchroniser token (TECH_DESIGN §10: CSRF on state-changing routes). */
export function deriveCsrfToken(sessionSecret: string, tokenHash: string): string {
  return createHmac('sha256', sessionSecret)
    .update(`csrf:v1:${tokenHash}`, 'utf8')
    .digest('base64url');
}

/** Constant-time string comparison; unequal lengths are simply false. */
export function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
