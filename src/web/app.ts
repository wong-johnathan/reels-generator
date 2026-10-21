/**
 * F-02 web application: S-01 Login, SY-2 session expired and SY-3 not-found,
 * plus the route guard that protects every other HTML route (R-015-4).
 *
 * The handler takes a complete request object and returns a complete response,
 * so it is testable without a socket and mountable in the production entrypoint
 * by INT-01. Dependencies are injected:
 *
 *   - `sessions`    — B-13's Postgres-backed store, or the in-memory one the
 *                     preview and the tests use;
 *   - `authenticate`— B-13's argon2id check and login backoff.
 *
 * No provider, database or network call is made here, and the handler holds no
 * global state: two requests only share what the injected store shares.
 */
import type { z } from 'zod';

import type { HealthReportSchema, OverviewSchema, SessionInfoSchema } from '../../contract/api.js';
import type { Authenticate, AuthOutcome } from './auth/login.js';
import { guardRequest, LOGIN_PATH, safeNextPath } from './auth/guard.js';
import { readSessionToken, serializeSessionCookie, type SessionStore } from './auth/session.js';
import { escapeHtml } from './render/html.js';
import { LOGIN_COPY, renderLoginPage } from './render/login.js';
import { renderNotFoundPage } from './render/notFound.js';
import { buildShellModel, renderShell } from './render/shell.js';
import { APP_CSS } from './styles/embedded.js';

type Overview = z.infer<typeof OverviewSchema>;
type HealthReport = z.infer<typeof HealthReportSchema>;
type SessionInfo = z.infer<typeof SessionInfoSchema>;

export interface WebAppDependencies {
  readonly sessions: SessionStore;
  readonly authenticate: Authenticate;
  readonly overview: Overview;
  readonly health?: HealthReport;
  readonly now?: () => number;
  /** B-13's synchroniser token (contract `SessionInfo.csrf_token`). */
  readonly csrfToken?: () => string;
  readonly assets?: {
    readonly css?: string;
    /** Returns browser ESM for a client module name, or null when absent. */
    readonly readClientModule?: (name: string) => string | null;
  };
}

export interface WebRequest {
  readonly method: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly body?: string;
}

export interface WebResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

const CSP =
  "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; " +
  "base-uri 'none'; form-action 'self'";

const HTML_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cache-control': 'no-store',
};

const CSS_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/css; charset=utf-8',
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
};

const JS_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/javascript; charset=utf-8',
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
};

const NO_STORE = { 'cache-control': 'no-store' } as const;

/** A login body is two short fields; anything larger is not a browser form. */
const MAX_LOGIN_BODY_CHARS = 4096;

/** Client module names are identifiers we ship, never a path from the wire. */
const CLIENT_MODULE_NAME = /^[a-z0-9-]+$/;

function headerValue(
  headers: Readonly<Record<string, string | undefined>> | undefined,
  name: string,
): string | undefined {
  if (headers === undefined) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

function parseTarget(url: string): URL | null {
  try {
    return new URL(url, 'http://web.local');
  } catch {
    return null;
  }
}

function html(body: string, status = 200): WebResponse {
  return { status, headers: { ...HTML_HEADERS }, body };
}

function redirect(location: string, extra: Readonly<Record<string, string>> = {}): WebResponse {
  return { status: 303, headers: { location, ...NO_STORE, ...extra }, body: '' };
}

function json(status: number, code: string, message: string): WebResponse {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...NO_STORE },
    body: JSON.stringify({ error: { code, message } }),
  };
}

function methodNotAllowed(allow: string): WebResponse {
  return {
    status: 405,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      allow,
      ...NO_STORE,
    },
    body: JSON.stringify({ error: { code: 'method_not_allowed', message: 'Allowed: ' + allow } }),
  };
}

export function parseFormEncoded(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(body)) {
    if (!(key in fields)) fields[key] = value;
  }
  return fields;
}

/** The Overview surface is F-04's; this is its named slot, not invented data. */
function overviewPlaceholder(operator: string): string {
  return (
    '<section aria-labelledby="overview-region">' +
    '<h2 id="overview-region">Attention</h2>' +
    '<p>Signed in as <span class="mono">' +
    escapeHtml(operator) +
    '</span>. The attention list and batch views arrive with F-04; this region is the ' +
    'post-sign-in landing slot.</p>' +
    '</section>'
  );
}

