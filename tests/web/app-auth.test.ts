import { describe, expect, it } from 'vitest';

import { HealthReportSchema, OverviewSchema } from '../../contract/api.js';
import { FIXTURES } from '../../contract/mock/fixtures.js';
import { createWebApp, type WebAppDependencies, type WebRequest } from '../../src/web/app.js';
import { MemorySessionStore } from '../../src/web/auth/session.js';

/**
 * F-02 signal: "login sets the session and every protected route redirects to
 * /login".
 *
 * The handler is driven directly (no socket, no database, no provider). The
 * authenticator and the session store are injected: B-13 supplies the
 * argon2id/Postgres implementations during INT-01; this card proves the web
 * contract — 303 with the destination preserved, an httpOnly SameSite=Lax
 * cookie on success, and no protected HTML page reachable without it.
 */

const overview = OverviewSchema.parse(FIXTURES['overview.get']);
const health = HealthReportSchema.parse(FIXTURES['health.report']);
const NOW = Date.parse('2026-10-20T09:41:12.000Z');

const CREDENTIALS = { username: 'operator', password: 'preview-passphrase' };

function app(overrides: Partial<WebAppDependencies> = {}) {
  const sessions = new MemorySessionStore();
  const authenticate = ({
    username,
    password,
  }: {
    username: string;
    password: string;
  }):
    | { kind: 'authenticated'; username: string }
    | { kind: 'rejected' }
    | { kind: 'throttled'; retryAfterSeconds: number } => {
    if (username === 'throttled') return { kind: 'throttled', retryAfterSeconds: 30 };
    return username === CREDENTIALS.username && password === CREDENTIALS.password
      ? { kind: 'authenticated', username }
      : { kind: 'rejected' };
  };
  return createWebApp({
    sessions,
    authenticate,
    overview,
    health,
    now: () => NOW,
    ...overrides,
  });
}

const get = (path: string, cookie?: string): WebRequest => ({
  method: 'GET',
  url: path,
  ...(cookie === undefined ? {} : { headers: { cookie } }),
});

function login(cookie?: string, body = ''): WebRequest {
  return {
    method: 'POST',
    url: '/login',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(cookie === undefined ? {} : { cookie }),
    },
    body,
  };
}

const form = (fields: Record<string, string>): string => new URLSearchParams(fields).toString();

function sessionCookie(response: { headers: Readonly<Record<string, string>> }): string {
  const header = response.headers['set-cookie'];
  expect(header, 'expected a Set-Cookie header').toBeDefined();
  const pair = header!.split(';')[0]!;
  expect(pair.startsWith('session=')).toBe(true);
  return pair;
}

describe('unauthenticated access (R-015-4)', () => {
  it('redirects the overview to /login with "sign in to continue"', async () => {
    const response = await app()(get('/'));
    expect(response.status).toBe(303);
    expect(response.headers['location']).toBe('/login?required=1');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toBe('');
  });

  it('redirects every protected route and preserves its full destination', async () => {
    for (const [path, location] of [
      ['/series', '/login?required=1&next=%2Fseries'],
      ['/videos/abc/script?rev=4', '/login?required=1&next=%2Fvideos%2Fabc%2Fscript%3Frev%3D4'],
      ['/settings', '/login?required=1&next=%2Fsettings'],
      ['/not-a-route', '/login?required=1&next=%2Fnot-a-route'],
    ] as const) {
      const response = await app()(get(path));
      expect(response.status, path).toBe(303);
      expect(response.headers['location'], path).toBe(location);
    }
  });

  it('serves the login page itself without a session', async () => {
    const response = await app()(get('/login?required=1'));
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.body).toContain('Sign in to continue.');
    expect(response.body).toContain('action="/login"');
    expect(response.headers['content-security-policy']).toContain("form-action 'self'");
    expect(response.headers['x-frame-options']).toBe('DENY');
  });

  it('serves the stylesheet and client modules without a session', async () => {
    const handler = app({
      assets: { readClientModule: (name) => (name === 'login' ? '// login module' : null) },
    });
    const css = await handler(get('/assets/app.css'));
    expect(css.status).toBe(200);
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(css.body).toContain('--surface-panel: #15181e;');

    const js = await handler(get('/assets/client/login.js'));
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(js.body).toBe('// login module');

    const missing = await handler(get('/assets/client/nope.js'));
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body).error.code).toBe('not_found');
  });
});

