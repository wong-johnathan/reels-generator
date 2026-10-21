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
  SeriesVersionDetailSchema,
  VideoDetailSchema,
} from '../../contract/api.js';
import { FIXTURES } from '../../contract/mock/fixtures.js';
import { createWebApp, type WebRequest, type WebResponse } from './app.js';
import type { AuthOutcome } from './auth/login.js';
import { MemorySessionStore } from './auth/session.js';
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
}

export function createAuthPreviewHandler(
  options: AuthPreviewOptions = {},
): (request: WebRequest) => Promise<WebResponse> {
  return createWebApp({
    sessions: new MemorySessionStore(),
    authenticate: demoAuthenticate,
    overview: OverviewSchema.parse(FIXTURES['overview.get']),
    health: HealthReportSchema.parse(FIXTURES['health.report']),
    now: options.now ?? ((): number => Date.now()),
    series: demoSeriesGateway(),
    video: createMemoryVideoGateway([VideoDetailSchema.parse(FIXTURES['video.get'])]),
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
