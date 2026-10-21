/**
 * The dashboard mount (INT-01): the real request handler serving the HTML
 * surface, driven without a socket or a database.
 *
 * These tests go through `createRequestHandler` — not `createWebApp` — because
 * the point is the mount: the same `AuthService` backs both the /api login and
 * the HTML login, the session cookie is `reels_session`, and the overview is the
 * value the mount was given. A fake in-memory service stands in for Postgres, so
 * no database is required.
 */
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import type { AuthService, LoginResult } from '../auth/service.js';
import type { AuthenticatedSession } from '../auth/types.js';
import { EMPTY_OVERVIEW, type Overview } from '../web/overview/postgres.js';
import { createRequestHandler, type HandlerResponse, type HealthProbe } from './server.js';

const TEST_USERNAME = 'operator';
const TEST_PASSWORD = 'preview-passphrase';

const probe: HealthProbe = async () => ({ ready: true, degraded_reasons: [] });

/** A fake AuthService: sessions live in memory, login is a plain string check. */
function fakeAuthService(): AuthService {
  const sessions = new Map<string, AuthenticatedSession>();
  let seq = 0;

  const service = {
    async login(input: { username: string; password: string }): Promise<LoginResult> {
      if (input.username !== TEST_USERNAME || input.password !== TEST_PASSWORD) {
        return { ok: false, reason: 'invalid_credentials' };
      }
      seq += 1;
      const token = `token-${seq}`;
      const session: AuthenticatedSession = {
        sessionId: `session-${seq}`,
        operatorId: 'operator-1',
        username: TEST_USERNAME,
        expiresAt: new Date(Date.now() + 3600_000),
        csrfToken: `csrf-${seq}`,
      };
      sessions.set(token, session);
      return { ok: true, token, session };
    },
    async authenticate(token: string): Promise<AuthenticatedSession | null> {
      const session = sessions.get(token);
      if (session === undefined || session.expiresAt.getTime() <= Date.now()) return null;
      return session;
    },
    async logout(token: string): Promise<void> {
      sessions.delete(token);
    },
  };

  return service as unknown as AuthService;
}

// The web path never reads the pool (the overview is pre-loaded); the series
// route is the only consumer and is not exercised here.
const NO_POOL = null as unknown as Pool;

function handler(options: { overview?: Overview } = {}): ReturnType<typeof createRequestHandler> {
  return createRequestHandler(
    probe,
    { service: fakeAuthService(), sessionTtlSeconds: 3600, secureCookies: false },
    { pool: NO_POOL, overview: options.overview ?? EMPTY_OVERVIEW },
  );
}

function setCookies(headers: HandlerResponse['headers']): string[] {
  const value = headers['set-cookie'];
  if (value === undefined) return [];
  return typeof value === 'string' ? [value] : [...value];
}

function sessionCookieOf(headers: HandlerResponse['headers']): string | undefined {
  return setCookies(headers).find((cookie) => cookie.startsWith('reels_session='));
}

function form(body: Record<string, string>): { headers: Record<string, string>; body: string } {
  return {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  };
}

describe('dashboard mount (INT-01)', () => {
  it('GET /login serves the real login form (200 HTML) without a cookie', async () => {
    const response = await handler()({ method: 'GET', url: '/login' });
    expect(response.status).toBe(200);
    expect(String(response.headers['content-type'])).toContain('text/html');
    expect(response.body).toContain('class="login-form"');
    expect(response.body).toContain('action="/login"');
  });

  it('GET / with no cookie redirects to /login without starting a redirect loop', async () => {
    const handle = handler();
    const redirect = await handle({ method: 'GET', url: '/' });
    expect(redirect.status).toBe(303);
    // The web guard omits `next` when the destination is `/` (see
    // src/web/auth/guard.ts buildLoginLocation), so the location is exactly
    // this — a deliberate, already-tested behaviour.
    const location = redirect.headers['location'];
    expect(location).toBe('/login?required=1');

    // Loop regression: following the redirect must land on the login page, not
    // redirect again (which is what the old unmounted build did, forever).
    const followed = await handle({ method: 'GET', url: location as string });
    expect(followed.status).toBe(200);
    expect(followed.headers['location']).toBeUndefined();
    expect(followed.body).toContain('class="login-form"');
  });

  it('preserves the destination in `next` for a protected non-root path', async () => {
    const response = await handler()({ method: 'GET', url: '/series' });
    expect(response.status).toBe(303);
    expect(response.headers['location']).toBe('/login?required=1&next=%2Fseries');
  });

  it('POST /login with wrong credentials answers 401 with no cookie', async () => {
    const response = await handler()({
      method: 'POST',
      url: '/login',
      ...form({ username: TEST_USERNAME, password: 'wrong-password' }),
    });
    expect(response.status).toBe(401);
    expect(setCookies(response.headers)).toEqual([]);
  });

  it('POST /login with valid credentials redirects to / and sets the cookie pair', async () => {
    const response = await handler()({
      method: 'POST',
      url: '/login',
      ...form({ username: TEST_USERNAME, password: TEST_PASSWORD }),
    });
    expect(response.status).toBe(303);
    expect(response.headers['location']).toBe('/');

    const cookies = setCookies(response.headers);
    const sessionCookie = cookies.find((cookie) => cookie.startsWith('reels_session='));
    const csrfCookie = cookies.find((cookie) => cookie.startsWith('reels_csrf='));
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toContain('SameSite=Lax');
    expect(csrfCookie).toBeDefined();
  });

  it('GET / with the session cookie renders the overview page from the mount data', async () => {
    const overview: Overview = {
      ...EMPTY_OVERVIEW,
      counts: { needs_attention: 0, running: 2, complete: 3 },
    };
    const handle = handler({ overview });

    const login = await handle({
      method: 'POST',
      url: '/login',
      ...form({ username: TEST_USERNAME, password: TEST_PASSWORD }),
    });
    const cookie = sessionCookieOf(login.headers)!.split(';')[0]!;

    const response = await handle({ method: 'GET', url: '/', headers: { cookie } });
    expect(response.status).toBe(200);
    expect(String(response.headers['content-type'])).toContain('text/html');
    expect(response.body).toContain('data-overview');
    expect(response.body).toContain('data-overview-running');
  });

  it('an unknown page or asset path answers the app 404, never a redirect', async () => {
    const handle = handler();
    const login = await handle({
      method: 'POST',
      url: '/login',
      ...form({ username: TEST_USERNAME, password: TEST_PASSWORD }),
    });
    const cookie = sessionCookieOf(login.headers)!.split(';')[0]!;

    const page = await handle({ method: 'GET', url: '/no-such-page', headers: { cookie } });
    expect(page.status).toBe(404);
    expect(page.headers['location']).toBeUndefined();
    expect(page.body).toContain('Page not found');

    // Assets are public; an unknown client module is a 404, not a login redirect.
    const asset = await handle({ method: 'GET', url: '/assets/client/nope.js' });
    expect(asset.status).toBe(404);
    expect(asset.headers['location']).toBeUndefined();
  });
});
