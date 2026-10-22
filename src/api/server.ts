/**
 * Web entrypoint: probes + auth surface.
 *
 * B-01 laid the scaffold with two probes; B-13 adds the auth surface the whole
 * dashboard hangs off (R-015-4):
 *
 *   GET  /healthz, GET /readyz   compose probes, public (healthchecks carry no cookie)
 *   GET  /api/session            public, reports the session or "not authenticated"
 *   POST /api/login              the only route R-015-4 exempts
 *   POST /api/logout             session + CSRF
 *   everything else               session required — default-deny, via
 *                                 src/web/middleware/auth.ts
 *
 * Route handlers for the rest of S-01…S-21 land in later cards; until then an
 * authenticated unknown path answers `not_found`, which proves the gate rather
 * than pretending the route exists.
 *
 * The production entrypoint always supplies `auth`. A handler built without it
 * answers only the probes: there is no unauthenticated protected surface to
 * forget about, because there are no protected routes in that mode.
 */
import { readFileSync } from 'node:fs';

import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { connect } from 'node:net';
import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';

import { LoginRequestSchema } from '../../contract/api.js';
import { LoginBackoff } from '../auth/backoff.js';
import { clearCookie, serializeCookie } from '../auth/cookies.js';
import { PgOperatorStore, seedOperatorFromEnv } from '../auth/operator.js';
import { AuthService, type LoginResult } from '../auth/service.js';
import { PgSessionStore } from '../auth/sessions.js';
import type { AuthenticatedSession, SessionResolver } from '../auth/types.js';
import { formatIssues, validateEnv } from '../config/env.js';
import { createPool, describeTarget, poolConfigFromEnv } from '../db/client.js';
import { migrateOnStart } from '../boot/migrate-on-start.js';
import { redactText } from '../security/redact.js';
import {
  authorize,
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  sessionTokenFromRequest,
  type HttpResponse,
  type HttpRequestLike,
} from '../web/middleware/auth.js';
import { createWebApp, type WebAppDependencies } from '../web/app.js';
import { createDbSessionStore } from '../web/auth/dbSession.js';
import { loadBatches, type BatchSummary } from '../web/batches/postgres.js';
import { EMPTY_OVERVIEW, loadOverview, type Overview } from '../web/overview/postgres.js';
import { handleSeriesRequest } from './series-routes.js';
import { createPostgresOpsGateway } from '../web/health/postgres.js';
import { createPostgresNarrationGateway } from '../web/narration/postgres.js';
import { createPostgresExportGateway } from '../web/provenance/postgres.js';
import { createPostgresRenderGateway } from '../web/quality/postgres.js';
import { createPostgresSceneGateway } from '../web/scenes/postgres.js';
import { createPostgresScriptGateway } from '../web/script/postgres.js';
import { createSeriesGateway } from '../web/series/postgres.js';
import { createVideoGateway } from '../web/workspace/postgres.js';
import { createPostgresDownloadGateway } from '../web/download/postgres.js';
import type { VideoDownloadGateway } from '../web/download/gateway.js';
import { createS3Stores, s3ConfigFromEnv } from '../storage/s3-store.js';

export interface Readiness {
  readonly ready: boolean;
  readonly degraded_reasons: readonly string[];
}

export type HealthProbe = () => Promise<Readiness>;

export type HandlerResponse = HttpResponse & { readonly bodyBytes?: Uint8Array };

/** A request as the handler sees it: already parsed, no socket required. */
export interface HttpRequest extends HttpRequestLike {
  /** The peer address, used only to scope the login backoff. */
  readonly remoteAddress?: string;
}

/**
 * Handlers that need the database. Optional: a probe-only or auth-only handler
 * mounts nothing behind them, so B-13's auth tests keep exactly the surface they
 * assert.
 */
