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
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';

import * as ts from 'typescript';

import {
  HealthReportSchema,
  OverviewSchema,
  RenderViewSchema,
  SeriesDetailSchema,
  SeriesVersionDetailSchema,
  VideoDetailSchema,
} from '../../contract/api.js';
import { FIXTURES } from '../../contract/mock/fixtures.js';
import { createWebApp, type WebRequest, type WebResponse } from './app.js';
import type { AuthOutcome } from './auth/login.js';
import { MemorySessionStore, readSessionToken } from './auth/session.js';
import { createMemoryRenderGateway } from './quality/gateway.js';
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

export interface AuthPreviewOptions {
  readonly now?: () => number;
  /**
   * Evidence-only: seed the R-010-6 check as failing so the blocked approval
   * state can be inspected in a real browser. The product never synthesises a
   * check; this lives in the preview seed, not in the panel.
   */
  readonly qcFailing?: boolean;
}

/**
 * A deterministic silent H.264 stand-in at the fixture's duration (1080×1920,
 * 30 fps), encoded once on first request by the FFmpeg the stack already
 * requires. It exists so the preview can exercise a real `<video>`, the
 * captions track and the safe-area overlay with no provider and no binary
 * asset committed to the repository. If FFmpeg is unavailable the page still
 * renders its poster, text alternative and every QC number.
 */
/** The fixture's rendered duration (QC-7 measures the same take). */
const PREVIEW_RENDER_SECONDS = 75.1;

let standInVideo: Uint8Array | null | undefined;

function renderStandInVideo(durationSeconds: number): Uint8Array | null {
  if (standInVideo !== undefined) return standInVideo;
  try {
    const output = execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=0x141a22:s=1080x1920:r=30:d=' + durationSeconds,
        '-f',
        'lavfi',
        '-i',
        'anullsrc=channel_layout=mono:sample_rate=48000',
        '-shortest',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '38',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '32k',
        '-movflags',
        'frag_keyframe+empty_moov',
        '-f',
        'mp4',
        'pipe:1',
      ],
      { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    standInVideo = new Uint8Array(output);
  } catch {
    standInVideo = null;
  }
  return standInVideo;
}

function renderPosterSvg(): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" ' +
    'viewBox="0 0 1080 1920" role="img" aria-label="Render preview stand-in, 1080 by 1920">' +
    '<rect width="1080" height="1920" fill="#141a22"/>' +
    '<text x="540" y="940" fill="#aeb7c4" font-family="monospace" font-size="44" ' +
    'text-anchor="middle">1080×1920 · 30 fps</text>' +
    '<text x="540" y="1010" fill="#8b95a3" font-family="monospace" font-size="34" ' +
    'text-anchor="middle">preview stand-in</text>' +
    '</svg>'
  );
}

function captionVtt(): string {
  return (
    'WEBVTT\n\n' +
    '00:00:00.000 --> 00:00:04.000\nThis is a preview stand-in for the rendered video.\n\n' +
    '00:00:04.000 --> 00:00:08.000\nEvery QC number on the page comes from the contract fixture.\n'
  );
}

function captionSrt(): string {
  return (
    '1\n00:00:00,000 --> 00:00:04,000\nThis is a preview stand-in for the rendered video.\n\n' +
    '2\n00:00:04,000 --> 00:00:08,000\nEvery QC number on the page comes from the contract fixture.\n'
  );
}

