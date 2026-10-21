import { describe, expect, it } from 'vitest';

import { createAuthPreviewHandler } from '../../src/web/authPreview.js';

/**
 * The F-02 preview mounts the production-shaped handler with an in-memory
 * store and a deterministic fake sign-in. This is the surface used for the
 * browser evidence; no socket is bound here and nothing leaves the process.
 */

const NOW = Date.parse('2026-10-20T09:41:12.000Z');
const handle = createAuthPreviewHandler({ now: () => NOW });

const login = (
  password: string,
  cookie?: string,
): Promise<{ status: number; headers: Readonly<Record<string, string>>; body: string }> =>
  handle({
    method: 'POST',
    url: '/login',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: new URLSearchParams({ username: 'operator', password }).toString(),
  });

describe('auth preview', () => {
  it('starts on the login page and protects the overview', async () => {
    const overview = await handle({ method: 'GET', url: '/' });
    expect(overview.status).toBe(303);
    expect(overview.headers['location']).toBe('/login?required=1');
    const page = await handle({ method: 'GET', url: '/login?required=1' });
    expect(page.status).toBe(200);
    expect(page.body).toContain('Sign in to continue.');
  });

  it('signs in with the deterministic fake and then serves the shell', async () => {
    const response = await login('preview');
    expect(response.status).toBe(303);
    const cookie = response.headers['set-cookie']!.split(';')[0]!;
    const overview = await handle({ method: 'GET', url: '/', headers: { cookie } });
    expect(overview.status).toBe(200);
    expect(overview.body).toContain('operator');
  });

  it('rejects the wrong fake password with the spec copy', async () => {
    const response = await login('nope');
    expect(response.status).toBe(401);
    expect(response.body).toContain('Wrong username or password');
  });

  it('serves the transpiled login module as browser ESM', async () => {
    const response = await handle({ method: 'GET', url: '/assets/client/login.js' });
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(response.body).toContain('initLogin');
    expect(response.body).not.toContain('interface ');
  });
});
