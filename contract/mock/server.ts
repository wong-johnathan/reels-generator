/**
 * Deterministic mock API — LEAD_PLAN §6.
 *
 * Serves one fixture per route in `contract/api.ts` so the whole UI renders and
 * every interaction (gates, invalidation preview, SSE state changes) is
 * exercisable with zero live backend, zero database and zero network.
 *
 *   npm run contract:mock            # http://127.0.0.1:4010
 *   PORT=5050 npm run contract:mock
 *
 * The handler is a pure function of the request, exported separately from the
 * HTTP wrapper so tests never bind a port.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';

import { JSON_ROUTES, ROUTES, type RouteDef } from '../api.js';
import { FIXTURES } from './fixtures.js';

export interface MockRequest {
  readonly method: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
}

export interface MockResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface MockOptions {
  /** Override any route's fixture (used by tests and by UI story book states). */
  readonly fixtures?: Partial<Record<string, unknown>>;
  /** Value the mock requires in the `cookie` header for `auth: true` routes. */
  readonly sessionCookie?: string;
}

const SESSION_COOKIE = 'session=mock-session-token';

function pathToRegExp(path: string): RegExp {
  const escaped = path
    .split('/')
    .map((segment) =>
      segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/');
  return new RegExp(`^${escaped}$`);
}

const MATCHERS = ROUTES.map((route) => ({ route, re: pathToRegExp(route.path) }));

function jsonResponse(body: unknown, status = 200): MockResponse {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body, null, 2),
  };
}

function errorResponse(
  status: number,
  code: 'unauthorized' | 'not_found' | 'method_not_allowed',
  message: string,
): MockResponse {
  return jsonResponse({ error: { code, message } }, status);
}

/** Serialise the SSE fixture as `text/event-stream` frames (deterministic ids). */
export function sseBody(events: readonly unknown[]): string {
  return events
    .map((event, index) => {
      const type =
        typeof event === 'object' && event !== null && 'type' in event
          ? String((event as { type: unknown }).type)
          : 'message';
      return `id: ${index + 1}\nevent: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
    })
    .join('');
}

function hasSession(headers: MockRequest['headers'], cookie: string): boolean {
  const raw = headers?.cookie ?? '';
  const wanted = cookie.split(';').map((part) => part.trim());
  const provided = raw.split(';').map((part) => part.trim());
  return wanted.every((pair) => provided.includes(pair));
}

export function createMockHandler(options: MockOptions = {}) {
  const fixtures: Record<string, unknown> = { ...FIXTURES, ...(options.fixtures ?? {}) };
  const cookie = options.sessionCookie ?? SESSION_COOKIE;

  return function handle(request: MockRequest): MockResponse {
    const method = request.method.toUpperCase();
    const path = request.url.split('?')[0] ?? '/';

    const pathMatches = MATCHERS.filter(({ re }) => re.test(path));
    if (pathMatches.length === 0) {
      return errorResponse(404, 'not_found', `No mock route for ${path}`);
    }

    const match = pathMatches.find(({ route }) => route.method === method);
    if (!match) {
      const allowed = pathMatches.map(({ route }) => route.method).join(', ');
      return errorResponse(
        405,
        'method_not_allowed',
        `${method} not allowed on ${path} (allowed: ${allowed})`,
      );
    }

    const route: RouteDef = match.route;
    if (route.auth && !hasSession(request.headers, cookie)) {
      return errorResponse(
        401,
        'unauthorized',
        'Session required (mock cookie: session=mock-session-token)',
      );
    }

    if (fixtures[route.id] === undefined) {
      return errorResponse(500, 'not_found', `Mock fixture missing for route "${route.id}"`);
    }

    if (route.contentType === 'text/event-stream') {
      return {
        status: 200,
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        },
        body: sseBody(
          Array.isArray(fixtures[route.id])
            ? (fixtures[route.id] as unknown[])
            : [fixtures[route.id]],
        ),
      };
    }

    return jsonResponse(fixtures[route.id], route.status ?? 200);
  };
}

/** Number of JSON endpoints the mock answers (printed at startup). */
export const MOCK_JSON_ROUTE_COUNT = JSON_ROUTES.length;

export function startMockServer(port = 4010): ReturnType<typeof createServer> {
  const handle = createMockHandler();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const headers: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      headers[name] = Array.isArray(value) ? value.join('; ') : value;
    }
    const response = handle({ method: req.method ?? 'GET', url: req.url ?? '/', headers });
    res.writeHead(response.status, response.headers);
    res.end(response.body);
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`reels-generator mock API on http://127.0.0.1:${port} — ${ROUTES.length} routes`);
    console.log(`  session cookie for auth:true routes: ${SESSION_COOKIE}`);
  });
  return server;
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  const port = Number.parseInt(process.env.PORT ?? '4010', 10);
  startMockServer(Number.isFinite(port) ? port : 4010);
}
