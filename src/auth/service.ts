/**
 * Login / authenticate / logout — R-015-1…R-015-4, TECH_DESIGN §10.
 *
 * The service owns the order of operations that matters for security:
 *   1. the backoff check happens before any password work;
 *   2. a missing operator and a wrong password produce the same outcome and the
 *      same message (no account enumeration in the response);
 *   3. only the token hash is persisted;
 *   4. the CSRF token is derived from the session secret, never stored.
 */
import type { LoginBackoff } from './backoff.js';
import { verifyPassword } from './password.js';
import { deriveCsrfToken, hashSessionToken, newSessionToken } from './tokens.js';
import type {
  AuthenticatedSession,
  OperatorReader,
  SessionResolver,
  SessionStore,
} from './types.js';

export interface AuthServiceConfig {
  readonly sessionSecret: string;
  readonly sessionTtlSeconds: number;
  readonly now?: () => Date;
}

export interface AuthServiceDeps {
  readonly operators: OperatorReader;
  readonly sessions: SessionStore;
  readonly backoff: LoginBackoff;
  readonly config: AuthServiceConfig;
}

export interface LoginInput {
  readonly username: string;
  readonly password: string;
  /** Client address (or forwarded first hop) — only used to scope the backoff. */
  readonly clientKey?: string;
}

export type LoginResult =
  | {
      readonly ok: true;
      /** The raw cookie value. It is never persisted or logged. */
      readonly token: string;
      readonly session: AuthenticatedSession;
    }
  | {
      readonly ok: false;
      readonly reason: 'invalid_credentials' | 'rate_limited';
      readonly retryAfterS?: number;
    };

/** Backoff keys are per client *and* username, so one cannot throttle the other. */
export function loginBackoffKey(input: { username: string; clientKey?: string }): string {
  return `login:${input.clientKey ?? 'unknown'}:${input.username.toLowerCase()}`;
}

export class AuthService implements SessionResolver {
  constructor(private readonly deps: AuthServiceDeps) {}

  private now(): Date {
    return this.deps.config.now ? this.deps.config.now() : new Date();
  }

  async login(input: LoginInput): Promise<LoginResult> {
    const key = loginBackoffKey(input);
    const decision = this.deps.backoff.check(key);
    if (!decision.allowed) {
      return { ok: false, reason: 'rate_limited', retryAfterS: decision.retryAfterS };
    }

    const operator = await this.deps.operators.findByUsername(input.username);
    if (!operator) {
      this.deps.backoff.recordFailure(key);
      return { ok: false, reason: 'invalid_credentials' };
    }

    const valid = await verifyPassword(input.password, operator.passwordHash);
    if (!valid) {
      this.deps.backoff.recordFailure(key);
      return { ok: false, reason: 'invalid_credentials' };
    }
    this.deps.backoff.recordSuccess(key);

    const token = newSessionToken();
    const tokenHash = hashSessionToken(token);
    const expiresAt = new Date(this.now().getTime() + this.deps.config.sessionTtlSeconds * 1000);
    const created = await this.deps.sessions.create({
      operatorId: operator.id,
      tokenHash,
      expiresAt,
    });

    return {
      ok: true,
      token,
      session: {
        sessionId: created.id,
        operatorId: operator.id,
        username: operator.username,
        expiresAt,
        csrfToken: deriveCsrfToken(this.deps.config.sessionSecret, tokenHash),
      },
    };
  }

  async authenticate(token: string): Promise<AuthenticatedSession | null> {
    if (token.length === 0) return null;
    const tokenHash = hashSessionToken(token);
    const row = await this.deps.sessions.findByTokenHash(tokenHash, this.now());
    if (!row) return null;
    return {
      sessionId: row.id,
      operatorId: row.operatorId,
      username: row.username,
      expiresAt: row.expiresAt,
      csrfToken: deriveCsrfToken(this.deps.config.sessionSecret, tokenHash),
    };
  }

  /** Destroy the session behind a token. Idempotent: logging out twice is fine. */
  async logout(token: string): Promise<void> {
    if (token.length === 0) return;
    const tokenHash = hashSessionToken(token);
    // `new Date(0)` deliberately finds an expired session too, so a stale cookie
    // still gets its row removed.
    const row = await this.deps.sessions.findByTokenHash(tokenHash, new Date(0));
    if (row) await this.deps.sessions.deleteById(row.id);
  }
}
