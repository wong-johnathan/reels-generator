import { describe, expect, it } from 'vitest';

import { clearCookie, parseCookieHeader, serializeCookie } from './cookies.js';

describe('cookie helpers (R-015-2)', () => {
  it('parses a Cookie header without losing values that contain "="', () => {
    const jar = parseCookieHeader('a=1; reels_session=abc.def_-; odd=a=b=c');
    expect(jar).toEqual({ a: '1', reels_session: 'abc.def_-', odd: 'a=b=c' });
  });

  it('survives an absent, empty or malformed header', () => {
    expect(parseCookieHeader(undefined)).toEqual({});
    expect(parseCookieHeader('')).toEqual({});
    expect(parseCookieHeader('; ; =nope; good=yes')).toEqual({ good: 'yes' });
  });

  it('decodes percent-encoded values and ignores broken escapes', () => {
    const jar = parseCookieHeader('a=hello%20world; b=%E0%A4%A; c="quoted"');
    expect(jar.a).toBe('hello world');
    expect(jar.b).toBe('%E0%A4%A');
    expect(jar.c).toBe('quoted');
  });

  it('serialises the httpOnly + SameSite=Lax session cookie', () => {
    const cookie = serializeCookie('reels_session', 'tok', {
      maxAgeSeconds: 720 * 3600,
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
    });
    expect(cookie).toBe('reels_session=tok; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax');
    expect(cookie).not.toContain('Secure');
  });

  it('adds Secure only when TLS termination is configured', () => {
    const cookie = serializeCookie('reels_session', 'tok', { secure: true, httpOnly: true });
    expect(cookie).toContain('Secure');
  });

  it('clears a cookie with Max-Age=0 and an expired date', () => {
    const cookie = clearCookie('reels_session', { httpOnly: true, sameSite: 'Lax', path: '/' });
    expect(cookie).toContain('reels_session=;');
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    expect(cookie).toContain('HttpOnly');
  });
});