export interface ContentRuntime {
  readonly pool: Pool;
  /**
   * The dashboard overview, loaded once at startup by the production entrypoint
   * (see `loadOverview`). The mount passes it straight through to `createWebApp`;
   * a handler built without it shows an empty overview rather than querying the
   * database per request.
   */
  readonly overview?: Overview;
  /** Re-reads the overview per request, so the dashboard is not a boot snapshot. */
  readonly reloadOverview?: () => Promise<Overview>;
  /** S-05 Batches page read model. */
  readonly batches?: { list(): Promise<readonly BatchSummary[]> };
  /**
   * The final-video download seam. Bound only when an object store is available;
   * a handler built without it answers 503 on /videos/:id/download rather than
   * inventing bytes.
   */
  readonly download?: VideoDownloadGateway;
}

/** What the production entrypoint injects. Tests pass the same shape. */
export interface AuthRuntime {
  readonly service: AuthService;
  readonly sessionTtlSeconds: number;
  /** Add the `Secure` cookie attribute when the app is behind TLS. */
  readonly secureCookies?: boolean;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' } as const;

/**
 * Client enhancers, served from the compiled bundle.
 *
 * The pages are written to work without JavaScript, but the commit bar, the
 * dirty-state diff and the form validation only recompute client-side. Without
 * these module responses every page renders its *initial* state forever: a new
 * series form stays "Nothing to save" with a disabled button no matter what is
 * typed, because the server rendered it before the fields were filled.
 *
 * Names are wire identifiers from a fixed map, never paths. `dist` holds .js;
 * the .ts fallback exists so tests can exercise this without a build step.
 */
const CLIENT_MODULE_FILES: Readonly<Record<string, string>> = {
  login: 'login',
  shell: 'shell',
  behaviours: 'behaviours',
  'series-editor': 'seriesEditor',
  'script-review': 'scriptReview',
  workspace: 'workspace',
  'scene-grid': 'sceneGrid',
  narration: 'narration',
};

const SHARED_MODULES: readonly string[] = [
  'format.js',
  'series/commit.js',
  'series/fields.js',
  'script/impact.js',
  'script/model.js',
  'workspace/events.js',
  'workspace/glyphs.js',
  'workspace/railDom.js',
  'narration/model.js',
  'shared/stages.js',
  'shared/states.js',
];

function readWebSource(relativeJs: string): string | null {
  for (const candidate of [relativeJs, relativeJs.replace(/\.js$/, '.ts')]) {
    try {
      return readFileSync(new URL(candidate, import.meta.url), 'utf8');
    } catch {
      continue;
    }
  }
  return null;
}

function readClientModule(name: string): string | null {
  const file = CLIENT_MODULE_FILES[name];
  return file === undefined ? null : readWebSource('../web/client/' + file + '.js');
}

function readSharedModule(path: string): string | null {
  return SHARED_MODULES.includes(path) ? readWebSource('../web/' + path) : null;
}

const MAX_BODY_BYTES = 64 * 1024;

function envelope(code: string, message: string, status: number): HandlerResponse {
  return { status, headers: JSON_HEADERS, body: JSON.stringify({ error: { code, message } }) };
}

function noStore(
  headers: Record<string, string | readonly string[]>,
): Record<string, string | readonly string[]> {
  return { ...headers, 'cache-control': 'no-store' };
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(', ') : value;
}

function normaliseHeaders(headers: IncomingHttpHeaders): Record<string, string | undefined> {
  const output: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) output[key] = firstHeader(value);
  return output;
}

function sessionCookie(token: string, auth: AuthRuntime): string {
  return serializeCookie(SESSION_COOKIE_NAME, token, {
    maxAgeSeconds: auth.sessionTtlSeconds,
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    secure: auth.secureCookies === true,
  });
}

function csrfCookie(token: string, auth: AuthRuntime): string {
  return serializeCookie(CSRF_COOKIE_NAME, token, {
    maxAgeSeconds: auth.sessionTtlSeconds,
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    secure: auth.secureCookies === true,
  });
}

function clearedCookie(name: string, auth: AuthRuntime): string {
  return clearCookie(name, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    secure: auth.secureCookies === true,
  });
}

