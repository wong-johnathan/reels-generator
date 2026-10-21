/**
 * F-02 preview — S-01 / SY-2 / SY-3 served over real HTTP with a real cookie
 * flow, wired through the same handler the production entrypoint mounts.
 *
 *   npx tsx src/web/authPreview.ts        # http://127.0.0.1:4021/login
 *
 * This is a development surface. It uses an in-memory session store and one
 * deterministic fake credential (`operator` / `preview`); there is no
 * database, no network and no provider call. B-13 supplies the real argon2id
 * check and the Postgres session table at INT-01 — the handler does not change.
 */
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';

import * as ts from 'typescript';
import type { z } from 'zod';

import {
  AttemptRowSchema,
  ExportViewSchema,
  HealthReportSchema,
  OverviewSchema,
  SeriesDetailSchema,
  SeriesVersionDetailSchema,
  VideoDetailSchema,
} from '../../contract/api.js';
import { FIXTURES, IDS } from '../../contract/mock/fixtures.js';
import { createWebApp, type WebRequest, type WebResponse } from './app.js';
import type { AuthOutcome } from './auth/login.js';
import { MemorySessionStore } from './auth/session.js';
import { createMemoryOpsGateway } from './health/gateway.js';
import { createMemoryExportGateway } from './provenance/gateway.js';
import { createMemorySeriesGateway } from './series/gateway.js';
import { createMemoryVideoGateway } from './workspace/gateway.js';

const DEMO_OPERATOR = 'operator';
const DEMO_PASSWORD = 'preview';

const MAX_BODY_BYTES = 64 * 1024;

function transpile(relativePath: string, label: string): string | null {
  let source: string;
  try {
    source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  } catch {
    return null;
  }
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: label + '.ts',
  }).outputText;
}

function readClientModule(name: string): string | null {
  if (
    name !== 'login' &&
    name !== 'shell' &&
    name !== 'behaviours' &&
    name !== 'series-editor' &&
    name !== 'workspace'
  ) {
    return null;
  }
  const file = name === 'series-editor' ? 'seriesEditor' : name;
  return transpile('./client/' + file + '.ts', name);
}

/** The enhancer's shared rules, served from the same source the server uses. */
function readSharedModule(path: string): string | null {
  const allowed = [
    'format.js',
    'series/commit.js',
    'series/fields.js',
    'workspace/events.js',
    'workspace/glyphs.js',
    'shared/stages.js',
    'shared/states.js',
  ];
  if (!allowed.includes(path)) {
    return null;
  }
  return transpile('./' + path.replace(/\.js$/, '.ts'), path.replace(/[^a-z0-9]+/gi, '-'));
}

function demoAuthenticate(input: {
  readonly username: string;
  readonly password: string;
}): AuthOutcome {
  return input.username === DEMO_OPERATOR && input.password === DEMO_PASSWORD
    ? { kind: 'authenticated', username: DEMO_OPERATOR }
    : { kind: 'rejected' };
}

/** S-03/S-04 demo storage: the frozen fixture series, editable in memory only. */
function demoSeriesGateway(): ReturnType<typeof createMemorySeriesGateway> {
  const detail = SeriesDetailSchema.parse(FIXTURES['series.get']);
  return createMemorySeriesGateway({
    detail,
    versions: [SeriesVersionDetailSchema.parse(FIXTURES['series.versions.get'])],
    projects: [
      { id: '22222222-2222-4222-8222-111111111111', pins: { SB: 3, IM: 3, NA: 3, TC: 3 } },
    ],
    inFlightBatches: detail.in_flight_batches,
  });
}

type VideoDetail = z.infer<typeof VideoDetailSchema>;
type HealthReport = z.infer<typeof HealthReportSchema>;
type Overview = z.infer<typeof OverviewSchema>;
type AttemptRow = z.infer<typeof AttemptRowSchema>;
type ExportView = z.infer<typeof ExportViewSchema>;

/** `PREVIEW_EXPORT=built` seeds the S-16 "package ready" state. */
function demoExportView(): ExportView {
  const view = ExportViewSchema.parse(FIXTURES['export.get']);
  const mode = process.env['PREVIEW_EXPORT'];
  if (mode === 'built') {
    return { ...view, status: 'done', package_built_at: '2026-10-20T09:45:00.000Z' };
  }
  if (mode === 'unbuilt') {
    return { ...view, status: 'not_run', package_built_at: null };
  }
  return view;
}

/** The video that matches the seeded export: approved and exported. */
function demoVideoDetail(): VideoDetail {
  const detail = VideoDetailSchema.parse(FIXTURES['video.get']);
  if (process.env['PREVIEW_EXPORT'] !== 'built' && process.env['PREVIEW_EXPORT'] !== 'unbuilt') {
    return detail;
  }
  return {
    ...detail,
    status: 'COMPLETE',
    current_stage: 'EX',
    stage_state: 'done',
    attention_kind: 'none',
    attention_reason: null,
    stages: detail.stages.map((stage) =>
      stage.stage === 'FA' || stage.stage === 'EX'
        ? { ...stage, state: 'done', blocked_reason: null }
        : stage,
    ),
  };
}

