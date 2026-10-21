import { describe, expect, it } from 'vitest';

import { LOGIN_COPY, renderLoginPage, type LoginPageModel } from '../../src/web/render/login.js';
import { accessibleTextOf, byId, byTag, parseHtml, textOf } from './helpers/html.js';

/**
 * S-01 Login — UI_SPEC §6.1 (measurements, states, keyboard order) and §8.4
 * (skip link → Username → Password → show/hide → Sign in). Server-rendered:
 * every state exists in the HTML before any client code runs.
 */

const model: LoginPageModel = {};
const page = (overrides: LoginPageModel = {}): ReturnType<typeof parseHtml> =>
  parseHtml(renderLoginPage({ ...model, ...overrides }));

describe('login page document', () => {
  it('is a dark, self-contained HTML document with no inline code (CSP)', () => {
    const html = renderLoginPage({});
    expect(html.trimStart().toLowerCase().startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta name="color-scheme" content="dark">');
    expect(html).toContain('name="viewport"');
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).not.toMatch(/<script(?![^>]*src=)/);
    expect(html).not.toContain('onclick=');
  });

  it('has the wordmark as its single h1 and a title naming the screen', () => {
    const doc = page();
    const headings = byTag(doc, 'h1');
    expect(headings).toHaveLength(1);
    expect(textOf(headings[0]!)).toBe('reels-generator');
    expect(byTag(doc, 'title')[0] && textOf(byTag(doc, 'title')[0]!)).toBe(
      'Sign in — reels-generator',
    );
  });

  it('puts the skip link first and gives the card a labelled landmark', () => {
    const doc = page();
    const body = byTag(doc, 'body')[0]!;
    const firstElement = body.children.find((child) => child.type === 'element');
    expect(firstElement?.tag).toBe('a');
    expect(firstElement?.attrs['class']).toBe('skip-link');
    expect(firstElement?.attrs['href']).toBe('#main');
    const main = byId(doc, 'main');
    expect(main?.tag).toBe('main');
    expect(main?.attrs['tabindex']).toBe('-1');
  });

  it('loads the token stylesheet and the login enhancement module from our own origin', () => {
    const doc = page();
    const links = byTag(doc, 'link').map((node) => node.attrs['href']);
    expect(links).toContain('/assets/app.css');
    const scripts = byTag(doc, 'script').map((node) => node.attrs['src']);
    expect(scripts).toEqual(['/assets/client/login.js']);
  });
});

describe('login form (UI_SPEC §6.1)', () => {
  it('posts urlencoded credentials to the page route with a hidden return path', () => {
    const form = byTag(page({ next: '/series' }), 'form')[0]!;
    expect(form.attrs['method']).toBe('post');
    expect(form.attrs['action']).toBe('/login');
    expect(form.attrs['novalidate']).toBeDefined();
    const hidden = byTag(form, 'input').find((input) => input.attrs['type'] === 'hidden');
    expect(hidden?.attrs['name']).toBe('next');
    expect(hidden?.attrs['value']).toBe('/series');
  });

  it('labels both fields visibly, never as placeholders', () => {
    const doc = page();
    for (const [name, label] of [
      ['username', 'Username'],
      ['password', 'Password'],
    ] as const) {
      const input = byId(doc, name)!;
      const id = input.attrs['id'];
      const labels = byTag(doc, 'label').filter((node) => node.attrs['for'] === id);
      expect(labels, name).toHaveLength(1);
      expect(textOf(labels[0]!)).toBe(label);
      expect(input.attrs['placeholder']).toBeUndefined();
    }
  });

  it('uses the right input types and autocomplete hints', () => {
    const doc = page();
    expect(byId(doc, 'username')?.attrs['type']).toBe('text');
    expect(byId(doc, 'username')?.attrs['autocomplete']).toBe('username');
    expect(byId(doc, 'password')?.attrs['type']).toBe('password');
    expect(byId(doc, 'password')?.attrs['autocomplete']).toBe('current-password');
    expect(byId(doc, 'username')?.attrs['required']).toBeDefined();
    expect(byId(doc, 'password')?.attrs['required']).toBeDefined();
  });

  it('offers a show/hide control that is a real button, pressed-state aware', () => {
    const doc = page();
    const toggle = byTag(doc, 'button').find((node) => node.attrs['data-reveal'] === 'password')!;
    expect(toggle.attrs['type']).toBe('button');
    expect(toggle.attrs['aria-pressed']).toBe('false');
    expect(toggle.attrs['aria-label']).toBe('Show password');
    expect(textOf(toggle)).toBe('Show');
  });

  it('focuses Username on load and Password after a failed attempt', () => {
    expect(byId(page(), 'username')?.attrs['autofocus']).toBeDefined();
    expect(byId(page(), 'password')?.attrs['autofocus']).toBeUndefined();
    expect(byId(page({ focus: 'password' }), 'password')?.attrs['autofocus']).toBeDefined();
    expect(byId(page({ focus: 'password' }), 'username')?.attrs['autofocus']).toBeUndefined();
  });

  it('renders the submit as a full-width primary button with a spinner slot', () => {
    const doc = page();
    const submit = byId(doc, 'login-submit')!;
    expect(submit.attrs['type']).toBe('submit');
    expect(textOf(submit)).toBe('Sign in');
    expect(byTag(submit, 'span').some((span) => span.attrs['class'] === 'spinner')).toBe(true);
  });

  it('keeps the no-registration, no-reset promise visible', () => {
    const doc = page();
    const note = textOf(byTag(doc, 'p').find((node) => node.attrs['class'] === 'login-note')!);
    expect(note).toBe(
      'No registration. No password reset. Access is by the seeded operator account only.',
    );
    expect(textOf(page())).toContain('Private, LAN-only. One operator account.');
    // No link or button may offer registration, reset, social login or account recovery.
    const controls = [...byTag(doc, 'a'), ...byTag(doc, 'button')];
    for (const control of controls) {
      expect(textOf(control)).not.toMatch(/register|reset|forgot|sign up|social|remember/i);
    }
  });
});