function sessionPayload(session: AuthenticatedSession): Record<string, unknown> {
  return {
    authenticated: true,
    username: session.username,
    csrf_token: session.csrfToken,
    expires_at: session.expiresAt.toISOString(),
  };
}

function anonymousSessionPayload(): Record<string, unknown> {
  return { authenticated: false, username: null, csrf_token: '', expires_at: null };
}

function clientKeyOf(request: HttpRequest): string | undefined {
  const forwarded = request.headers?.['x-forwarded-for'];
  if (forwarded && forwarded.length > 0) return forwarded.split(',')[0]?.trim();
  return request.remoteAddress;
}

interface ParsedLogin {
  readonly ok: true;
  readonly username: string;
  readonly password: string;
}

function parseLoginBody(
  body: string | undefined,
): ParsedLogin | { ok: false; fields: Record<string, string> } {
  if (body === undefined || body.trim().length === 0) {
    return { ok: false, fields: { body: 'a JSON body with username and password is required' } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, fields: { body: 'must be valid JSON' } };
  }

  const result = LoginRequestSchema.safeParse(parsed);
  if (!result.success) {
    const fields: Record<string, string> = {};
    for (const issue of result.error.issues) {
      fields[issue.path.join('.') || 'body'] = issue.message;
    }
    return { ok: false, fields };
  }
  return { ok: true, username: result.data.username, password: result.data.password };
}

async function handleLogin(request: HttpRequest, auth: AuthRuntime): Promise<HandlerResponse> {
  const parsed = parseLoginBody(request.body);
  if (!parsed.ok) {
    return {
      status: 400,
      headers: noStore({ ...JSON_HEADERS }),
      body: JSON.stringify({
        error: {
          code: 'validation_failed',
          message: 'The login request is invalid',
          fields: parsed.fields,
        },
      }),
    };
  }

  const result: LoginResult = await auth.service.login({
    username: parsed.username,
    password: parsed.password,
    clientKey: clientKeyOf(request),
  });

  if (!result.ok) {
    if (result.reason === 'rate_limited') {
      const retryAfterS = result.retryAfterS ?? 1;
      return {
        status: 429,
        headers: noStore({ ...JSON_HEADERS, 'retry-after': String(retryAfterS) }),
        body: JSON.stringify({
          error: {
            code: 'rate_limited',
            message: `Too many login attempts; retry in ${retryAfterS}s`,
          },
        }),
      };
    }
    // Generic on purpose: a wrong password and an unknown account are the same
    // answer (no account enumeration).
    return {
      status: 401,
      headers: noStore({ ...JSON_HEADERS }),
      body: JSON.stringify({
        error: { code: 'unauthorized', message: 'Invalid username or password' },
      }),
    };
  }

  return {
    status: 200,
    headers: noStore({
      ...JSON_HEADERS,
      'set-cookie': [sessionCookie(result.token, auth), csrfCookie(result.session.csrfToken, auth)],
    }),
    body: JSON.stringify(sessionPayload(result.session)),
  };
}

async function handleSession(request: HttpRequest, auth: AuthRuntime): Promise<HandlerResponse> {
  const token = sessionTokenFromRequest(request);
  const session = token ? await auth.service.authenticate(token) : null;
  return {
    status: 200,
    headers: noStore({ ...JSON_HEADERS }),
    body: JSON.stringify(session ? sessionPayload(session) : anonymousSessionPayload()),
  };
}

async function handleLogout(request: HttpRequest, auth: AuthRuntime): Promise<HandlerResponse> {
  const token = sessionTokenFromRequest(request);
  if (token) await auth.service.logout(token);
  return {
    status: 200,
    headers: noStore({
      ...JSON_HEADERS,
      'set-cookie': [
        clearedCookie(SESSION_COOKIE_NAME, auth),
        clearedCookie(CSRF_COOKIE_NAME, auth),
      ],
    }),
    body: JSON.stringify({ ok: true }),
  };
}

/**
 * Build the dashboard's dependencies from the runtimes the server already has.
 * The AuthService is the single source of truth for sessions and login: the web
 * store reads through it, and the web authenticator maps its LoginResult onto
 * the web's three AuthOutcome kinds (authenticated / rejected / throttled).
 */
