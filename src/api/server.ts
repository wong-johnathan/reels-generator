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
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { connect } from 'node:net';
import { pathToFileURL } from 'node:url';

import { LoginRequestSchema } from '../../contract/api.js';
import { LoginBackoff } from '../auth/backoff.js';
import { clearCookie, serializeCookie } from '../auth/cookies.js';
import { PgOperatorStore, seedOperatorFromEnv } from '../auth/operator.js';
import { AuthService, type LoginResult } from '../auth/service.js';
import { PgSessionStore } from '../auth/sessions.js';
import type { AuthenticatedSession, SessionResolver } from '../auth/types.js';
import { formatIssues, validateEnv } from '../config/env.js';
import { createPool, describeTarget, poolConfigFromEnv } from '../db/client.js';
import { redactText } from '../security/redact.js';
import {
  authorize,
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  sessionTokenFromRequest,
  type HttpResponse,
  type HttpRequestLike,
} from '../web/middleware/auth.js';

export interface Readiness {
  readonly ready: boolean;
  readonly degraded_reasons: readonly string[];
}

export type HealthProbe = () => Promise<Readiness>;

export type HandlerResponse = HttpResponse;

/** A request as the handler sees it: already parsed, no socket required. */
export interface HttpRequest extends HttpRequestLike {
  /** The peer address, used only to scope the login backoff. */
  readonly remoteAddress?: string;
}

/** What the production entrypoint injects. Tests pass the same shape. */
export interface AuthRuntime {
  readonly service: AuthService;
  readonly sessionTtlSeconds: number;
  /** Add the `Secure` cookie attribute when the app is behind TLS. */
  readonly secureCookies?: boolean;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' } as const;
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
 * Route a request. Pure and injectable so the tests run without binding a socket
 * or requiring a database; `startServer` adds the socket and body reading.
 */
export function createRequestHandler(probe: HealthProbe, auth?: AuthRuntime) {
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
  host?: string;
}): ReturnType<typeof createServer> {
  const handle = createRequestHandler(options.probe, options.auth);
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const respond = (response: HandlerResponse): void => {
      res.writeHead(response.status, response.headers as Record<string, string | string[]>);
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

    const server = startServer({
      port: Number.parseInt(result.values.APP_PORT ?? '8080', 10),
      probe: createDependencyProbe(process.env),
      auth: {
        service,
        sessionTtlSeconds: ttlHours * 3600,
        secureCookies: (result.values.APP_BASE_URL ?? '').startsWith('https://'),
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
