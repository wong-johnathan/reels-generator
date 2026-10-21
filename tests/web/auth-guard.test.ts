import { describe, expect, it } from 'vitest';

import {
  buildLoginLocation,
  guardRequest,
  isPublicPath,
  safeNextPath,
} from '../../src/web/auth/guard.js';

/**
 * Route guard (R-015-4: every dashboard/API route requires a session except
 * `/login`). The decision is a pure function of the request path and what the
 * session lookup returned, so the redirect rules are testable without a server.
 */

describe('public paths', () => {
  it('treats the login page, the asset bundle and the compose probes as public', () => {
    for (const path of [
      '/login',
      '/login?next=%2F',
      '/login?expired=1&next=%2Fseries',
      '/assets/app.css',
      '/assets/client/shell.js',
      '/assets/client/login.js?v=1',
      '/healthz',
      '/readyz',
      '/favicon.ico',
    ]) {
      expect(isPublicPath(path), path).toBe(true);
    }
  });

  it('treats every product route as protected', () => {
    for (const path of [
      '/',
      '/?tab=x',
      '/series',
      '/series/abc',
      '/videos/abc/script?rev=4',
      '/settings',
      '/posting',
      '/nope',
    ]) {
      expect(isPublicPath(path), path).toBe(false);
    }
  });
});

describe('safeNextPath', () => {
  it('keeps same-origin absolute paths, with their query string', () => {
    expect(safeNextPath('/')).toBe('/');
    expect(safeNextPath('/series')).toBe('/series');
    expect(safeNextPath('/videos/abc/script?rev=4')).toBe('/videos/abc/script?rev=4');
  });

  it('falls back to / for anything that could leave the origin', () => {
    for (const raw of [
      undefined,
      null,
      '',
      'series',
      '//evil.example',
      '/\\evil.example',
      'https://evil.example/',
      'javascript:alert(1)',
      ' /series',
      '/series\nLocation: https://evil.example',
    ]) {
      expect(safeNextPath(raw), String(raw)).toBe('/');
    }
  });

  it('does not bounce back to the login page after a successful sign-in', () => {
    expect(safeNextPath('/login')).toBe('/');
    expect(safeNextPath('/login?next=%2F')).toBe('/');
  });

  it('rejects an unbounded target', () => {
    expect(safeNextPath('/' + 'a'.repeat(2048))).toBe('/');
  });
});

describe('buildLoginLocation', () => {
  it('names the reason so S-01 can choose the right banner', () => {
    expect(buildLoginLocation('required', '/')).toBe('/login?required=1');
    expect(buildLoginLocation('expired', '/')).toBe('/login?expired=1');
  });

  it('preserves and encodes the requested route', () => {
    expect(buildLoginLocation('required', '/videos/abc/script?rev=4')).toBe(
      '/login?required=1&next=%2Fvideos%2Fabc%2Fscript%3Frev%3D4',
    );
  });
});

describe('guardRequest', () => {
  it('serves a public path without a session', () => {
    expect(guardRequest({ path: '/login', validSession: false, presentedToken: false })).toEqual({
      kind: 'serve',
    });
  });

  it('serves a protected path when the session is valid', () => {
    expect(guardRequest({ path: '/series', validSession: true, presentedToken: true })).toEqual({
      kind: 'serve',
    });
  });

  it('redirects a protected path with no cookie and asks the operator to sign in', () => {
    expect(guardRequest({ path: '/series', validSession: false, presentedToken: false })).toEqual({
      kind: 'redirect',
      location: '/login?required=1&next=%2Fseries',
    });
  });

  it('redirects an expired or revoked cookie to SY-2, keeping the destination', () => {
    expect(guardRequest({ path: '/', validSession: false, presentedToken: true })).toEqual({
      kind: 'redirect',
      location: '/login?expired=1',
    });
    expect(
      guardRequest({ path: '/videos/1?tab=script', validSession: false, presentedToken: true }),
    ).toEqual({
      kind: 'redirect',
      location: '/login?expired=1&next=%2Fvideos%2F1%3Ftab%3Dscript',
    });
  });
});