function webDeps(auth: AuthRuntime, content?: ContentRuntime): WebAppDependencies {
  return {
    sessions: createDbSessionStore(auth.service),
    authenticate: async ({ username, password }) => {
      const result = await auth.service.login({ username, password });
      if (result.ok) {
        return {
          kind: 'authenticated',
          username: result.session.username,
          sessionToken: result.token,
          csrfToken: result.session.csrfToken,
        };
      }
      if (result.reason === 'rate_limited') {
        return { kind: 'throttled', retryAfterSeconds: result.retryAfterS ?? 1 };
      }
      return { kind: 'rejected' };
    },
    overview: content?.overview ?? EMPTY_OVERVIEW,
    ...(content?.reloadOverview === undefined ? {} : { reloadOverview: content.reloadOverview }),
    ...(content?.batches === undefined ? {} : { batches: content.batches }),
    // Storage adapters. Every one of these reads only columns that exist in the
    // frozen schema (m001…m009); a field with no column behind it is left as the
    // view type's documented empty value rather than a plausible default, so a
    // page can look sparse but never invents a number.
    ...(content === undefined
      ? {}
      : {
          series: createSeriesGateway(content.pool),
          video: createVideoGateway(content.pool),
          scenes: createPostgresSceneGateway(content.pool),
          script: createPostgresScriptGateway(content.pool),
          narration: createPostgresNarrationGateway(content.pool),
          render: createPostgresRenderGateway(content.pool),
          exportPackage: createPostgresExportGateway(content.pool),
          download: content.download,
          ops: createPostgresOpsGateway(content.pool),
        }),
    // The web session record carries only the operator and expiry; the CSRF
    // token lives in the `reels_csrf` cookie (issued on login) and is checked
    // by the /api middleware on state-changing routes. No HTML form this build
    // serves needs it, so '' is the honest value rather than a fabricated token.
    assets: { readClientModule, readSharedModule },
    csrfToken: () => '',
    now: () => Date.now(),
  };
}

/** Bridge a web response onto the handler's shape, merging any extra cookies. */
async function handleWebApp(
  app: ReturnType<typeof createWebApp>,
  request: HttpRequest,
): Promise<HandlerResponse> {
  const response = await app({
    method: request.method,
    url: request.url,
    headers: request.headers,
    body: request.body,
  });
  const headers: Record<string, string | readonly string[]> = { ...response.headers };
  if (response.setCookies !== undefined && response.setCookies.length > 0) {
    headers['set-cookie'] = response.setCookies;
  }
  return {
    status: response.status,
    headers,
    body: response.body,
    ...(response.bodyBytes === undefined ? {} : { bodyBytes: response.bodyBytes }),
  };
}

/**
 * Route a request. Pure and injectable so the tests run without binding a socket
 * or requiring a database; `startServer` adds the socket and body reading.
 *
 * The dashboard (`src/web/app.ts`) is mounted here whenever the handler has an
 * auth runtime: non-`/api` paths go to it, so `/login`, `/` and every HTML
 * surface share the production session store and the DB-backed authenticator.
 * A handler built without `auth` answers only the probes and the /api surface —
 * there is no session store to back an HTML page, so page paths answer 404.
 */
