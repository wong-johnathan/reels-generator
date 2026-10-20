/**
 * Minimal web entrypoint for B-01.
 *
 * B-01 owns the scaffold, not the API surface: this server answers the two
 * probes compose needs and refuses everything else with the contract's error
 * envelope. S-01…S-21 handlers land in later cards against `contract/api.ts`.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { pathToFileURL } from 'node:url';

import { validateEnv, formatIssues } from '../config/env.js';

export interface Readiness {
  readonly ready: boolean;
  readonly degraded_reasons: readonly string[];
}

export type HealthProbe = () => Promise<Readiness>;

export interface HandlerResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' } as const;

function envelope(code: string, message: string, status: number): HandlerResponse {
  return { status, headers: JSON_HEADERS, body: JSON.stringify({ error: { code, message } }) };
}

/**
 * Route the probe endpoints. Pure and injectable so the compose-contract tests
 * run without binding a socket or requiring a database.
 */
export function createRequestHandler(probe: HealthProbe) {
  return async function handle(request: { method: string; url: string }): Promise<HandlerResponse> {
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

export function startServer(options: {
  port: number;
  probe: HealthProbe;
  host?: string;
}): ReturnType<typeof createServer> {
  const handle = createRequestHandler(options.probe);
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle({ method: req.method ?? 'GET', url: req.url ?? '/' }).then((response) => {
      res.writeHead(response.status, response.headers);
      res.end(response.body);
    });
  });
  server.listen(options.port, options.host ?? '0.0.0.0', () => {
    console.log(`reels-generator web listening on ${options.host ?? '0.0.0.0'}:${options.port}`);
  });
  return server;
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  const role = 'web' as const;
  const result = validateEnv(process.env, role);
  if (!result.ok) {
    // The container entrypoint already validated; this is the belt-and-braces path.
    console.error(formatIssues(result.issues, role));
    process.exit(1);
  }
  startServer({
    port: Number.parseInt(result.values.APP_PORT ?? '8080', 10),
    probe: createDependencyProbe(process.env),
  });
}
