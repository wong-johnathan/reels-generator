import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ErrorEnvelopeSchema, ROUTES, SessionInfoSchema } from '../../contract/api.js';
import { LoginBackoff } from '../auth/backoff.js';
import { AuthService } from '../auth/service.js';
import {
  provisionAuth,
  TEST_PASSWORD,
  TEST_SESSION_SECRET,
  TEST_TTL_SECONDS,
  TEST_USERNAME,
  type AuthFixture,
} from '../../tests/helpers/auth.js';
import { SKIP_REASON, testDatabaseUrl } from '../../tests/helpers/pg.js';
import { createRequestHandler, type AuthRuntime, type HealthProbe } from './server.js';

/**
 * B-13 Signal, HTTP half: every route except the login/session pair and the
 * compose probes requires a session, and the login sets the httpOnly +
 * SameSite=Lax cookie of R-015-2. These tests drive the real handler with the
 * real Postgres-backed service — no network, no provider.
 */
const hasDatabase = testDatabaseUrl() !== null;
if (!hasDatabase) console.warn(`[auth route tests skipped] ${SKIP_REASON}`);

const probe: HealthProbe = async () => ({ ready: true, degraded_reasons: [] });

function runtime(fixture: AuthFixture, service = fixture.service): AuthRuntime {
  return { service, sessionTtlSeconds: TEST_TTL_SECONDS, secureCookies: false };
}

function setCookies(headers: Readonly<Record<string, string | readonly string[]>>): string[] {
  const value = headers['set-cookie'];
  if (value === undefined) return [];
  return typeof value === 'string' ? [value] : [...value];
}

function cookieValue(
  headers: Readonly<Record<string, string | readonly string[]>>,
  name: string,
): string | undefined {
  for (const cookie of setCookies(headers)) {
    const pair = cookie.split(';')[0] ?? '';
    const separator = pair.indexOf('=');
    if (separator > 0 && pair.slice(0, separator) === name) return pair.slice(separator + 1);
  }
  return undefined;
}

function cookieHeader(token: string): Record<string, string> {
  return { Cookie: `reels_session=${token}` };
}

function jsonBody(value: unknown): { headers: Record<string, string>; body: string } {
  return {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  };
}

