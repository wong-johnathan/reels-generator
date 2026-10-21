/**
 * The auth seams.
 *
 * The middleware depends on these interfaces, not on Postgres or on the service
 * implementation, so the default-deny rules can be tested without a database and
 * the stores can be swapped without touching HTTP behaviour.
 */

/** The single seeded operator (`operator` row). */
export interface OperatorRecord {
  readonly id: string;
  readonly username: string;
  readonly passwordHash: string;
}

/** A `session` row joined with its operator — what a cookie resolves to. */
export interface SessionRecord {
  readonly id: string;
  readonly operatorId: string;
  readonly username: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

/** An authenticated request's session, including the derived CSRF token. */
export interface AuthenticatedSession {
  readonly sessionId: string;
  readonly operatorId: string;
  readonly username: string;
  readonly expiresAt: Date;
  /** Synchroniser token for state-changing routes (TECH_DESIGN §10). */
  readonly csrfToken: string;
}

export interface NewSession {
  readonly operatorId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

export interface SessionStore {
  create(session: NewSession): Promise<{ id: string }>;
  /** A live session (expires_at > now) with its operator's username, or null. */
  findByTokenHash(tokenHash: string, now: Date): Promise<SessionRecord | null>;
  deleteById(id: string): Promise<void>;
  /** Purge expired rows; returns how many were removed. */
  deleteExpired(now: Date): Promise<number>;
}

export interface OperatorReader {
  findByUsername(username: string): Promise<OperatorRecord | null>;
}

/** What the HTTP middleware needs: cookie value in, session or null out. */
export interface SessionResolver {
  authenticate(token: string): Promise<AuthenticatedSession | null>;
}