describe('signing in (R-015-1, R-015-2)', () => {
  it('sets an httpOnly SameSite=Lax session cookie and redirects to the overview', async () => {
    const response = await app()(login(undefined, form(CREDENTIALS)));
    expect(response.status).toBe(303);
    expect(response.headers['location']).toBe('/');
    const header = response.headers['set-cookie']!;
    expect(header).toMatch(/^session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax$/);
    expect(header).not.toContain('Secure');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('lets the cookie open every protected page', async () => {
    const handler = app();
    const response = await handler(login(undefined, form(CREDENTIALS)));
    const cookie = sessionCookie(response);
    const overviewPage = await handler(get('/', cookie));
    expect(overviewPage.status).toBe(200);
    expect(overviewPage.body).toContain('class="status-strip"');
    expect(overviewPage.body).toContain('class="rail"');
    expect(overviewPage.body).toContain('operator');
  });

  it('returns to the requested route after signing in', async () => {
    const handler = app();
    const response = await handler(login(undefined, form({ ...CREDENTIALS, next: '/reports' })));
    expect(response.status).toBe(303);
    expect(response.headers['location']).toBe('/reports');
    const page = await handler(get('/reports', sessionCookie(response)));
    expect(page.status).toBe(404);
    expect(page.body).toContain('Page not found');
  });

  it('never accepts an off-site return path', async () => {
    const handler = app();
    const response = await handler(
      login(undefined, form({ ...CREDENTIALS, next: '//evil.example/path' })),
    );
    expect(response.status).toBe(303);
    expect(response.headers['location']).toBe('/');
  });

  it('issues a fresh token for every sign-in, so a fixed token cannot be planted', async () => {
    const handler = app();
    const first = sessionCookie(await handler(login(undefined, form(CREDENTIALS))));
    const second = sessionCookie(await handler(login(undefined, form(CREDENTIALS))));
    expect(first).not.toBe(second);
  });

  it('ignores a stale cookie presented with the sign-in POST', async () => {
    const handler = app();
    const response = await handler(login('session=stale', form(CREDENTIALS)));
    expect(response.status).toBe(303);
    expect(sessionCookie(response)).not.toBe('session=stale');
  });

  it('sends an already-signed-in operator from /login to the overview', async () => {
    const handler = app();
    const cookie = sessionCookie(await handler(login(undefined, form(CREDENTIALS))));
    const response = await handler(get('/login', cookie));
    expect(response.status).toBe(303);
    expect(response.headers['location']).toBe('/');
    const deep = await handler(get('/login?next=%2Fseries', cookie));
    expect(deep.headers['location']).toBe('/series');
  });
});

describe('failed sign-in (US-004)', () => {
  it('renders the same message for a bad password and an unknown username, with no cookie', async () => {
    const handler = app();
    for (const attempt of [
      { username: 'operator', password: 'wrong' },
      { username: 'nobody', password: 'wrong' },
      { username: '', password: '' },
    ]) {
      const response = await handler(login(undefined, form(attempt)));
      expect(response.status).toBe(401);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(response.body).toContain('Wrong username or password');
    }
  });

  it('returns focus to Password and keeps the username and destination', async () => {
    const response = await app()(
      login(undefined, form({ username: 'operator', password: 'wrong', next: '/settings' })),
    );
    expect(response.body).toMatch(/id="password"[^>]*autofocus/);
    expect(response.body).toContain('value="operator"');
    expect(response.body).toContain('value="/settings"');
  });

  it('renders the throttled copy and Retry-After from the authenticator', async () => {
    const response = await app()(login(undefined, form({ username: 'throttled', password: 'x' })));
    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBe('30');
    expect(response.body).toContain('Too many attempts. Try again in 30 s.');
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('rejects an oversized body without calling the authenticator', async () => {
    let called = false;
    const handler = app({
      authenticate: () => {
        called = true;
        return { kind: 'rejected' };
      },
    });
    const response = await handler(login(undefined, 'username=' + 'a'.repeat(5000)));
    expect(response.status).toBe(400);
    expect(called).toBe(false);
    expect(JSON.parse(response.body).error.code).toBe('validation_failed');
  });
});

describe('session expiry (SY-2, AX-21)', () => {
  it('sends an expired cookie to /login with the expiry reason and the destination', async () => {
    const handler = app();
    const cookie = sessionCookie(await handler(login(undefined, form(CREDENTIALS))));
    // A different store instance no longer knows the token: revoked or expired.
    const restarted = app();
    const response = await restarted(get('/videos/1?tab=script', cookie));
    expect(response.status).toBe(303);
    expect(response.headers['location']).toBe('/login?expired=1&next=%2Fvideos%2F1%3Ftab%3Dscript');
  });

  it('renders SY-2 with the spec copy and an assertive announcement', async () => {
    const response = await app()(get('/login?expired=1&next=%2Fsettings', 'session=gone'));
    expect(response.status).toBe(200);
    expect(response.body).toContain('Your session expired. Your unsaved draft is preserved.');
    expect(response.body).toContain(
      'data-message="Your session expired. Your draft is preserved. Sign in to continue."',
    );
    expect(response.body).toContain('value="/settings"');
  });

  it('expires on the server clock even when the cookie is still presented', async () => {
    const sessions = new MemorySessionStore(60_000);
    let now = NOW;
    const handler = app({ sessions, now: () => now });
    const cookie = sessionCookie(await handler(login(undefined, form(CREDENTIALS))));
    expect((await handler(get('/', cookie))).status).toBe(200);
    now += 60_000;
    const expired = await handler(get('/', cookie));
    expect(expired.status).toBe(303);
    expect(expired.headers['location']).toBe('/login?expired=1');
  });
});

describe('SY-3 and transport rules', () => {
  it('renders the not-found system surface for an unknown route when signed in', async () => {
    const handler = app();
    const cookie = sessionCookie(await handler(login(undefined, form(CREDENTIALS))));
    const response = await handler(get('/does-not-exist', cookie));
    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.body).toContain('Page not found');
    expect(response.body).toContain('Go to Overview');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('answers HEAD like GET without a body', async () => {
    const handler = app();
    const headLogin = await handler({ method: 'HEAD', url: '/login' });
    expect(headLogin.status).toBe(200);
    expect(headLogin.body).toBe('');
    const headProtected = await handler({ method: 'HEAD', url: '/' });
    expect(headProtected.status).toBe(303);
    expect(headProtected.body).toBe('');
  });

  it('answers 405 with an Allow header for an unsupported method on the login page', async () => {
    const response = await app()({ method: 'PUT', url: '/login', body: '' });
    expect(response.status).toBe(405);
    expect(response.headers['allow']).toBe('GET, HEAD, POST');
    expect(JSON.parse(response.body).error.code).toBe('method_not_allowed');
  });

  it('does not leak the login page to a malformed or hostile path', async () => {
    const handler = app();
    const response = await handler(get('//evil.example/%2e%2e'));
    // Protocol-relative input is normalised to a path and still protected.
    expect(response.status).toBe(303);
    expect(response.headers['location']?.startsWith('/login?')).toBe(true);
  });
});
