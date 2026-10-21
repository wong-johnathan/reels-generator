/**
 * S-01 Login — server-rendered HTML (UI_SPEC §6.1, UX §2.1, US-004).
 *
 * The screen is complete in the HTML: the empty state, a failed attempt, the
 * throttled state and the SY-2 session-expired banner all render server-side.
 * `client/login.ts` only adds the show/hide toggle and the busy state, so the
 * keyboard order (skip link → Username → Password → show/hide → Sign in) and
 * the error announcement survive with JavaScript disabled.
 *
 * Three copy strings for session expiry exist in UI_SPEC (§6.1 banner, §8.5
 * live alert, §9.5 table). This renderer uses §6.1 verbatim for the visible
 * banner and §8.5 verbatim for the assertive announcement, because the two
 * are different surfaces; the divergence is recorded in the task comment.
 */
import { safeNextPath } from '../auth/guard.js';
import { escapeAttr, escapeHtml } from './html.js';

export const LOGIN_COPY = {
  rejected: 'Wrong username or password',
  throttled: (retryAfterSeconds: number): string =>
    'Too many attempts. Try again in ' + Math.max(1, Math.ceil(retryAfterSeconds)) + ' s.',
  required: 'Sign in to continue.',
  expired: 'Your session expired. Your unsaved draft is preserved.',
  expiredAnnouncement: 'Your session expired. Your draft is preserved. Sign in to continue.',
  subline: 'Private, LAN-only. One operator account.',
  note: 'No registration. No password reset. Access is by the seeded operator account only.',
} as const;

export interface LoginNotice {
  readonly kind: 'required' | 'expired';
  readonly message: string;
  /** Assertive live-region text; only the SY-2 expiry has one (§8.5). */
  readonly announcement?: string;
}

export interface LoginPageModel {
  readonly next?: string;
  readonly username?: string;
  readonly error?: string;
  readonly notice?: LoginNotice;
  /** Focus goes to Password after a failed attempt (§6.1). */
  readonly focus?: 'username' | 'password';
  readonly assets?: {
    readonly stylesHref?: string;
    readonly scriptHref?: string;
  };
}

const DEFAULT_STYLES = '/assets/app.css';
const DEFAULT_SCRIPT = '/assets/client/login.js';

function renderNotice(notice: LoginNotice): string {
  return (
    '<section class="auth-notice" data-kind="' +
    escapeAttr(notice.kind) +
    '" aria-label="' +
    (notice.kind === 'expired' ? 'Session expired' : 'Sign in') +
    '"><p>' +
    escapeHtml(notice.message) +
    '</p></section>'
  );
}

export function renderLoginPage(model: LoginPageModel = {}): string {
  const next = safeNextPath(model.next);
  const username = model.username ?? '';
  const error = model.error;
  const focusPassword = model.focus === 'password';
  const describedBy = error === undefined ? '' : ' aria-describedby="login-error"';
  const invalid = error === undefined ? '' : ' aria-invalid="true"';
  const autofocusUsername = focusPassword ? '' : ' autofocus';
  const autofocusPassword = focusPassword ? ' autofocus' : '';

  const notice = model.notice === undefined ? '' : renderNotice(model.notice);
  const announcement =
    model.notice?.announcement === undefined
      ? ''
      : ' data-message="' + escapeAttr(model.notice.announcement) + '"';

  return (
    '<!doctype html>' +
    '<html lang="en">' +
    '<head>' +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="color-scheme" content="dark">' +
    '<title>Sign in — reels-generator</title>' +
    '<link rel="stylesheet" href="' +
    escapeAttr(model.assets?.stylesHref ?? DEFAULT_STYLES) +
    '">' +
    '</head>' +
    '<body class="auth">' +
    '<a class="skip-link" href="#main">Skip to content</a>' +
    '<main id="main" class="auth-main" tabindex="-1">' +
    notice +
    '<section class="login-card" aria-labelledby="login-wordmark">' +
    '<h1 class="login-wordmark" id="login-wordmark">reels-generator</h1>' +
    '<p class="login-subline">' +
    LOGIN_COPY.subline +
    '</p>' +
    '<form class="login-form" method="post" action="/login" novalidate data-login-form>' +
    '<div class="login-field">' +
    '<label class="login-label" for="username">Username</label>' +
    '<input class="login-input" id="username" name="username" type="text" ' +
    'autocomplete="username" spellcheck="false" autocapitalize="none" required' +
    autofocusUsername +
    describedBy +
    invalid +
    ' value="' +
    escapeAttr(username) +
    '">' +
    '</div>' +
    '<div class="login-field">' +
    '<label class="login-label" for="password">Password</label>' +
    '<div class="login-password">' +
    '<input class="login-input" id="password" name="password" type="password" ' +
    'autocomplete="current-password" required' +
    autofocusPassword +
    describedBy +
    invalid +
    '>' +
    '<button class="login-reveal" type="button" aria-pressed="false" aria-label="Show password" ' +
    'data-reveal="password">Show</button>' +
    '</div>' +
    (error === undefined
      ? ''
      : '<p class="login-error" id="login-error" role="alert">' +
        '<span aria-hidden="true">⚠</span> ' +
        escapeHtml(error) +
        '</p>') +
    '</div>' +
    '<button class="login-submit" id="login-submit" type="submit">' +
    '<span class="spinner" data-spinner hidden aria-hidden="true"></span>' +
    '<span data-submit-label>Sign in</span>' +
    '</button>' +
    '<input type="hidden" name="next" value="' +
    escapeAttr(next) +
    '">' +
    '<p class="login-note">' +
    LOGIN_COPY.note +
    '</p>' +
    '</form>' +
    '</section>' +
    '</main>' +
    '<script type="module" src="' +
    escapeAttr(model.assets?.scriptHref ?? DEFAULT_SCRIPT) +
    '"></script>' +
    '<div id="live-status" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>' +
    '<div id="live-alert" class="sr-only" role="alert" aria-live="assertive" aria-atomic="true"' +
    announcement +
    '></div>' +
    '</body>' +
    '</html>'
  );
}
