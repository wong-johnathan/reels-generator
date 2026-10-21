/**
 * F-01 preview — the shell and its token layer rendered from the frozen
 * contract fixtures (LEAD_PLAN §6). Development/demo surface only: it is not
 * the production entrypoint and makes no network, database or provider call.
 *
 *   npx tsx src/web/preview.ts        # http://127.0.0.1:4020/
 *
 * Signals served: `/` (overview shell), `/workspace` (workspace shell with the
 * aside and footer slots), `/assets/app.css`, `/assets/client/shell.js`.
 */
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';

import * as ts from 'typescript';

import { HealthReportSchema, OverviewSchema, SessionInfoSchema } from '../../contract/api.js';
import { FIXTURES } from '../../contract/mock/fixtures.js';
import { escapeHtml } from './render/html.js';
import { buildShellModel, renderShell, type ShellInput } from './render/shell.js';
import { APP_CSS } from './styles/embedded.js';

export interface PreviewRequest {
  readonly method: string;
  readonly url: string;
}

export interface PreviewResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface PreviewOptions {
  /** Fixed clock for reproducible snapshots and tests. */
  readonly now?: number;
}

const CSP =
  "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; " +
  "base-uri 'none'; form-action 'self'";

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cache-control': 'no-store',
} as const;

const CSS_HEADERS = {
  'content-type': 'text/css; charset=utf-8',
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
} as const;

const JS_HEADERS = {
  'content-type': 'text/javascript; charset=utf-8',
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
} as const;

const CLIENT_MODULES = new Set(['shell', 'behaviours']);

function json(status: number, body: unknown): PreviewResponse {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    body: JSON.stringify(body),
  };
}

function clientModule(name: string): PreviewResponse {
  if (!CLIENT_MODULES.has(name)) {
    return json(404, { error: { code: 'not_found', message: 'No preview module ' + name } });
  }
  let source: string;
  try {
    source = readFileSync(new URL('./client/' + name + '.ts', import.meta.url), 'utf8');
  } catch {
    return json(404, {
      error: { code: 'not_found', message: 'Preview serves client sources; run it from src' },
    });
  }
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: name + '.ts',
  });
  return { status: 200, headers: JS_HEADERS, body: output.outputText };
}

/** Placeholder for the content region: F-04 owns the attention list itself. */
function stateWord(value: string): string {
  return value.replace(/_/g, ' ').toLowerCase();
}

function attentionRegion(items: ReturnType<typeof OverviewSchema.parse>['attention']): string {
  const rows = items
    .map(
      (item) =>
        '<li><span class="mono">' +
        escapeHtml(item.video_label) +
        '</span> · ' +
        stateWord(item.status) +
        ' · ' +
        escapeHtml(stateWord(item.attention_reason ?? item.attention_kind)) +
        ' · stage <span class="mono">' +
        escapeHtml(item.current_stage) +
        '</span> (' +
        escapeHtml(stateWord(item.stage_state)) +
        ')</li>',
    )
    .join('');
  return (
    '<section aria-labelledby="attention-heading">' +
    '<h2 id="attention-heading">Attention</h2>' +
    '<p>Content region placeholder for F-01. The shell, rail, breadcrumb, status strip and token ' +
    'layer are this card; the attention list and batch views belong to F-04.</p>' +
    '<ul>' +
    rows +
    '</ul>' +
    '</section>'
  );
}

export function createPreviewHandler(options: PreviewOptions = {}) {
  const overview = OverviewSchema.parse(FIXTURES['overview.get']);
  const health = HealthReportSchema.parse(FIXTURES['health.report']);
  const session = SessionInfoSchema.parse(FIXTURES['auth.session']);
  const now = options.now ?? Date.parse(health.checked_at);

  const base: Omit<ShellInput, 'title' | 'nav' | 'content'> = {
    overview,
    health,
    session,
    now,
  };

  return function handle(request: PreviewRequest): PreviewResponse {
    const method = request.method.toUpperCase();
    if (method === 'HEAD') {
      const full = handle({ method: 'GET', url: request.url });
      return { status: full.status, headers: full.headers, body: '' };
    }
    if (method !== 'GET') {
      return json(405, { error: { code: 'method_not_allowed', message: 'GET only' } });
    }

    const path = request.url.split('?')[0] ?? '/';

    if (path === '/') {
      return {
        status: 200,
        headers: HTML_HEADERS,
        body: renderShell(
          buildShellModel({
            ...base,
            title: 'Overview',
            nav: 'overview',
            breadcrumbs: [{ label: 'Overview' }],
            content: attentionRegion(overview.attention),
          }),
        ),
      };
    }

    if (path === '/workspace') {
      return {
        status: 200,
        headers: HTML_HEADERS,
        body: renderShell(
          buildShellModel({
            ...base,
            title: 'Script',
            nav: null,
            breadcrumbs: [
              { label: 'Overview', href: '/' },
              { label: 'Quiet Mind', href: '/series/11111111-1111-4111-8111-111111111111' },
              { label: 'Video 7 of 30' },
            ],
            content:
              '<section aria-labelledby="script-heading"><h2 id="script-heading">Script</h2>' +
              '<p>Content region placeholder for F-01 — the workspace grid, stage rail and editor ' +
              'arrive with F-04.</p></section>',
            aside: {
              label: 'Change impact',
              content:
                '<section><h2>Change impact</h2><p>Reserved slot. The change-impact panel and its ' +
                'commit buttons belong to F-05; nothing here spends.</p></section>',
            },
            footer: '<span>footer slot — pins, mode and call counts (F-04)</span>',
          }),
        ),
      };
    }

    if (path === '/assets/app.css') {
      return { status: 200, headers: CSS_HEADERS, body: APP_CSS };
    }

    if (path.startsWith('/assets/client/')) {
      const name = path.slice('/assets/client/'.length).replace(/\.js$/, '');
      return clientModule(name);
    }

    return json(404, { error: { code: 'not_found', message: 'No preview route for ' + path } });
  };
}

export function startPreviewServer(
  port: number,
  options: PreviewOptions = {},
): ReturnType<typeof createServer> {
  const handle = createPreviewHandler(options);
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const result = handle({ method: request.method ?? 'GET', url: request.url ?? '/' });
    response.writeHead(result.status, result.headers);
    response.end(result.body);
  });
  server.listen(port, '127.0.0.1', () => {
    console.log('F-01 preview on http://127.0.0.1:' + port + '/');
  });
  return server;
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  startPreviewServer(Number.parseInt(process.env.PREVIEW_PORT ?? '4020', 10));
}
