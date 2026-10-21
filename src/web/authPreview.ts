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

import {
  HealthReportSchema,
  OverviewSchema,
  SeriesDetailSchema,
  NarrationViewSchema,
  SeriesVersionDetailSchema,
  VideoDetailSchema,
} from '../../contract/api.js';
import { FIXTURES } from '../../contract/mock/fixtures.js';
import { createWebApp, type WebRequest, type WebResponse } from './app.js';
import type { AuthOutcome } from './auth/login.js';
import { MemorySessionStore, readSessionToken } from './auth/session.js';
import { createMemorySeriesGateway } from './series/gateway.js';
import { createMemoryNarrationGateway } from './narration/gateway.js';
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
    name !== 'workspace' &&
    name !== 'narration'
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
    'narration/model.js',
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
}

/**
 * A deterministic silent 16-bit WAV at the fixture's duration, so the preview
 * can exercise real playback (S-14's word-following) with no provider and no
 * binary asset on disk. Latin-1: one character per byte, written back as bytes.
 */
function silentWav(durationSeconds: number): string {
  const sampleRate = 8000;
  const samples = Math.max(1, Math.round(durationSeconds * sampleRate));
  const dataBytes = samples * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const ascii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      bytes[offset + index] = text.charCodeAt(index);
    }
  };
  const uint16 = (offset: number, value: number): void => {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >> 8) & 0xff;
  };
  const uint32 = (offset: number, value: number): void => {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >>> 8) & 0xff;
    bytes[offset + 2] = (value >>> 16) & 0xff;
    bytes[offset + 3] = (value >>> 24) & 0xff;
  };
  ascii(0, 'RIFF');
  uint32(4, 36 + dataBytes);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  uint32(16, 16);
  uint16(20, 1);
  uint16(22, 1);
  uint32(24, sampleRate);
  uint32(28, sampleRate * 2);
  uint16(32, 2);
  uint16(34, 16);
  ascii(36, 'data');
  uint32(40, dataBytes);
  let latin1 = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    latin1 += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return latin1;
}

export function createAuthPreviewHandler(
  options: AuthPreviewOptions = {},
): (request: WebRequest) => Promise<WebResponse> {
  const video = VideoDetailSchema.parse(FIXTURES['video.get']);
  const narration = NarrationViewSchema.parse(FIXTURES['audio.get']);
  const audioAssetId = narration.asset?.id ?? '';
  const wav = silentWav(narration.duration_s ?? 1);
  const sessions = new MemorySessionStore();
  const now = options.now ?? ((): number => Date.now());
  const app = createWebApp({
    sessions,
    authenticate: demoAuthenticate,
    overview: OverviewSchema.parse(FIXTURES['overview.get']),
    health: HealthReportSchema.parse(FIXTURES['health.report']),
    now,
    series: demoSeriesGateway(),
    video: createMemoryVideoGateway([video]),
    // S-14 demo storage: the fixture take, not yet accepted, so both the
    // verdict and the accept gap are visible on the page.
    narration: createMemoryNarrationGateway({
      videoId: video.id,
      view: { ...narration, accepted_at: null },
      accept: true,
    }),
    assets: { readClientModule, readSharedModule },
  });

  function header(request: WebRequest, name: string): string | undefined {
    for (const [key, value] of Object.entries(request.headers ?? {})) {
      if (key.toLowerCase() === name) return value;
    }
    return undefined;
  }

  /** `bytes=start-end`, clamped to the body; null for an absent/unsupported range. */
  function parseRange(value: string | undefined): { start: number; end: number } | null {
    if (value === undefined) return null;
    const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
    if (match === null) return null;
    const size = wav.length;
    const rawStart = match[1] ?? '';
    const rawEnd = match[2] ?? '';
    if (rawStart.length === 0 && rawEnd.length === 0) return null;
    let start = rawStart.length === 0 ? size - Number(rawEnd) : Number(rawStart);
    let end = rawStart.length === 0 || rawEnd.length === 0 ? size - 1 : Number(rawEnd);
    start = Math.max(0, Math.min(start, size - 1));
    end = Math.max(start, Math.min(end, size - 1));
    return Number.isFinite(start) && Number.isFinite(end) ? { start, end } : null;
  }

  // Preview-only stand-in for the asset proxy INT-01 mounts: the narration
  // fixture's `urls.full` resolves to a silent WAV of the same duration, behind
  // the same session guard, with byte ranges so the player can seek.
  return async function handle(request: WebRequest): Promise<WebResponse> {
    const path = request.url.split('?')[0] ?? '';
    const asset = /^\/asset\/([^/]+)\/full$/.exec(path);
    if (asset !== null && asset[1] === audioAssetId && request.method.toUpperCase() === 'GET') {
      const token = readSessionToken(header(request, 'cookie'));
      if (token === null || sessions.read(token, now()) === null) {
        return {
          status: 303,
          headers: { location: '/login?required=1', 'cache-control': 'no-store' },
          body: '',
        };
      }
      const range = parseRange(header(request, 'range'));
      if (range === null) {
        return {
          status: 200,
          headers: {
            'content-type': 'audio/wav',
            'cache-control': 'no-store',
            'accept-ranges': 'bytes',
            'content-length': String(wav.length),
          },
          body: wav,
        };
      }
      return {
        status: 206,
        headers: {
          'content-type': 'audio/wav',
          'cache-control': 'no-store',
          'accept-ranges': 'bytes',
          'content-range': 'bytes ' + range.start + '-' + range.end + '/' + wav.length,
          'content-length': String(range.end - range.start + 1),
        },
        body: wav.slice(range.start, range.end + 1),
      };
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
        // The preview's silent WAV is latin-1 text; write it back as bytes.
        if ((result.headers['content-type'] ?? '').startsWith('audio/')) {
          response.end(Buffer.from(result.body, 'latin1'));
          return;
        }
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
