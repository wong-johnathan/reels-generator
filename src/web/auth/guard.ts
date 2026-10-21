/**
 * Route guard (R-015-4: every dashboard/API route requires the session except
 * `/login`).
 *
 * Pure policy, evaluated before any route handler runs. That ordering is the
 * point: a route added by a later card is protected by default and cannot
 * forget to check. The only public surfaces are the login page, the static
 * assets the login page needs, and the compose probes.
 */

export const LOGIN_PATH = '/login';

const MAX_NEXT_LENGTH = 2048;

export interface AuthGuardInput {
  /** Path plus query string, as received. */
  readonly path: string;
  readonly validSession: boolean;
  /** True when a session cookie was presented but did not resolve. */
  readonly presentedToken: boolean;
}

export type AuthDecision =
  { readonly kind: 'serve' } | { readonly kind: 'redirect'; readonly location: string };

function pathnameOf(path: string): string {
  const end = path.search(/[?#]/);
  return end === -1 ? path : path.slice(0, end);
}

export function isPublicPath(path: string): boolean {
  const pathname = pathnameOf(path);
  if (pathname === LOGIN_PATH) return true;
  if (pathname.startsWith('/assets/')) return true;
  return pathname === '/healthz' || pathname === '/readyz' || pathname === '/favicon.ico';
}

/** C0 controls and DEL can split a header; checked without a control regex. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Only a same-origin absolute path is a valid post-sign-in destination. `//`
 * and `/\` are protocol-relative to browsers, and control characters can split
 * a Location header; all of them fall back to the overview.
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '/';
  if (raw.length === 0 || raw.length > MAX_NEXT_LENGTH) return '/';
  if (!raw.startsWith('/')) return '/';
  if (raw.startsWith('//') || raw.includes('\\')) return '/';
  if (hasControlCharacter(raw)) return '/';
  if (raw === LOGIN_PATH || raw.startsWith(LOGIN_PATH + '?') || raw.startsWith(LOGIN_PATH + '/')) {
    return '/';
  }
  return raw;
}

export function buildLoginLocation(reason: 'required' | 'expired', next: string): string {
  const params = new URLSearchParams();
  params.set(reason, '1');
  const target = safeNextPath(next);
  if (target !== '/') params.set('next', target);
  return LOGIN_PATH + '?' + params.toString();
}

export function guardRequest(input: AuthGuardInput): AuthDecision {
  if (isPublicPath(input.path)) return { kind: 'serve' };
  if (input.validSession) return { kind: 'serve' };
  return {
    kind: 'redirect',
    location: buildLoginLocation(input.presentedToken ? 'expired' : 'required', input.path),
  };
}