describe.skipIf(!hasDatabase)('auth routes (R-015-2, R-015-3, R-015-4)', () => {
  let fixture: AuthFixture;
  let handle: ReturnType<typeof createRequestHandler>;

  beforeAll(async () => {
    fixture = await provisionAuth();
    handle = createRequestHandler(probe, runtime(fixture));
  });

  afterAll(async () => {
    await fixture.close();
  });

  async function login(): Promise<{
    token: string;
    csrf: string;
    headers: Record<string, string | readonly string[]>;
  }> {
    const response = await handle({
      method: 'POST',
      url: '/api/login',
      ...jsonBody({ username: TEST_USERNAME, password: TEST_PASSWORD }),
    });
    expect(response.status).toBe(200);
    const token = cookieValue(response.headers, 'reels_session');
    const csrf = cookieValue(response.headers, 'reels_csrf');
    expect(token).toBeDefined();
    expect(csrf).toBeDefined();
    return { token: token!, csrf: csrf!, headers: response.headers };
  }

  it('POST /api/login sets httpOnly + SameSite=Lax session cookies and returns SessionInfo', async () => {
    fixture.clock.set('2026-10-21T00:00:00.000Z');
    const response = await handle({
      method: 'POST',
      url: '/api/login',
      ...jsonBody({ username: TEST_USERNAME, password: TEST_PASSWORD }),
    });
    expect(response.status).toBe(200);

    const cookies = setCookies(response.headers);
    expect(cookies).toHaveLength(2);
    const sessionCookie = cookies.find((cookie) => cookie.startsWith('reels_session='))!;
    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toContain('SameSite=Lax');
    expect(sessionCookie).toContain('Path=/');
    expect(sessionCookie).toContain(`Max-Age=${TEST_TTL_SECONDS}`);
    expect(sessionCookie).not.toContain('Secure');
    expect(
      cookies.some((cookie) => cookie.startsWith('reels_csrf=') && cookie.includes('HttpOnly')),
    ).toBe(true);

    const info = SessionInfoSchema.parse(JSON.parse(response.body));
    expect(info.authenticated).toBe(true);
    expect(info.username).toBe(TEST_USERNAME);
    expect(info.csrf_token.length).toBeGreaterThan(20);
    expect(info.expires_at).toBe(
      new Date(Date.parse('2026-10-21T00:00:00.000Z') + TEST_TTL_SECONDS * 1000).toISOString(),
    );
    expect(response.body).not.toContain(TEST_PASSWORD);
    expect(response.body).not.toContain('argon2');
  });

  it('marks the session cookie Secure when the base URL is https', async () => {
    const httpsHandle = createRequestHandler(probe, {
      ...runtime(fixture),
      secureCookies: true,
    });
    const response = await httpsHandle({
      method: 'POST',
      url: '/api/login',
      ...jsonBody({ username: TEST_USERNAME, password: TEST_PASSWORD }),
    });
    const sessionCookie = setCookies(response.headers).find((cookie) =>
      cookie.startsWith('reels_session='),
    )!;
    expect(sessionCookie).toContain('Secure');
  });

  it('rejects a wrong password with a generic 401 and sets no cookie', async () => {
    const response = await handle({
      method: 'POST',
      url: '/api/login',
      remoteAddress: '192.0.2.10',
      ...jsonBody({ username: TEST_USERNAME, password: 'wrong-password-123' }),
    });
    expect(response.status).toBe(401);
    expect(setCookies(response.headers)).toEqual([]);
    const envelope = ErrorEnvelopeSchema.parse(JSON.parse(response.body));
    expect(envelope.error.code).toBe('unauthorized');
    expect(envelope.error.message).toBe('Invalid username or password');
  });

  it('rejects a malformed login body with validation_failed', async () => {
    for (const body of ['not json', '{}', '{"username":"owner"}', '{"username":1,"password":2}']) {
      const response = await handle({
        method: 'POST',
        url: '/api/login',
        headers: { 'content-type': 'application/json' },
        body,
      });
      expect(response.status, body).toBe(400);
      expect(ErrorEnvelopeSchema.parse(JSON.parse(response.body)).error.code).toBe(
        'validation_failed',
      );
    }
  });

  it('GET /api/session reports the live session, and an empty one when unauthenticated', async () => {
    const { token, csrf } = await login();

    const anonymous = await handle({ method: 'GET', url: '/api/session' });
    expect(anonymous.status).toBe(200);
    expect(SessionInfoSchema.parse(JSON.parse(anonymous.body))).toEqual({
      authenticated: false,
      username: null,
      csrf_token: '',
      expires_at: null,
    });

    const authenticated = await handle({
      method: 'GET',
      url: '/api/session',
      headers: cookieHeader(token),
    });
    const info = SessionInfoSchema.parse(JSON.parse(authenticated.body));
    expect(info).toEqual({
      authenticated: true,
      username: TEST_USERNAME,
      csrf_token: csrf,
      expires_at: info.expires_at,
    });
    expect(authenticated.headers['cache-control']).toBe('no-store');
  });

  it('protects every /api route except login/session (R-015-4)', async () => {
    for (const route of ROUTES.filter((entry) => entry.auth)) {
      const response = await handle({ method: route.method, url: route.path });
      expect(response.status, `${route.method} ${route.path}`).toBe(401);
      expect(ErrorEnvelopeSchema.parse(JSON.parse(response.body)).error.code).toBe('unauthorized');
    }
  });

  it('passes an authenticated request through to the (not yet implemented) route', async () => {
    const { token } = await login();
    const response = await handle({
      method: 'GET',
      url: '/api/overview',
      headers: cookieHeader(token),
    });
    expect(response.status).toBe(404);
    expect(ErrorEnvelopeSchema.parse(JSON.parse(response.body)).error.code).toBe('not_found');
  });

  it('rejects a tampered or unknown session cookie', async () => {
    const { token } = await login();
    for (const candidate of [`${token}x`, 'forged-token', '']) {
      const response = await handle({
        method: 'GET',
        url: '/api/overview',
        headers: { Cookie: `reels_session=${candidate}` },
      });
      expect(response.status, candidate).toBe(401);
    }
  });

  it('requires the CSRF token to log out, then destroys the session and clears the cookies', async () => {
    const { token, csrf } = await login();

    const noToken = await handle({
      method: 'POST',
      url: '/api/logout',
      headers: cookieHeader(token),
    });
    expect(noToken.status).toBe(403);

    const wrongToken = await handle({
      method: 'POST',
      url: '/api/logout',
      headers: { ...cookieHeader(token), 'x-csrf-token': 'nope' },
    });
    expect(wrongToken.status).toBe(403);

    const loggedOut = await handle({
      method: 'POST',
      url: '/api/logout',
      headers: { ...cookieHeader(token), 'x-csrf-token': csrf },
    });
    expect(loggedOut.status).toBe(200);
    expect(JSON.parse(loggedOut.body)).toEqual({ ok: true });
    const cleared = setCookies(loggedOut.headers);
    expect(cleared).toHaveLength(2);
    for (const cookie of cleared) expect(cookie).toContain('Max-Age=0');

    const after = await handle({
      method: 'GET',
      url: '/api/session',
      headers: cookieHeader(token),
    });
    expect(SessionInfoSchema.parse(JSON.parse(after.body)).authenticated).toBe(false);
  });

  it('has no registration or password-reset endpoint (R-015-3)', async () => {
    const contractPaths = new Set(ROUTES.map((route) => route.path));
    expect([...contractPaths].filter((path) => /register|reset|signup/i.test(path))).toEqual([]);

    const { token, csrf } = await login();
    for (const path of ['/api/register', '/api/password-reset']) {
      const anonymous = await handle({
        method: 'POST',
        url: path,
        ...jsonBody({ username: 'x', password: 'y' }),
      });
      expect(anonymous.status, `${path} anonymous`).toBe(401);

      const authenticated = await handle({
        method: 'POST',
        url: path,
        headers: {
          ...cookieHeader(token),
          'x-csrf-token': csrf,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ username: 'x', password: 'y' }),
      });
      expect(authenticated.status, `${path} authenticated`).toBe(404);
      expect(ErrorEnvelopeSchema.parse(JSON.parse(authenticated.body)).error.code).toBe(
        'not_found',
      );
    }
  });

  it('answers 429 with Retry-After once the login backoff trips', async () => {
    const service = new AuthService({
      operators: fixture.operators,
      sessions: fixture.sessions,
      backoff: new LoginBackoff({ now: fixture.clock.now }),
      config: {
        sessionSecret: TEST_SESSION_SECRET,
        sessionTtlSeconds: TEST_TTL_SECONDS,
        now: fixture.clock.now,
      },
    });
    const limited = createRequestHandler(probe, runtime(fixture, service));
    const attempt = () =>
      limited({
        method: 'POST',
        url: '/api/login',
        remoteAddress: '198.51.100.7',
        ...jsonBody({ username: TEST_USERNAME, password: 'wrong-password-123' }),
      });

    fixture.clock.set('2026-10-21T05:00:00.000Z');
    expect((await attempt()).status).toBe(401);
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBe('1');
    expect(ErrorEnvelopeSchema.parse(JSON.parse(blocked.body)).error.code).toBe('rate_limited');
  });
});