export function createRequestHandler(
  probe: HealthProbe,
  auth?: AuthRuntime,
  content?: ContentRuntime,
) {
  // Built once: the page handler holds no per-request state, and the overview
  // is a startup snapshot (ContentRuntime.overview), not a per-request read.
  const webApp = auth === undefined ? null : createWebApp(webDeps(auth, content));

  return async function handle(request: HttpRequest): Promise<HandlerResponse> {
    const method = request.method.toUpperCase();
    const path = request.url.split('?')[0] ?? '/';

    if (path === '/healthz') {
      if (method !== 'GET') return envelope('method_not_allowed', 'GET only', 405);
      return { status: 200, headers: JSON_HEADERS, body: JSON.stringify({ status: 'ok' }) };
    }

    if (path === '/readyz') {
      if (method !== 'GET') return envelope('method_not_allowed', 'GET only', 405);
      const readiness = await probe();
      return {
        // R-018-1/2: 503 + a named reason, then self-heal when the dependency returns.
        status: readiness.ready ? 200 : 503,
        headers: JSON_HEADERS,
        body: JSON.stringify({
          ready: readiness.ready,
          degraded_reasons: [...readiness.degraded_reasons],
        }),
      };
    }

    // HTML surfaces: the dashboard app owns them (and its own session guard).
    if (!path.startsWith('/api/')) {
      if (webApp === null) {
        // Probe-only embedding: no session store exists to back a page.
        return envelope('not_found', `No route for ${path}`, 404);
      }
      return handleWebApp(webApp, request);
    }

    if (auth === undefined) {
      // Probe-only embedding: no protected routes are mounted, so there is
      // nothing to protect. The entrypoint below always passes `auth`.
      return envelope('not_found', `No route for ${path}`, 404);
    }

    if (path === '/api/login') {
      if (method !== 'POST') return envelope('method_not_allowed', 'POST only', 405);
      return handleLogin(request, auth);
    }

    if (path === '/api/session') {
      if (method !== 'GET') return envelope('method_not_allowed', 'GET only', 405);
      return handleSession(request, auth);
    }

    const decision = await authorize(request, { resolver: auth.service as SessionResolver });
    if (!decision.allowed) {
      return decision.response ?? envelope('unauthorized', 'Authentication required', 401);
    }

    // Series CRUD + versioning (B-14): the session is authenticated and, for
    // mutating methods, CSRF-checked by `authorize` above.
    if (content !== undefined && decision.session !== null) {
      const seriesResponse = await handleSeriesRequest(request, decision.session, {
        pool: content.pool,
      });
      if (seriesResponse !== null) return seriesResponse;
    }

    if (path === '/api/logout') {
      if (method !== 'POST') return envelope('method_not_allowed', 'POST only', 405);
      return handleLogout(request, auth);
    }

    return envelope('not_found', `No route for ${path}`, 404);
  };
}

