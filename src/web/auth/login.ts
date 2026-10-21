/**
 * The authenticator seam (R-015-1, R-015-3).
 *
 * F-02 renders the outcomes; B-13 supplies the argon2id check, the seeded
 * operator and the backoff. Keeping the three outcomes explicit is what lets
 * S-01 show the exact UI_SPEC copy for each one without knowing how the
 * decision was made.
 */

export type AuthOutcome =
  | { readonly kind: 'authenticated'; readonly username: string }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'throttled'; readonly retryAfterSeconds: number };

export type Authenticate = (input: {
  readonly username: string;
  readonly password: string;
}) => AuthOutcome | Promise<AuthOutcome>;
