/**
 * Default-deny session middleware — R-015-4, TECH_DESIGN §10.
 *
 * This is the single place that decides whether a request may reach a handler.
 * The allowlist is deliberately tiny and asserted against the frozen contract in
 * the tests, so a route added to `contract/api.ts` without `auth: true` fails a
 * test instead of shipping as public.
 *
 * Public surface:
 *   GET  /healthz     compose liveness probe
 *   GET  /readyz      compose readiness probe (R-018)
 *   GET  /api/session reports the current session (and "no session")
 *   POST /api/login   the only route R-015-4 exempts
 *
 * Everything else — every /api route, every HTML screen, every path that is not
 * even in the contract — requires a live session. A browser gets a 302 to
 * `/login?next=…`; an API caller gets the contract's 401 envelope.
 *
 * CSRF: state-changing methods additionally require the session's synchroniser
 * token, supplied as `x-csrf-token` or a `_csrf` field (urlencoded or JSON form).
 * The token is server-derived per session (src/auth/tokens.ts), so it needs no
 * schema column and dies with the session.
 */
import type { AuthenticatedSession, SessionResolver } from '../../auth/types.js';
import { constantTimeEqual } from '../../auth/tokens.js';
import { parseCookieHeader } from '../../auth/cookies.js';

export const SESSION_COOKIE_NAME = 'reels_session';
export const CSRF_COOKIE_NAME = 'reels_csrf';
export const CSRF_HEADER_NAME = 'x-csrf-token';
export const LOGIN_PATH = '/login';

export const PUBLIC_ROUTES = [
  { method: 'GET', path: '/healthz' },
  { method: 'GET', path: '/readyz' },
  { method: 'GET', path: '/api/session' },
  { method: 'POST', path: '/api/login' },
] as const;

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export type HttpResponseHeaders = Readonly<Record<string, string | readonly string[]>>;

export interface HttpResponse {
  readonly status: number;
  readonly headers: HttpResponseHeaders;
  readonly body: string;
}

export interface HttpRequestLike {
  readonly method: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly body?: string;
}

export interface AuthMiddlewareDeps {
  readonly resolver: SessionResolver;
}

export interface AuthDecision {
  readonly allowed: boolean;
  readonly session: AuthenticatedSession | null;
  /** Present exactly when `allowed` is false. */
  readonly response?: HttpResponse;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' } as const;

/** The path without its query string. */
export function requestPath(url: string): string {
  const query = url.indexOf('?');
  const path = query === -1 ? url : url.slice(0, query);
  return path.startsWith('/') ? path : `/${path}`;
}

function normaliseMethod(method: string): string {
  return method.toUpperCase();
}

/** Exact method+path match: `/healthz/` and `POST /healthz` are not public. */
export function isPublicRoute(method: string, path: string): boolean {
  const normalised = normaliseMethod(method);
  return PUBLIC_ROUTES.some((route) => route.method === normalised && route.path === path);
}

function headerValue(
  headers: Readonly<Record<string, string | undefined>> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted && value !== undefined) return value;
  }
  return undefined;
}

/** The raw session cookie value, or null. */
export function sessionTokenFromRequest(request: HttpRequestLike): string | null {
  const jar = parseCookieHeader(headerValue(request.headers, 'cookie'));
  const token = jar[SESSION_COOKIE_NAME];
  return token && token.length > 0 ? token : null;
}

/** The CSRF token the client presented (header first, then form field). */
export function csrfTokenFromRequest(request: HttpRequestLike): string | null {
  const header = headerValue(request.headers, CSRF_HEADER_NAME);
  if (header && header.length > 0) return header;

  const body = request.body;
  if (!body) return null;
  const contentType = headerValue(request.headers, 'content-type') ?? '';

  if (contentType.includes('application/x-www-form-urlencoded')) {
    const field = new URLSearchParams(body).get('_csrf');
    return field && field.length > 0 ? field : null;
  }
  if (contentType.includes('application/json')) {
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed !== null && typeof parsed === 'object' && '_csrf' in parsed) {
        const field = (parsed as Record<string, unknown>)['_csrf'];
        return typeof field === 'string' && field.length > 0 ? field : null;
      }
    } catch {
      return null;
    }
  }
  return null;
}

/** True for API callers, who get a JSON 401 instead of a login redirect. */
export function isApiRequest(request: HttpRequestLike, path: string): boolean {
  if (path.startsWith('/api/')) return true;
  const accept = headerValue(request.headers, 'accept') ?? '';
  return accept.includes('application/json');
}

function errorResponse(status: number, code: string, message: string): HttpResponse {
  return {
    status,
    headers: JSON_HEADERS,
    body: JSON.stringify({ error: { code, message } }),
  };
}

/** Keep `next` a same-origin path: a absolute URL would be an open redirect. */
function safeNext(url: string): string {
  return url.startsWith('/') && !url.startsWith('//') ? url : '/';
}

function loginRedirect(next: string): HttpResponse {
  return {
    status: 302,
    headers: {
      location: `${LOGIN_PATH}?next=${encodeURIComponent(next)}`,
      'cache-control': 'no-store',
    },
    body: '',
  };
}

/** The R-015-4 rejection: redirect for a browser, 401 envelope for an API caller. */
export function unauthenticatedResponse(request: HttpRequestLike, path: string): HttpResponse {
  return isApiRequest(request, path)
    ? errorResponse(401, 'unauthorized', 'Authentication required')
    : loginRedirect(safeNext(request.url));
}

function csrfFailureResponse(): HttpResponse {
  return errorResponse(403, 'unauthorized', 'CSRF token missing or invalid');
}

/**
 * Decide whether a request may proceed.
 *
 * Public routes are allowed without a session (the session endpoint reports the
 * absence itself). Every other route is denied unless the cookie resolves to a
 * live session; state-changing methods additionally require a matching CSRF
 * token. There is no "authenticated but unprotected" path.
 */
export async function authorize(
  request: HttpRequestLike,
  deps: AuthMiddlewareDeps,
): Promise<AuthDecision> {
  const method = normaliseMethod(request.method);
  const path = requestPath(request.url);

  if (isPublicRoute(method, path)) {
    return { allowed: true, session: null };
  }

  const token = sessionTokenFromRequest(request);
  if (!token) {
    return { allowed: false, session: null, response: unauthenticatedResponse(request, path) };
  }

  const session = await deps.resolver.authenticate(token);
  if (!session) {
    return { allowed: false, session: null, response: unauthenticatedResponse(request, path) };
  }

  if (MUTATING_METHODS.has(method)) {
    const presented = csrfTokenFromRequest(request);
    if (!presented || !constantTimeEqual(presented, session.csrfToken)) {
      return { allowed: false, session, response: csrfFailureResponse() };
    }
  }

  return { allowed: true, session };
}