describe('login states', () => {
  it('renders the empty state with no banner and no error', () => {
    const doc = page();
    expect(textOf(page())).not.toContain('Wrong username or password');
    expect(byTag(doc, 'section').some((node) => node.attrs['class'] === 'auth-notice')).toBe(false);
  });

  it('renders wrong credentials assertively, identically for both fields, above the submit', () => {
    const doc = page({ error: LOGIN_COPY.rejected, focus: 'password' });
    const alert = byId(doc, 'login-error')!;
    expect(alert.attrs['role']).toBe('alert');
    expect(accessibleTextOf(alert)).toBe('Wrong username or password');
    expect(byId(doc, 'password')?.attrs['aria-describedby']).toBe('login-error');
    expect(byId(doc, 'username')?.attrs['aria-describedby']).toBe('login-error');
    expect(byId(doc, 'password')?.attrs['aria-invalid']).toBe('true');
    expect(byId(doc, 'username')?.attrs['aria-invalid']).toBe('true');
    const html = renderLoginPage({ error: LOGIN_COPY.rejected });
    expect(html.indexOf('login-error')).toBeLessThan(html.indexOf('login-submit'));
  });

  it('retains the typed username after a failed attempt and never echoes the password', () => {
    const html = renderLoginPage({ username: 'operator', error: LOGIN_COPY.rejected });
    expect(html).toContain('value="operator"');
    expect(html).not.toMatch(/name="password"[^>]*value=/);
  });

  it('renders the throttled copy with the server-supplied wait', () => {
    const doc = page({ error: LOGIN_COPY.throttled(30) });
    expect(accessibleTextOf(byId(doc, 'login-error')!)).toBe(
      'Too many attempts. Try again in 30 s.',
    );
  });

  it('renders SY-2 above the card with the spec copy and an assertive announcement', () => {
    const doc = page({
      notice: {
        kind: 'expired',
        message: LOGIN_COPY.expired,
        announcement: LOGIN_COPY.expiredAnnouncement,
      },
    });
    const notice = byTag(doc, 'section').find((node) => node.attrs['class'] === 'auth-notice')!;
    expect(notice.attrs['data-kind']).toBe('expired');
    expect(textOf(notice)).toContain('Your session expired. Your unsaved draft is preserved.');
    const html = renderLoginPage({
      notice: {
        kind: 'expired',
        message: LOGIN_COPY.expired,
        announcement: LOGIN_COPY.expiredAnnouncement,
      },
    });
    expect(html.indexOf('auth-notice')).toBeLessThan(html.indexOf('login-card'));
    const live = byId(doc, 'live-alert')!;
    expect(live.attrs['aria-live']).toBe('assertive');
    expect(live.attrs['data-message']).toBe(
      'Your session expired. Your draft is preserved. Sign in to continue.',
    );
  });

  it('renders the missing-cookie state as "sign in to continue"', () => {
    const doc = page({ notice: { kind: 'required', message: LOGIN_COPY.required } });
    expect(
      textOf(byTag(doc, 'section').find((n) => n.attrs['class'] === 'auth-notice')!),
    ).toContain('Sign in to continue.');
    expect(byId(doc, 'live-alert')?.attrs['data-message']).toBeUndefined();
  });

  it('escapes the username and the return path', () => {
    const html = renderLoginPage({
      username: '"><script>alert(1)</script>',
      next: '/x?y="><img src=x onerror=alert(1)>',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
  });

  it('keeps both live regions at the end of the body (§8.1)', () => {
    const doc = page();
    expect(byId(doc, 'live-status')?.attrs['aria-live']).toBe('polite');
    expect(byId(doc, 'live-alert')?.attrs['aria-live']).toBe('assertive');
  });
});

describe('copy table', () => {
  it('uses the exact strings from UI_SPEC §6.1/§9.5', () => {
    expect(LOGIN_COPY.rejected).toBe('Wrong username or password');
    expect(LOGIN_COPY.throttled(30)).toBe('Too many attempts. Try again in 30 s.');
    expect(LOGIN_COPY.required).toBe('Sign in to continue.');
    expect(LOGIN_COPY.expired).toBe('Your session expired. Your unsaved draft is preserved.');
    expect(LOGIN_COPY.expiredAnnouncement).toBe(
      'Your session expired. Your draft is preserved. Sign in to continue.',
    );
  });
});
