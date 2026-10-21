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

import type {
  HealthReportSchema,
  OverviewSchema,
  SessionInfoSchema,
  SeriesDetailSchema,
} from '../../contract/api.js';
import type { Authenticate, AuthOutcome } from './auth/login.js';
import { guardRequest, LOGIN_PATH, safeNextPath } from './auth/guard.js';
import { readSessionToken, serializeSessionCookie, type SessionStore } from './auth/session.js';
import { LOGIN_COPY, renderLoginPage } from './render/login.js';
import { renderNotFoundPage } from './render/notFound.js';
import { renderOverview } from './render/overview.js';
import { renderSeriesEditor } from './render/seriesEditor.js';
import { renderSeriesList } from './render/seriesList.js';
import { buildShellModel, renderShell, type BreadcrumbItem, type NavKey } from './render/shell.js';
import { renderWorkspace } from './render/workspace.js';
import { savedAnnouncement } from './series/commit.js';
import {
  changedFields,
  createReady,
  profileToValues,
  validateSeriesValues,
  valuesFromForm,
} from './series/fields.js';
import {
  SeriesArchivedError,
  SeriesConflictError,
  SeriesSlugTakenError,
  type SeriesGateway,
} from './series/gateway.js';
import { loadSeriesRows, type SeriesEditorModel } from './series/model.js';
import { APP_CSS } from './styles/embedded.js';
import type { VideoGateway } from './workspace/gateway.js';

import { StageCodeSchema, UuidSchema } from '../../contract/api.js';
import type { StageCode } from '../shared/stages.js';
import type { OpsGateway, ProviderSettingsView } from './health/gateway.js';
import { ATTEMPT_PAGE_SIZE, attemptsView, healthSummary, providerRows } from './health/model.js';
import type { AttemptRow } from './health/model.js';
import { ExportRefusedError, type ExportGateway } from './provenance/gateway.js';
import { exportNotice, type ExportNotice } from './provenance/notice.js';
import type { ExportView } from './provenance/model.js';
import { renderExportPanel } from './render/export.js';
import { renderHealthPage } from './render/health.js';
import { escapeHtml } from './render/html.js';
import { renderSettings } from './render/settings.js';
import { degradedNotices } from './render/shell.js';
import { settingsModel } from './settings/model.js';
import { isTabKey, tabKeyForStage, type TabKey } from './workspace/model.js';

type Overview = z.infer<typeof OverviewSchema>;
type HealthReport = z.infer<typeof HealthReportSchema>;
type SessionInfo = z.infer<typeof SessionInfoSchema>;
type SeriesDetail = z.infer<typeof SeriesDetailSchema>;