/** A TCP reachability probe with a hard timeout — no driver dependency yet. */
export function tcpProbe(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Build the readiness probe for the stores this deployment is configured with. */
export function createDependencyProbe(
  env: Readonly<Record<string, string | undefined>>,
): HealthProbe {
  const checks: Array<{ name: string; host: string; port: number }> = [
    {
      name: 'postgres',
      host: env.POSTGRES_HOST ?? 'postgres',
      port: Number.parseInt(env.POSTGRES_PORT ?? '5432', 10),
    },
    {
      name: 'redis',
      host: new URL(env.REDIS_URL ?? 'redis://redis:6379').hostname,
      port: Number.parseInt(new URL(env.REDIS_URL ?? 'redis://redis:6379').port || '6379', 10),
    },
    {
      name: 'minio',
      host: new URL(env.MINIO_ENDPOINT ?? 'http://minio:9000').hostname,
      port: Number.parseInt(new URL(env.MINIO_ENDPOINT ?? 'http://minio:9000').port || '9000', 10),
    },
  ];

  return async function probe(): Promise<Readiness> {
    const results = await Promise.all(
      checks.map(async (check) => ({
        name: check.name,
        ok: await tcpProbe(check.host, check.port),
      })),
    );
    const down = results.filter((result) => !result.ok).map((result) => result.name);
    return {
      ready: down.length === 0,
      degraded_reasons: down.map((name) => `${name} unreachable — service not ready`),
    };
  };
}

class BodyTooLargeError extends Error {
  constructor() {
    super(`the request body exceeds ${MAX_BODY_BYTES} bytes`);
    this.name = 'BodyTooLargeError';
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BodyTooLargeError());
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

export function startServer(options: {
  port: number;
  probe: HealthProbe;
  auth?: AuthRuntime;
  content?: ContentRuntime;
  host?: string;
}): ReturnType<typeof createServer> {
  const handle = createRequestHandler(options.probe, options.auth, options.content);
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const respond = (response: HandlerResponse): void => {
      res.writeHead(response.status, response.headers as Record<string, string | string[]>);
      if (response.bodyBytes !== undefined) {
        res.end(response.bodyBytes);
        return;
      }
      res.end(response.body);
    };

    const method = req.method ?? 'GET';
    const wantsBody = method !== 'GET' && method !== 'HEAD';
    const body = wantsBody ? readBody(req) : Promise.resolve('');

    void body
      .then((text) =>
        handle({
          method,
          url: req.url ?? '/',
          headers: normaliseHeaders(req.headers),
          body: text,
          remoteAddress: req.socket.remoteAddress,
        }),
      )
      .then(respond)
      .catch((error: unknown) => {
        if (error instanceof BodyTooLargeError) {
          respond(envelope('validation_failed', error.message, 400));
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        respond(envelope('internal', redactText(message, { env: process.env }), 500));
      });
  });
  server.listen(options.port, options.host ?? '0.0.0.0', () => {
    console.log(`reels-generator web listening on ${options.host ?? '0.0.0.0'}:${options.port}`);
  });
  return server;
}

/**
 * Production entrypoint. Auth is on by default (R-015-6): the operator is
 * seeded here (idempotently, never reset) and the session/CSRF service is wired
 * before the port opens. A failure to seed is fatal — a web process that cannot
 * authenticate anyone must not pretend to serve.
 */
export async function startFromEnvironment(): Promise<ReturnType<typeof createServer>> {
  const result = validateEnv(process.env, 'web');
  if (!result.ok) {
    console.error(formatIssues(result.issues, 'web'));
    throw new Error('web: environment validation failed (see the named keys above)');
  }

  const pool = createPool(process.env);
  try {
    // Schema first: a process whose schema is older than its code must not take
    // traffic. Concurrent replicas serialise on the migration advisory lock.
    await migrateOnStart(pool, {
      env: process.env,
      log: (line) => console.log(line),
    });
    // The object store is a hard production dependency: env validation above
    // already required MINIO_*, and this construction fails loudly (never an
    // in-memory fallback) if any of them is absent or malformed.
    const stores = createS3Stores(s3ConfigFromEnv(process.env));
    const seeded = await seedOperatorFromEnv(process.env, pool);
    const ttlHours = Number.parseInt(result.values.SESSION_TTL_HOURS ?? '720', 10);
    const service = new AuthService({
      operators: new PgOperatorStore(pool),
      sessions: new PgSessionStore(pool),
      backoff: new LoginBackoff(),
      config: {
        sessionSecret: result.values.SESSION_SECRET ?? '',
        sessionTtlSeconds: ttlHours * 3600,
      },
    });

    // The startup snapshot is still passed in, but the mount also gets a loader:
    // a boot-time snapshot meant a batch started after 09:00 never changed the
    // numbers on the dashboard until the container restarted.
    const overview = await loadOverview(pool);

    const server = startServer({
      port: Number.parseInt(result.values.APP_PORT ?? '8080', 10),
      probe: createDependencyProbe(process.env),
      auth: {
        service,
        sessionTtlSeconds: ttlHours * 3600,
        secureCookies: (result.values.APP_BASE_URL ?? '').startsWith('https://'),
      },
      content: {
        pool,
        overview,
        reloadOverview: () => loadOverview(pool),
        batches: { list: () => loadBatches(pool) },
        download: createPostgresDownloadGateway(pool, stores.content),
      },
    });
    server.on('close', () => {
      void pool.end();
    });

    console.log(
      `auth: operator "${redactText(seeded.username, { env: process.env })}" ` +
        `${seeded.created ? 'seeded' : 'already present (unchanged; no reset path)'}; session auth is on`,
    );
    return server;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `web: refusing to start (${describeTarget(poolConfigFromEnv(process.env))}) — ` +
        redactText(message, { env: process.env }),
    );
    await pool.end().catch(() => undefined);
    throw error;
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  await startFromEnvironment();
}
