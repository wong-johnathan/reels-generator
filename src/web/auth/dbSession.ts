/**
 * The DB-backed web session store (INT-01 seam).
 *
 * The web layer reads sessions through the same `AuthService` the HTTP API
 * uses, so a cookie issued by `POST /api/login` opens the dashboard pages and
 * a cookie issued by `POST /login` (the HTML form) is accepted by the API. The
 * two surfaces share one session table and one token format, and this adapter
 * is the join that makes that true.
 *
 * `create` is not a real path: `AuthService.login` already creates the session
 * and returns its token, and the web sign-in consumes that token directly
 * (see `AuthOutcome.sessionToken`). Re-creating here would need the password,
 * which the web layer deliberately does not hold after the authenticator has
 * run, so the method exists only to satisfy `SessionStore` and fails loudly if
 * a wiring mistake ever reaches it.
 */
import type { AuthenticatedSession } from '../../auth/types.js';
import type { CreatedSession, SessionRecord, SessionStore } from './session.js';

/** What the adapter needs from the production auth service. */
export interface DbSessionBackend {
  authenticate(token: string): Promise<AuthenticatedSession | null>;
  logout(token: string): Promise<void>;
}

export function createDbSessionStore(backend: DbSessionBackend): SessionStore {
  return {
    create(_operator: string, _now?: number): CreatedSession | Promise<CreatedSession> {
      throw new Error(
        'dbSession.create: sessions are created by AuthService.login, not by the web store',
      );
    },

    async read(_token: string, _now?: number): Promise<SessionRecord | null> {
      // `AuthService.authenticate` already drops expired rows (its store filters
      // `expires_at > now`), so a non-null result is a live session.
      const session = await backend.authenticate(_token);
      if (session === null) return null;
      return { operator: session.username, expiresAt: session.expiresAt.getTime() };
    },

    async destroy(token: string): Promise<void> {
      await backend.logout(token);
    },
  };
}