export interface WebAppDependencies {
  readonly sessions: SessionStore;
  readonly authenticate: Authenticate;
  readonly overview: Overview;
  readonly health?: HealthReport;
  readonly now?: () => number;
  /** B-13's synchroniser token (contract `SessionInfo.csrf_token`). */
  readonly csrfToken?: () => string;
  /** S-03/S-04 storage. Absent builds answer 503 rather than inventing data. */
  readonly series?: SeriesGateway;
  /** S-09…S-16 storage. Absent builds answer 503 rather than inventing data. */
  readonly video?: VideoGateway;
  /** S-16 export package and per-stage pins. Absent builds keep the F-04 summary. */
  readonly exportPackage?: ExportGateway;
  /** S-19/S-21 health, provider settings and attempt rows. Absent builds answer 503. */
  readonly ops?: OpsGateway;
  readonly assets?: {
    readonly css?: string;
    /** Returns browser ESM for a client module name, or null when absent. */
    readonly readClientModule?: (name: string) => string | null;
    /**
     * Returns browser ESM for a module the client enhancers import from
     * `src/web` (e.g. `series/commit.js`), or null when absent. INT-01's dist
     * reader serves the built `dist/src/web/<path>` file.
     */
    readonly readSharedModule?: (path: string) => string | null;
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
  "connect-src 'self'; base-uri 'none'; form-action 'self'";

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

/** A series profile is a few dozen short fields; 64 KiB is generous. */
const MAX_FORM_BODY_CHARS = 65_536;

const SLUG_TAKEN_MESSAGE = 'That slug is already used by another series.';
const SAVE_FAILED_MESSAGE = 'The series could not be saved. Nothing was changed.';
const CREATE_FAILED_MESSAGE = 'The series could not be created. Nothing was saved.';

/** Loaded after the shell module on both S-04 pages. */
const SERIES_SCRIPTS: readonly string[] = ['/assets/client/series-editor.js'];

/** Client module names are identifiers we ship, never a path from the wire. */
const CLIENT_MODULE_NAME = /^[a-z0-9-]+$/;
const SHARED_MODULE_NAME = /^[a-z0-9-]+$/;

/** Browser-safe modules the enhancers import, served from the same sources. */
const SHARED_MODULE_ROOTS: readonly string[] = [
  '/assets/format.js',
  '/assets/series/',
  '/assets/workspace/',
  '/assets/shared/',
];

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

export function createWebApp(
  deps: WebAppDependencies,
): (request: WebRequest) => Promise<WebResponse> {
  const now = deps.now ?? ((): number => Date.now());
  const css = deps.assets?.css ?? APP_CSS;
  const readClientModule = deps.assets?.readClientModule ?? ((): string | null => null);
  const readSharedModule = deps.assets?.readSharedModule ?? ((): string | null => null);
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
    // The client enhancers import the shared rules they must not fork (F-03,
    // F-04). The name is an identifier from a fixed set, never a path from the
    // wire: one or two segments, lower-case and hyphens only.
    if (SHARED_MODULE_ROOTS.some((root) => pathname === root || pathname.startsWith(root))) {
      if (effective !== 'GET') return methodNotAllowed('GET, HEAD');
      const shared =
        pathname === '/assets/format.js' ? 'format.js' : pathname.slice('/assets/'.length);
      if (!shared.endsWith('.js')) return json(404, 'not_found', 'No shared module ' + shared);
      const segments = shared.slice(0, -'.js'.length).split('/');
      if (segments.length === 0 || segments.length > 2) {
        return json(404, 'not_found', 'No shared module ' + shared);
      }
      if (!segments.every((segment) => SHARED_MODULE_NAME.test(segment))) {
        return json(404, 'not_found', 'No shared module ' + shared);
      }
      const source = readSharedModule(shared);
      return source === null
        ? json(404, 'not_found', 'No shared module ' + shared)
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

    if (pathname === '/series' || pathname.startsWith('/series/')) {
      return seriesRoutes({
        effective,
        pathname,
        search: target.searchParams,
        body: input.body,
        session: sessionInfo(record),
      });
    }

    if (pathname === '/videos' || pathname.startsWith('/videos/')) {
      if (effective !== 'GET' && effective !== 'POST') {
        return methodNotAllowed('GET, HEAD, POST');
      }
      return videoRoutes({
        method: effective,
        pathname,
        search: target.searchParams,
        body: input.body,
        session: sessionInfo(record),
      });
    }

    if (pathname === '/health') {
      if (effective !== 'GET') return methodNotAllowed('GET, HEAD');
      return healthPage({ search: target.searchParams, session: sessionInfo(record) });
    }

    if (pathname === '/settings') {
      if (effective !== 'GET') return methodNotAllowed('GET, HEAD');
      return settingsPage(sessionInfo(record));
    }

    if (effective !== 'GET') return methodNotAllowed('GET, HEAD');

    if (pathname === '/') return overviewPage(sessionInfo(record));

    // Any route this card does not own: an authenticated 404, still inside the
    // app's own chrome-free system surface (SY-3). Unauthenticated requests
    // never reach here — the guard sent them to /login.
    return html(renderNotFoundPage({ variant: 'not_found' }), 404);
  }

  // ── S-03 / S-04 (US-008, US-010, R-001, R-002) ───────────────────────────

  // ── S-02 Overview (W-01, IP-05) ──────────────────────────────────────────

  async function overviewPage(session: SessionInfo): Promise<WebResponse> {
    const overview = deps.overview;
    const empty =
      overview.attention.length === 0 &&
      overview.batches.length === 0 &&
      overview.counts.running === 0 &&
      overview.counts.complete === 0;
    // The first-run copy names "no series" only when that is what the series
    // store says — otherwise the honest line is "no batches yet".
    let seriesCount: number | null = null;
    if (empty && deps.series !== undefined) {
      try {
        seriesCount = (await deps.series.list()).length;
      } catch {
        seriesCount = null;
      }
    }
    const content = renderOverview({
      state: empty ? 'empty' : 'ready',
      overview,
      now: now(),
      seriesCount,
    });
    return html(
      page({
        title: 'Overview',
        nav: 'overview',
        breadcrumbs: [{ label: 'Overview' }],
        content,
        session,
        scripts: ['/assets/client/workspace.js'],
      }),
    );
  }

  // ── S-09…S-16 video workspace shell (W-04, IP-03) ───────────────────────

  async function videoRoutes(input: {
    readonly method: string;
    readonly pathname: string;
    readonly search: URLSearchParams;
    readonly body: string;
    readonly session: SessionInfo;
  }): Promise<WebResponse> {
    const gateway = deps.video;
    if (gateway === undefined) return json(503, 'not_ready', 'Video workspace is not mounted');

    const segments = input.pathname.slice('/videos/'.length).split('/');
    if (segments.length > 2) return html(renderNotFoundPage({ variant: 'not_found' }), 404);
    const rawId = segments[0];
    if (rawId === undefined || rawId.length === 0) {
      return html(renderNotFoundPage({ variant: 'not_found' }), 404);
    }

    let videoId: string;
    let rawTab: string | undefined;
    try {
      videoId = decodeURIComponent(rawId);
      const second = segments[1];
      rawTab = second === undefined ? undefined : decodeURIComponent(second);
    } catch {
      return json(400, 'validation_failed', 'Malformed video path');
    }

    const isExportBuild = input.method === 'POST' && rawTab === 'export';
    if (rawTab !== undefined && !isTabKey(rawTab)) {
      return html(renderNotFoundPage({ variant: 'not_found' }), 404);
    }
    if (input.method !== 'GET' && !isExportBuild) return methodNotAllowed('GET, HEAD, POST');

    let detail;
    try {
      detail = await gateway.get(videoId);
    } catch {
      return json(503, 'not_ready', 'The video workspace is unavailable');
    }
    if (detail === null) return html(renderNotFoundPage({ variant: 'not_found' }), 404);
    const video = detail;
    const base = '/videos/' + encodeURIComponent(videoId);

    function workspacePage(view: {
      readonly tab: TabKey;
      readonly panel?: string;
      readonly scripts?: readonly string[];
      readonly status?: number;
    }): WebResponse {
      const parts = renderWorkspace(video, view.tab, {
        ...(view.panel === undefined ? {} : { panel: view.panel }),
        ...(view.scripts === undefined ? {} : { scripts: view.scripts }),
      });
      return html(
        page({
          title: video.series_name + ' · video ' + (video.position_in_batch + 1),
          nav: null,
          breadcrumbs: [
            { label: 'Overview', href: '/' },
            { label: video.series_name, href: '/series/' + encodeURIComponent(video.series_id) },
            { label: 'Video ' + (video.position_in_batch + 1) },
          ],
          content: parts.content,
          titleAside: parts.titleAside,
          footer: parts.footer,
          session: input.session,
          scripts: parts.scripts,
        }),
        view.status ?? 200,
      );
    }

    // ── S-16 export & provenance (US-026, R-014-1, R-002-4) ────────────────
    async function exportPage(pageInput: {
      readonly exports: ExportGateway;
      readonly notice?: ExportNotice | null;
      readonly status?: number;
      readonly failed?: boolean;
    }): Promise<WebResponse> {
      let view: ExportView | null = null;
      let failed = pageInput.failed ?? false;
      if (!failed) {
        try {
          view = await pageInput.exports.get(videoId);
        } catch {
          failed = true;
        }
      }
      const notice: ExportNotice | null = failed
        ? {
            kind: 'error',
            message:
              'The export could not be loaded. The rest of the workspace is unaffected; nothing was changed.',
          }
        : (pageInput.notice ?? null);
      return workspacePage({
        tab: 'export',
        ...(failed
          ? { status: 503 }
          : pageInput.status === undefined
            ? {}
            : { status: pageInput.status }),
        panel: renderExportPanel({
          detail: video,
          view,
          buildWired: pageInput.exports.build !== undefined,
          ...(notice === null ? {} : { notice }),
        }),
      });
    }

    if (isExportBuild) {
      const exports = deps.exportPackage;
      if (exports === undefined) {
        return json(503, 'not_ready', 'The export surfaces are not mounted');
      }
      if (exports.build === undefined) {
        return json(503, 'not_ready', 'The package build is not mounted');
      }
      try {
        await exports.build(videoId);
      } catch (error) {
        const refused = error instanceof ExportRefusedError;
        const message = error instanceof Error ? error.message : 'unknown error';
        return exportPage({
          exports,
          status: refused ? 409 : 503,
          notice: {
            kind: 'error',
            message: refused ? message : 'The package could not be built. Nothing was downloaded.',
          },
        });
      }
      return redirect(base + '/export?notice=built');
    }

    // No tab in the URL: open the tab that holds the stage needing attention.
    const tab: TabKey =
      rawTab !== undefined && isTabKey(rawTab) ? rawTab : tabKeyForStage(video.current_stage);

    // S-16 owns the export tab. Without an export gateway the F-04 stage
    // summary stays in place — an honest fallback, never an invented package.
    if (tab === 'export' && deps.exportPackage !== undefined) {
      return exportPage({
        exports: deps.exportPackage,
        notice: exportNotice(input.search.get('notice')),
      });
    }

    return workspacePage({ tab });
  }

  // ── S-19 failures & health, S-21 settings (US-003, US-011/012/013) ───────

  function unavailablePage(input: {
    readonly title: string;
    readonly nav: NavKey;
    readonly message: string;
    readonly session: SessionInfo;
  }): WebResponse {
    return html(
      page({
        title: input.title,
        nav: input.nav,
        breadcrumbs: [{ label: 'Overview', href: '/' }, { label: input.title }],
        content:
          '<section class="ops-unavailable" role="status"><h2>' +
          escapeHtml(input.title) +
          ' is not available</h2><p>' +
          escapeHtml(input.message) +
          '</p></section>',
        session: input.session,
      }),
      503,
    );
  }

  async function healthPage(input: {
    readonly search: URLSearchParams;
    readonly session: SessionInfo;
  }): Promise<WebResponse> {
    const ops = deps.ops;
    if (ops === undefined) {
      return unavailablePage({
        title: 'Health',
        nav: 'health',
        message: 'Health data is not mounted in this deployment.',
        session: input.session,
      });
    }

    let report: HealthReport;
    try {
      report = await ops.health();
    } catch {
      return unavailablePage({
        title: 'Health',
        nav: 'health',
        message: 'The health report could not be loaded. Nothing was changed.',
        session: input.session,
      });
    }

    const rawVideo = input.search.get('video');
    const selectedVideo: string | null =
      rawVideo !== null && UuidSchema.safeParse(rawVideo).success ? rawVideo : null;
    const videoLabel =
      selectedVideo === null
        ? null
        : (deps.overview.attention.find((item) => item.video_id === selectedVideo)?.video_label ??
          null);

    const rawStage = input.search.get('stage');
    const parsedStage =
      rawStage === null || rawStage.length === 0 ? null : StageCodeSchema.safeParse(rawStage);
    const stage: StageCode | null =
      parsedStage !== null && parsedStage.success ? parsedStage.data : null;

    let rows: AttemptRow[] | null = null;
    let error = false;
    if (selectedVideo !== null) {
      try {
        rows = await ops.attempts(selectedVideo, { stage, limit: ATTEMPT_PAGE_SIZE });
      } catch {
        error = true;
      }
    }

    const content = renderHealthPage({
      summary: healthSummary(report),
      degraded: degradedNotices(deps.overview, report),
      overview: deps.overview,
      attempts: attemptsView({
        videoId: selectedVideo,
        videoLabel,
        stage,
        rows,
        now: now(),
        error,
      }),
      now: now(),
    });

    return html(
      page({
        title: 'Health',
        nav: 'health',
        breadcrumbs: [{ label: 'Overview', href: '/' }, { label: 'Health' }],
        content,
        session: input.session,
        health: report,
      }),
    );
  }

  async function settingsPage(session: SessionInfo): Promise<WebResponse> {
    const ops = deps.ops;
    if (ops === undefined) {
      return unavailablePage({
        title: 'Settings',
        nav: 'settings',
        message: 'Provider settings are not mounted in this deployment.',
        session,
      });
    }

    let view: ProviderSettingsView;
    try {
      view = await ops.settings();
    } catch {
      return unavailablePage({
        title: 'Settings',
        nav: 'settings',
        message: 'The provider key status could not be loaded. Nothing was changed.',
        session,
      });
    }

    return html(
      page({
        title: 'Settings',
        nav: 'settings',
        breadcrumbs: [{ label: 'Overview', href: '/' }, { label: 'Settings' }],
        content: renderSettings(
          settingsModel({ providers: view, rows: providerRows(view.providers) }),
        ),
        session,
      }),
    );
  }
  function page(input: {
    readonly title: string;
    readonly nav: NavKey | null;
    readonly breadcrumbs: readonly BreadcrumbItem[];
    readonly content: string;
    /** Trusted HTML rendered on the right of the `<h1>` row (the workspace chip). */
    readonly titleAside?: string;
    /** Trusted HTML for the sticky workspace footer (pins, target, scenes). */
    readonly footer?: string;
    readonly aside?: { readonly label: string; readonly content: string };
    readonly session: SessionInfo;
    readonly scripts?: readonly string[];
    readonly liveStatus?: string;
    /** A report fetched for this page, so the status strip and the page agree. */
    readonly health?: HealthReport;
  }): string {
    const assets =
      input.scripts === undefined
        ? undefined
        : { scriptHref: '/assets/client/shell.js', extraScripts: input.scripts };
    return renderShell(
      buildShellModel({
        title: input.title,
        nav: input.nav,
        overview: deps.overview,
        ...((input.health ?? deps.health) === undefined
          ? {}
          : { health: input.health ?? deps.health }),
        session: input.session,
        breadcrumbs: input.breadcrumbs,
        content: input.content,
        ...(input.titleAside === undefined ? {} : { titleAside: input.titleAside }),
        ...(input.footer === undefined ? {} : { footer: input.footer }),
        ...(input.aside === undefined ? {} : { aside: input.aside }),
        ...(assets === undefined ? {} : { assets }),
        ...(input.liveStatus === undefined ? {} : { liveStatus: input.liveStatus }),
        ...(input.nav === 'health' ? { showDegradedBanner: false } : {}),
        now: now(),
      }),
    );
  }

  function seriesError(session: SessionInfo): WebResponse {
    return html(
      page({
        title: 'Series',
        nav: 'series',
        breadcrumbs: [{ label: 'Overview', href: '/' }, { label: 'Series' }],
        content: renderSeriesList({ state: 'error', rows: [], now: now() }),
        session,
      }),
      503,
    );
  }

  function initialValuesFor(detail: SeriesDetail): Record<string, string> {
    return { ...profileToValues(detail.profile), name: detail.name, slug: detail.slug };
  }

  async function editModel(
    gateway: SeriesGateway,
    detail: SeriesDetail,
    input: {
      readonly values?: Record<string, string>;
      readonly errors?: Readonly<Record<string, string>>;
      readonly conflict?: SeriesEditorModel['conflict'];
      readonly savedVersion?: number;
      readonly unchanged?: boolean;
      readonly saveError?: string;
    },
  ): Promise<SeriesEditorModel> {
    const initial = initialValuesFor(detail);
    const values = input.values ?? initial;
    const inFlightVideos =
      gateway.inFlightVideos === undefined ? null : await gateway.inFlightVideos(detail.id);
    return {
      mode: 'edit',
      status: detail.status,
      detail,
      values,
      initial,
      changed: changedFields(initial, values),
      errors: input.errors ?? {},
      ...(input.conflict === undefined ? {} : { conflict: input.conflict }),
      ...(input.savedVersion === undefined ? {} : { savedVersion: input.savedVersion }),
      ...(input.unchanged === undefined ? {} : { unchanged: input.unchanged }),
      ...(input.saveError === undefined ? {} : { saveError: input.saveError }),
      inFlightBatches: detail.in_flight_batches,
      inFlightVideos,
    };
  }

  async function renderEditPage(
    gateway: SeriesGateway,
    seriesId: string,
    input: {
      readonly session: SessionInfo;
      readonly values?: Record<string, string>;
      readonly errors?: Readonly<Record<string, string>>;
      readonly conflict?: SeriesEditorModel['conflict'];
      readonly savedVersion?: number;
      readonly unchanged?: boolean;
      readonly saveError?: string;
      readonly status?: number;
    },
  ): Promise<WebResponse> {
    let detail: SeriesDetail | null;
    try {
      detail = await gateway.get(seriesId);
    } catch {
      return json(503, 'not_ready', 'Series storage is unavailable');
    }
    if (detail === null) return html(renderNotFoundPage({ variant: 'not_found' }), 404);

    const model = await editModel(gateway, detail, input);
    const parts = renderSeriesEditor(model);
    const body = page({
      title: detail.name,
      nav: 'series',
      breadcrumbs: [
        { label: 'Overview', href: '/' },
        { label: 'Series', href: '/series' },
        { label: detail.name },
      ],
      content: parts.main,
      aside: { label: 'Version commit', content: parts.aside },
      session: input.session,
      scripts: SERIES_SCRIPTS,
      ...(model.savedVersion === undefined || model.savedVersion !== model.detail?.current_version
        ? {}
        : {
            liveStatus: savedAnnouncement({
              version: model.savedVersion,
              inFlightBatches: model.inFlightBatches ?? null,
              inFlightVideos: model.inFlightVideos ?? null,
            }),
          }),
    });
    return html(body, input.status ?? 200);
  }

  function createEditorModel(input: {
    readonly values?: Record<string, string>;
    readonly errors?: Readonly<Record<string, string>>;
    readonly saveError?: string;
  }): SeriesEditorModel {
    const initial = valuesFromForm({});
    const values = input.values ?? initial;
    return {
      mode: 'create',
      status: 'active',
      values,
      initial,
      changed: [],
      errors: input.errors ?? {},
      createReady: createReady(values),
      inFlightBatches: 0,
      ...(input.saveError === undefined ? {} : { saveError: input.saveError }),
    };
  }

  function renderCreatePage(input: {
    readonly session: SessionInfo;
    readonly values?: Record<string, string>;
    readonly errors?: Readonly<Record<string, string>>;
    readonly saveError?: string;
    readonly status?: number;
  }): WebResponse {
    const model = createEditorModel(input);
    const parts = renderSeriesEditor(model);
    return html(
      page({
        title: 'New series',
        nav: 'series',
        breadcrumbs: [
          { label: 'Overview', href: '/' },
          { label: 'Series', href: '/series' },
          { label: 'New series' },
        ],
        content: parts.main,
        aside: { label: 'Version commit', content: parts.aside },
        session: input.session,
        scripts: SERIES_SCRIPTS,
      }),
      input.status ?? 200,
    );
  }

  async function createSeries(
    gateway: SeriesGateway,
    body: string,
    session: SessionInfo,
  ): Promise<WebResponse> {
    if (body.length > MAX_FORM_BODY_CHARS) {
      return json(400, 'validation_failed', 'Series request is too large');
    }
    const values = valuesFromForm(parseFormEncoded(body));
    const validation = validateSeriesValues(values, 'create', null);
    if (validation.profile === null) {
      return renderCreatePage({ session, values, errors: validation.errors, status: 422 });
    }

    try {
      const created = await gateway.create({
        name: (values['name'] ?? '').trim(),
        slug: (values['slug'] ?? '').trim(),
        profile: validation.profile,
      });
      return redirect('/series/' + encodeURIComponent(created.id) + '?saved=1');
    } catch (error) {
      if (error instanceof SeriesSlugTakenError) {
        return renderCreatePage({
          session,
          values,
          errors: { slug: SLUG_TAKEN_MESSAGE },
          status: 422,
        });
      }
      return renderCreatePage({ session, values, saveError: CREATE_FAILED_MESSAGE, status: 503 });
    }
  }

  async function saveSeries(
    gateway: SeriesGateway,
    seriesId: string,
    body: string,
    session: SessionInfo,
  ): Promise<WebResponse> {
    if (body.length > MAX_FORM_BODY_CHARS) {
      return json(400, 'validation_failed', 'Series request is too large');
    }

    let detail: SeriesDetail | null;
    try {
      detail = await gateway.get(seriesId);
    } catch {
      return json(503, 'not_ready', 'Series storage is unavailable');
    }
    if (detail === null) return html(renderNotFoundPage({ variant: 'not_found' }), 404);

    // R-001-3: an archived series is read-only; the page states the reason.
    if (detail.status === 'archived') {
      return renderEditPage(gateway, seriesId, { session, status: 409 });
    }

    const form = parseFormEncoded(body);
    const values = valuesFromForm(form);
    const validation = validateSeriesValues(values, 'edit', detail.profile);
    if (validation.profile === null) {
      return renderEditPage(gateway, seriesId, {
        session,
        values,
        errors: validation.errors,
        status: 422,
      });
    }

    const initial = initialValuesFor(detail);
    if (changedFields(initial, values).length === 0) {
      // Not an edit, so no version is minted (R-002-1).
      return redirect('/series/' + encodeURIComponent(seriesId) + '?unchanged=1');
    }

    const revision = Number(form['revision'] ?? '');
    try {
      const updated = await gateway.update(seriesId, {
        revision: Number.isFinite(revision) ? revision : 0,
        name: (values['name'] ?? '').trim(),
        profile: validation.profile,
      });
      return redirect(
        '/series/' + encodeURIComponent(seriesId) + '?saved=' + updated.current_version,
      );
    } catch (error) {
      if (error instanceof SeriesConflictError) {
        return renderEditPage(gateway, seriesId, {
          session,
          values,
          status: 409,
          conflict: {
            currentRevision: error.currentRevision,
            yourRevision: Number.isFinite(revision) ? revision : 0,
            currentVersion: error.currentVersion,
            savedAt: error.savedAt,
          },
        });
      }
      if (error instanceof SeriesArchivedError) {
        return renderEditPage(gateway, seriesId, { session, status: 409 });
      }
      return renderEditPage(gateway, seriesId, {
        session,
        values,
        saveError: SAVE_FAILED_MESSAGE,
        status: 503,
      });
    }
  }

  async function seriesRoutes(input: {
    readonly effective: string;
    readonly pathname: string;
    readonly search: URLSearchParams;
    readonly body: string;
    readonly session: SessionInfo;
  }): Promise<WebResponse> {
    const gateway = deps.series;
    if (gateway === undefined) return json(503, 'not_ready', 'Series storage is not mounted');

    const { effective, pathname, body, session } = input;

    if (pathname === '/series') {
      if (effective === 'GET') {
        try {
          const rows = await loadSeriesRows(gateway);
          return html(
            page({
              title: 'Series',
              nav: 'series',
              breadcrumbs: [{ label: 'Overview', href: '/' }, { label: 'Series' }],
              content: renderSeriesList({
                state: rows.length === 0 ? 'empty' : 'ready',
                rows,
                now: now(),
              }),
              session,
            }),
          );
        } catch {
          return seriesError(session);
        }
      }
      return methodNotAllowed('GET, HEAD');
    }

    if (pathname === '/series/new') {
      if (effective === 'GET') return renderCreatePage({ session });
      if (effective === 'POST') return createSeries(gateway, body, session);
      return methodNotAllowed('GET, HEAD, POST');
    }

    const seriesId = pathname.slice('/series/'.length);
    if (seriesId.length === 0 || seriesId.includes('/')) {
      return html(renderNotFoundPage({ variant: 'not_found' }), 404);
    }
    if (effective === 'GET') {
      const savedRaw = input.search.get('saved');
      const saved = savedRaw === null ? Number.NaN : Number(savedRaw);
      const unchanged = input.search.get('unchanged') === '1';
      return renderEditPage(gateway, seriesId, {
        session,
        ...(Number.isFinite(saved) ? { savedVersion: saved } : {}),
        ...(unchanged ? { unchanged: true } : {}),
      });
    }
    if (effective === 'POST') return saveSeries(gateway, seriesId, body, session);
    return methodNotAllowed('GET, HEAD, POST');
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
