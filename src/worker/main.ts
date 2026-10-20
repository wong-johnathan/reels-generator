/**
 * Worker scaffold — B-01.
 *
 * Milestone A's job consumption (BullMQ queues + adapters) lands with B-04…B-12;
 * this process exists so the `worker` image starts, validates its environment
 * and reports readiness on an internal port for compose's healthcheck. It
 * deliberately consumes nothing yet, so it cannot double-run a stage.
 */
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

import { createDependencyProbe } from '../api/server.js';

export const WORKER_ROLES = ['content', 'render'] as const;
export type WorkerRole = (typeof WORKER_ROLES)[number];

export function resolveWorkerRole(value: string | undefined): WorkerRole {
  return value === 'render' ? 'render' : 'content';
}

export function startWorkerHealthServer(options: {
  port: number;
  role: WorkerRole;
  probe: () => Promise<{ ready: boolean; degraded_reasons: readonly string[] }>;
}): ReturnType<typeof createServer> {
  const server = createServer((req, res) => {
    if (req.url?.split('?')[0] !== '/readyz') {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({ error: { code: 'not_found', message: 'worker exposes /readyz only' } }),
      );
      return;
    }
    void options.probe().then((readiness) => {
      res.writeHead(readiness.ready ? 200 : 503, {
        'content-type': 'application/json; charset=utf-8',
      });
      res.end(
        JSON.stringify({
          ready: readiness.ready,
          degraded_reasons: [...readiness.degraded_reasons],
        }),
      );
    });
  });

  server.listen(options.port, '0.0.0.0', () => {
    console.log(
      `${options.role}-worker ready on :${options.port} — job queues land in B-04+ (B-01 scaffold)`,
    );
  });
  return server;
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  const role = resolveWorkerRole(process.env.ROLE);
  const port = Number.parseInt(
    process.env.WORKER_HTTP_PORT ?? (role === 'render' ? '8082' : '8081'),
    10,
  );
  const server = startWorkerHealthServer({ port, role, probe: createDependencyProbe(process.env) });

  const shutdown = (signal: string): void => {
    console.log(`${role}-worker received ${signal}; closing health server`);
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
