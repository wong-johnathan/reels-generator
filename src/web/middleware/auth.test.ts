import { describe, expect, it } from 'vitest';

import { ErrorEnvelopeSchema, ROUTES } from '../../../contract/api.js';
import type { AuthenticatedSession, SessionResolver } from '../../auth/types.js';
import {
  authorize,
  CSRF_HEADER_NAME,
  isPublicRoute,
  PUBLIC_ROUTES,
  requestPath,
  SESSION_COOKIE_NAME,
} from './auth.js';

const SESSION: AuthenticatedSession = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  operatorId: '22222222-2222-4222-8222-222222222222',
  username: 'owner',
  expiresAt: new Date('2030-01-01T00:00:00.000Z'),
  csrfToken: 'csrf-token-value-0123456789abcdefghij',
};

const resolver: SessionResolver = {
  authenticate: async (token) => (token === 'valid-session-token' ? SESSION : null),
};

interface RequestInit {
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

function request(method: string, url: string, init: RequestInit = {}) {
  return { method, url, headers: init.headers ?? {}, body: init.body };
}

const authed = { Cookie: `${SESSION_COOKIE_NAME}=valid-session-token` };

function envelope(response: { body: string }) {
  return ErrorEnvelopeSchema.parse(JSON.parse(response.body));
}

/**
 * B-13 Signal, middleware half: every contract route except the login/session
 * pair and the compose probes requires a session (R-015-4). The route list is
 * imported from the frozen contract, so an endpoint added there without a
 * session cannot silently ship as public.
 */
describe('default-deny session middleware (R-015-4)', () => {
  it('derives the public allowlist from the contract and nothing else', () => {
    const contractPublic = ROUTES.filter((route) => !route.auth)
      .map((route) => `${route.method} ${route.path}`)
      .sort();
    const middlewarePublic = PUBLIC_ROUTES.map((route) => `${route.method} ${route.path}`).sort();
    expect(middlewarePublic).toEqual(contractPublic);
    expect(middlewarePublic).toEqual([
      'GET /api/session',
      'GET /healthz',
      'GET /readyz',
      'POST /api/login',
    ]);
  });

  it('rejects every contract route that says auth:true when no cookie is present', async () => {
    const protectedRoutes = ROUTES.filter((route) => route.auth);
    expect(protectedRoutes.length).toBeGreaterThan(20);
    for (const route of protectedRoutes) {
      const decision = await authorize(request(route.method, route.path), { resolver });
      expect(decision.allowed, `${route.method} ${route.path}`).toBe(false);
      expect(decision.response?.status, `${route.method} ${route.path}`).toBe(401);
      expect(envelope(decision.response!).error.code).toBe('unauthorized');
    }
  });

  it('also rejects routes that are not in the contract at all (no route enumeration)', async () => {
    for (const path of ['/api/admin', '/api/register', '/api/password-reset', '/workspace', '/']) {
      const decision = await authorize(request('GET', path), { resolver });
      expect(decision.allowed, path).toBe(false);
    }
  });

  it('rejects an unknown or expired session token', async () => {
    const decision = await authorize(
      request('GET', '/api/series', { headers: { Cookie: `${SESSION_COOKIE_NAME}=stale` } }),
      { resolver },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.response?.status).toBe(401);
  });

  it('allows the public routes with no session', async () => {
    for (const route of PUBLIC_ROUTES) {
      const decision = await authorize(request(route.method, route.path), { resolver });
      expect(decision.allowed, `${route.method} ${route.path}`).toBe(true);
    }
  });

  it('allows a protected GET with a valid session', async () => {
    const decision = await authorize(request('GET', '/api/series', { headers: authed }), {
      resolver,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.session?.username).toBe('owner');
  });

  it('redirects an unauthenticated browser request to /login with a next target', async () => {
    const decision = await authorize(request('GET', '/workspace?tab=1'), { resolver });
    expect(decision.allowed).toBe(false);
    expect(decision.response?.status).toBe(302);
    const location = decision.response?.headers.location;
    expect(location).toBe('/login?next=%2Fworkspace%3Ftab%3D1');
  });

  it('returns JSON 401 for /api/* instead of a redirect', async () => {
    const decision = await authorize(request('GET', '/api/overview'), { resolver });
    expect(decision.response?.status).toBe(401);
    expect(decision.response?.headers['content-type']).toContain('application/json');
  });
});

/**
 * TECH_DESIGN §10: "CSRF protection on all state-changing routes". The token is
 * server-derived per session (no schema column) and compared in constant time;
 * the crypto property is tested in tokens.test.ts, the wiring here.
 */
describe('CSRF on state-changing routes (TECH_DESIGN §10)', () => {
  it('rejects a state-changing request with no CSRF token', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const decision = await authorize(request(method, '/api/series/abc', { headers: authed }), {
        resolver,
      });
      expect(decision.allowed, method).toBe(false);
      expect(decision.response?.status).toBe(403);
      expect(envelope(decision.response!).error.code).toBe('unauthorized');
    }
  });

  it('rejects a wrong CSRF token and a token from another session', async () => {
    for (const token of ['wrong', SESSION.csrfToken.slice(0, -1), '']) {
      const decision = await authorize(
        request('POST', '/api/series', { headers: { ...authed, [CSRF_HEADER_NAME]: token } }),
        { resolver },
      );
      expect(decision.allowed, token).toBe(false);
    }
  });

  it('accepts the token in the synchroniser header', async () => {
    const decision = await authorize(
      request('POST', '/api/series', {
        headers: { ...authed, [CSRF_HEADER_NAME]: SESSION.csrfToken },
      }),
      { resolver },
    );
    expect(decision.allowed).toBe(true);
  });

  it('accepts the token in an urlencoded form body (progressive enhancement)', async () => {
    const decision = await authorize(
      request('POST', '/api/series', {
        headers: { ...authed, 'content-type': 'application/x-www-form-urlencoded' },
        body: `name=Quiet+Machines&_csrf=${SESSION.csrfToken}`,
      }),
      { resolver },
    );
    expect(decision.allowed).toBe(true);
  });

  it('accepts the token in a JSON body', async () => {
    const decision = await authorize(
      request('PATCH', '/api/series/abc', {
        headers: { ...authed, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Quiet Machines', _csrf: SESSION.csrfToken }),
      }),
      { resolver },
    );
    expect(decision.allowed).toBe(true);
  });

  it('does not require CSRF on GET/HEAD', async () => {
    for (const method of ['GET', 'HEAD']) {
      const decision = await authorize(request(method, '/api/series', { headers: authed }), {
        resolver,
      });
      expect(decision.allowed, method).toBe(true);
    }
  });
});

describe('request path handling', () => {
  it('strips the query string and tolerates a missing leading slash', () => {
    expect(requestPath('/api/series?page=2')).toBe('/api/series');
    expect(requestPath('/api/series')).toBe('/api/series');
  });

  it('matches public routes exactly (a trailing slash is not public)', () => {
    expect(isPublicRoute('GET', '/healthz')).toBe(true);
    expect(isPublicRoute('POST', '/healthz')).toBe(false);
    expect(isPublicRoute('GET', '/healthz/')).toBe(false);
    expect(isPublicRoute('get', '/healthz')).toBe(true);
  });
});