export function createAuthPreviewHandler(
  options: AuthPreviewOptions = {},
): (request: WebRequest) => Promise<WebResponse> {
  const video = VideoDetailSchema.parse(FIXTURES['video.get']);
  const render = RenderViewSchema.parse(FIXTURES['render.get']);
  const sessions = new MemorySessionStore();
  const now = options.now ?? ((): number => Date.now());
  const seededChecks =
    options.qcFailing === true
      ? render.qc.checks.map((check) =>
          check.requirement === 'R-010-6' ? { ...check, pass: false, measured: '94.2 %' } : check,
        )
      : render.qc.checks;
  const seededQc =
    options.qcFailing === true
      ? { ...render.qc, status: 'fail' as const, checks: seededChecks }
      : render.qc;
  const renders = createMemoryRenderGateway({
    videoId: video.id,
    // Not yet approved: the gate is the point of the preview.
    view: { ...render, qc: seededQc, approved: false, approved_at: null },
    revision: 1,
    now,
  });

  const app = createWebApp({
    sessions,
    authenticate: demoAuthenticate,
    overview: OverviewSchema.parse(FIXTURES['overview.get']),
    health: HealthReportSchema.parse(FIXTURES['health.report']),
    now,
    series: demoSeriesGateway(),
    video: createMemoryVideoGateway([video]),
    render: renders,
    assets: { readClientModule, readSharedModule },
  });

  const videoAssetId = render.video?.id ?? '';
  const posterAssetId = render.poster?.id ?? '';
  const vttAssetId = render.captions.vtt?.id ?? '';
  const srtAssetId = render.captions.srt?.id ?? '';

  function header(request: WebRequest, name: string): string | undefined {
    for (const [key, value] of Object.entries(request.headers ?? {})) {
      if (key.toLowerCase() === name) return value;
    }
    return undefined;
  }

  /** `bytes=start-end`, clamped to the body; null for an absent/unsupported range. */
  function parseRange(
    value: string | undefined,
    size: number,
  ): { start: number; end: number } | null {
    if (value === undefined) return null;
    const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
    if (match === null) return null;
    const rawStart = match[1] ?? '';
    const rawEnd = match[2] ?? '';
    if (rawStart.length === 0 && rawEnd.length === 0) return null;
    let start = rawStart.length === 0 ? size - Number(rawEnd) : Number(rawStart);
    let end = rawStart.length === 0 || rawEnd.length === 0 ? size - 1 : Number(rawEnd);
    start = Math.max(0, Math.min(start, size - 1));
    end = Math.max(start, Math.min(end, size - 1));
    return Number.isFinite(start) && Number.isFinite(end) ? { start, end } : null;
  }

  // Preview-only stand-ins for the asset proxy INT-01 mounts: the render's
  // `urls.full` resolves to the encoded clip, its poster and the two caption
  // files, behind the same session guard the real proxy will use.
  return async function handle(request: WebRequest): Promise<WebResponse> {
    const path = request.url.split('?')[0] ?? '';
    const asset = /^\/asset\/([^/]+)\/(full|thumb)$/.exec(path);
    if (asset !== null && request.method.toUpperCase() === 'GET') {
      const id = asset[1] ?? '';
      let payload: Uint8Array | string | null = null;
      let contentType = 'application/octet-stream';
      if (id === videoAssetId) {
        payload = renderStandInVideo(PREVIEW_RENDER_SECONDS);
        contentType = 'video/mp4';
      } else if (id === posterAssetId) {
        payload = renderPosterSvg();
        contentType = 'image/svg+xml; charset=utf-8';
      } else if (id === vttAssetId) {
        payload = captionVtt();
        contentType = 'text/vtt; charset=utf-8';
      } else if (id === srtAssetId) {
        payload = captionSrt();
        contentType = 'text/plain; charset=utf-8';
      }
      if (payload !== null) {
        const token = readSessionToken(header(request, 'cookie'));
        if (token === null || sessions.read(token, now()) === null) {
          return {
            status: 303,
            headers: { location: '/login?required=1', 'cache-control': 'no-store' },
            body: '',
          };
        }
        if (typeof payload === 'string') {
          return {
            status: 200,
            headers: {
              'content-type': contentType,
              'cache-control': 'no-store',
              'content-length': String(Buffer.byteLength(payload)),
            },
            body: payload,
          };
        }
        const bytes = payload;
        const range = parseRange(header(request, 'range'), bytes.length);
        if (range === null) {
          return {
            status: 200,
            headers: {
              'content-type': contentType,
              'cache-control': 'no-store',
              'accept-ranges': 'bytes',
              'content-length': String(bytes.length),
            },
            body: '',
            bodyBytes: bytes,
          };
        }
        return {
          status: 206,
          headers: {
            'content-type': contentType,
            'cache-control': 'no-store',
            'accept-ranges': 'bytes',
            'content-range': 'bytes ' + range.start + '-' + range.end + '/' + bytes.length,
            'content-length': String(range.end - range.start + 1),
          },
          body: '',
          bodyBytes: bytes.subarray(range.start, range.end + 1),
        };
      }
    }
    return app(request);
  };
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
        response.end(result.bodyBytes === undefined ? result.body : Buffer.from(result.bodyBytes));
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
  startAuthPreviewServer(Number.parseInt(process.env.PREVIEW_PORT ?? '4021', 10), {
    qcFailing: process.env.PREVIEW_QC === 'fail',
  });
}