/** `PREVIEW_HEALTH=ready` clears the fixture's disk degradation. */
function demoHealth(): HealthReport {
  const report = HealthReportSchema.parse(FIXTURES['health.report']);
  if (process.env['PREVIEW_HEALTH'] !== 'ready') return report;
  return {
    ...report,
    ready: true,
    degraded_reasons: [],
    components: report.components.map((component) =>
      component.status === 'ok'
        ? component
        : { ...component, status: 'ok', detail: '120.0 GB free of 220.0 GB' },
    ),
    disk:
      report.disk === null
        ? null
        : { ...report.disk, headroom_ok: true, free_bytes: 128_849_018_880 },
  };
}

function demoOverview(): Overview {
  const overview = OverviewSchema.parse(FIXTURES['overview.get']);
  if (process.env['PREVIEW_HEALTH'] !== 'ready') return overview;
  return { ...overview, degraded: [] };
}

/**
 * Deterministic attempt rows for the preview. The newest row is a timed-out
 * TTS call whose charge status is pending: it must render `unknown charge`
 * (R-012-4), never `unbilled`.
 */
function demoAttemptsByVideo(): Record<string, readonly AttemptRow[]> {
  const base = AttemptRowSchema.parse(
    (FIXTURES['attempts.list'] as { attempts: unknown[] }).attempts[0],
  );
  if (base === undefined) return {};
  const imageFailure = AttemptRowSchema.parse({
    ...base,
    id: 'cccccccc-cccc-4ccc-8ccc-222222222222',
    stage: 'IM',
    provider: 'gemini',
    model: 'gemini-nano-banana-2.1',
    provider_request_id: 'req_000000000002',
    prompt_hash: 'sha256:41ab9c',
    charge_status: 'unbilled',
    status: 'failed',
    error_class: 'transient',
    http_status: 503,
    attempt_no: 2,
    max_attempts: 3,
    backoff_s: 4,
    created_at: '2026-10-20T09:31:00.000Z',
    started_at: '2026-10-20T09:31:00.000Z',
    ended_at: '2026-10-20T09:31:02.000Z',
  });
  const timedOut = AttemptRowSchema.parse({
    ...base,
    id: 'cccccccc-cccc-4ccc-8ccc-333333333333',
    stage: 'NA',
    provider: 'elevenlabs',
    model: 'eleven_multilingual_v2',
    provider_request_id: null,
    prompt_hash: 'sha256:7d31e0',
    charge_status: 'pending',
    status: 'timed_out',
    error_class: 'transient',
    http_status: null,
    attempt_no: 3,
    max_attempts: 3,
    backoff_s: 16,
    created_at: '2026-10-20T09:41:00.000Z',
    started_at: '2026-10-20T09:41:00.000Z',
    ended_at: null,
  });
  return {
    [IDS.video]: [base, imageFailure, timedOut],
    [IDS.video2]: [imageFailure],
  };
}

export interface AuthPreviewOptions {
  readonly now?: () => number;
}

export function createAuthPreviewHandler(
  options: AuthPreviewOptions = {},
): (request: WebRequest) => Promise<WebResponse> {
  const overview = demoOverview();
  const health = demoHealth();
  const video = demoVideoDetail();
  const exportView = demoExportView();
  const clock = options.now ?? ((): number => Date.now());
  return createWebApp({
    sessions: new MemorySessionStore(),
    authenticate: demoAuthenticate,
    overview,
    health,
    now: clock,
    series: demoSeriesGateway(),
    video: createMemoryVideoGateway([video]),
    exportPackage: createMemoryExportGateway({
      videoId: IDS.video,
      view: exportView,
      now: clock,
    }),
    ops: createMemoryOpsGateway({ report: health, attemptsByVideo: demoAttemptsByVideo() }),
    assets: { readClientModule, readSharedModule },
  });
}

function collectBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) reject(new Error('request body too large'));
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

export function startAuthPreviewServer(
  port: number,
  options: AuthPreviewOptions = {},
): ReturnType<typeof createServer> {
  const handle = createAuthPreviewHandler(options);
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void collectBody(request)
      .then((body) => {
        const headers: Record<string, string | undefined> = {};
        for (const [name, value] of Object.entries(request.headers)) {
          headers[name] = Array.isArray(value) ? value.join('; ') : value;
        }
        return handle({
          method: request.method ?? 'GET',
          url: request.url ?? '/',
          headers,
          body,
        });
      })
      .then((result) => {
        response.writeHead(result.status, result.headers);
        response.end(result.body);
      })
      .catch(() => {
        response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: { code: 'internal', message: 'Preview failure' } }));
      });
  });
  server.listen(port, '127.0.0.1', () => {
    console.log('F-02 auth preview on http://127.0.0.1:' + port + '/login');
    console.log('  demo sign-in: ' + DEMO_OPERATOR + ' / ' + DEMO_PASSWORD + ' (fake, in-memory)');
  });
  return server;
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  startAuthPreviewServer(Number.parseInt(process.env.PREVIEW_PORT ?? '4021', 10));
}
