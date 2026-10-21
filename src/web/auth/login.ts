/**
 * The authenticator seam (R-015-1, R-015-3).
 *
 * F-02 renders the outcomes; B-13 supplies the argon2id check, the seeded
 * operator and the backoff. Keeping the three outcomes explicit is what lets
 * S-01 show the exact UI_SPEC copy for each one without knowing how the
 * decision was made.
 */

export type AuthOutcome =
  | {
      readonly kind: 'authenticated';
      readonly username: string;
      /**
       * When the authenticator already minted the session (the DB-backed
       * AuthService.login does), it returns the raw cookie value here. The web
       * sign-in then issues it directly instead of calling `sessions.create`,
       * which would otherwise try to re-create a session without the password.
       */
      readonly sessionToken?: string;
      /** The session's synchroniser token, issued next to the session cookie. */
      readonly csrfToken?: string;
    }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'throttled'; readonly retryAfterSeconds: number };

export type Authenticate = (input: {
  readonly username: string;
  readonly password: string;
}) => AuthOutcome | Promise<AuthOutcome>;