export function createWebApp(
  deps: WebAppDependencies,
): (request: WebRequest) => Promise<WebResponse> {
  const now = deps.now ?? ((): number => Date.now());
  const css = deps.assets?.css ?? APP_CSS;
  const readClientModule = deps.assets?.readClientModule ?? ((): string | null => null);
  const csrfToken = deps.csrfToken ?? ((): string => '');

  return async function handle(request: WebRequest): Promise<WebResponse> {
    const method = request.method.toUpperCase();
    const target = parseTarget(request.url);
    if (target === null) return json(400, 'validation_failed', 'Malformed request URL');

    const pathname = target.pathname;
    const path = pathname + target.search;
    const cookieHeader = headerValue(request.headers, 'cookie');
    const token = readSessionToken(cookieHeader);
    const record = token === null ? null : deps.sessions.read(token, now());

    const decision = guardRequest({
      path,
      validSession: record !== null,
      presentedToken: token !== null,
    });
    if (decision.kind === 'redirect') return redirect(decision.location);

    const isHead = method === 'HEAD';
    const effective = isHead ? 'GET' : method;
    const response = await route({
      effective,
      pathname,
      target,
      record,
      body: request.body ?? '',
    });
    return isHead ? { ...response, body: '' } : response;
  };

  async function route(input: {
    readonly effective: string;
    readonly pathname: string;
    readonly target: URL;
    readonly record: { readonly operator: string; readonly expiresAt: number } | null;
    readonly body: string;
  }): Promise<WebResponse> {
    const { effective, pathname, target, record } = input;

    // Static assets the login page itself needs — public by construction.
    if (pathname === '/assets/app.css') {
      return { status: 200, headers: { ...CSS_HEADERS }, body: css };
    }
    if (pathname.startsWith('/assets/client/')) {
      if (effective !== 'GET') return methodNotAllowed('GET, HEAD');
      const file = pathname.slice('/assets/client/'.length);
      const name = file.endsWith('.js') ? file.slice(0, -'.js'.length) : '';
      if (!CLIENT_MODULE_NAME.test(name)) {
        return json(404, 'not_found', 'No client module ' + file);
      }
      const source = readClientModule(name);
      return source === null
        ? json(404, 'not_found', 'No client module ' + name)
        : { status: 200, headers: { ...JS_HEADERS }, body: source };
    }

    if (pathname === LOGIN_PATH) {
      if (effective === 'GET') {
        if (record !== null) {
          return redirect(safeNextPath(target.searchParams.get('next')));
        }
        const expired = target.searchParams.get('expired') === '1';
        const required = target.searchParams.get('required') === '1';
        return html(
          renderLoginPage({
            next: target.searchParams.get('next') ?? undefined,
            ...(expired
              ? {
                  notice: {
                    kind: 'expired' as const,
                    message: LOGIN_COPY.expired,
                    announcement: LOGIN_COPY.expiredAnnouncement,
                  },
                }
              : required
                ? { notice: { kind: 'required' as const, message: LOGIN_COPY.required } }
                : {}),
          }),
        );
      }
      if (effective === 'POST') return signIn(input.body);
      return methodNotAllowed('GET, HEAD, POST');
    }

    if (effective !== 'GET') return methodNotAllowed('GET, HEAD');

    if (pathname === '/') {
      const session = sessionInfo(record);
      return html(
        renderShell(
          buildShellModel({
            title: 'Overview',
            nav: 'overview',
            overview: deps.overview,
            ...(deps.health === undefined ? {} : { health: deps.health }),
            session,
            breadcrumbs: [{ label: 'Overview' }],
            content: overviewPlaceholder(record?.operator ?? ''),
            now: now(),
          }),
        ),
      );
    }

    // Any route this card does not own: an authenticated 404, still inside the
    // app's own chrome-free system surface (SY-3). Unauthenticated requests
    // never reach here — the guard sent them to /login.
    return html(renderNotFoundPage({ variant: 'not_found' }), 404);
  }

  function sessionInfo(
    record: { readonly operator: string; readonly expiresAt: number } | null,
  ): SessionInfo {
    return {
      authenticated: record !== null,
      username: record?.operator ?? null,
      csrf_token: csrfToken(),
      expires_at: record === null ? null : new Date(record.expiresAt).toISOString(),
    };
  }

  async function signIn(body: string): Promise<WebResponse> {
    if (body.length > MAX_LOGIN_BODY_CHARS) {
      return json(400, 'validation_failed', 'Sign-in request is too large');
    }
    const fields = parseFormEncoded(body);
    const username = fields.username ?? '';
    const password = fields.password ?? '';
    const next = safeNextPath(fields.next);

    const outcome: AuthOutcome = await deps.authenticate({ username, password });

    switch (outcome.kind) {
      case 'authenticated': {
        const created = deps.sessions.create(outcome.username, now());
        return redirect(next, { 'set-cookie': serializeSessionCookie(created.token) });
      }
      case 'rejected':
        return html(
          renderLoginPage({
            next,
            username,
            error: LOGIN_COPY.rejected,
            focus: 'password',
          }),
          401,
        );
      case 'throttled':
        return {
          status: 429,
          headers: {
            ...HTML_HEADERS,
            'retry-after': String(Math.max(1, Math.ceil(outcome.retryAfterSeconds))),
          },
          body: renderLoginPage({
            next,
            username,
            error: LOGIN_COPY.throttled(outcome.retryAfterSeconds),
            focus: 'password',
          }),
        };
      default: {
        const unhandled: never = outcome;
        throw new Error('Unhandled auth outcome: ' + JSON.stringify(unhandled));
      }
    }
  }
}

/** Guard helpers, re-exported so the production mount and tests share one list. */
export { buildLoginLocation, isPublicPath, LOGIN_PATH, safeNextPath } from './auth/guard.js';
