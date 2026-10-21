/**
 * Worker entry — health server + job loop.
 *
 * The job loop (B-04) is the orchestration spine: it claims queued jobs with
 * `SELECT … FOR UPDATE SKIP LOCKED`, dispatches each through the stage runners
 * in `orchestrator.ts`, and advances the pipeline. On SIGTERM it stops
 * *between* jobs (finishing the in-flight one) within the 30 s grace period.
 *
 * Provider adapters are the **fake** ones for this milestone (no credentials):
 * the real DeepSeek/Gemini/ElevenLabs adapters land with their provider cards
 * (B-06/B-08) and are a config change, not an orchestration change.
 */
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

import { createDependencyProbe } from '../api/server.js';
import { createPool } from '../db/client.js';
import { ensureBucket, InMemoryBucketStore } from '../storage/object-store.js';
import { FakeTextAdapter } from '../adapters/fake-text.js';
import { FakeTtsAdapter } from '../adapters/tts.js';
import { FakeImageAdapter } from '../adapters/fake-image.js';
import { InMemoryImageQualificationStore } from '../adapters/image-qualification.js';
import { ProcessFfmpegRunner } from '../render/ffmpeg.js';
import { SharedBlobStore } from './blobs.js';
import { runWorkerLoop } from './loop.js';
import {
  advanceAfterStage,
  CONTENT_STAGES,
  RENDER_STAGES,
  runStage,
  seedFakeImageQualification,
  type OrchestratorDeps,
} from './orchestrator.js';

export const WORKER_ROLES = ['content', 'render'] as const;
export type WorkerRole = (typeof WORKER_ROLES)[number];

export function resolveWorkerRole(value: string | undefined): WorkerRole {
  return value === 'render' ? 'render' : 'content';
}

/** R-018: the bucket is ensured at boot, idempotently — never `mc mb` by hand. */
export async function ensureWorkerBucket(env: NodeJS.ProcessEnv): Promise<{ created: boolean }> {
  const bucket = env.MINIO_BUCKET ?? 'reels';
  return ensureBucket(new InMemoryBucketStore(), bucket);
}

/** The fake-provider dependency graph for the milestone loop. */
export async function buildWorkerDeps(env: NodeJS.ProcessEnv): Promise<OrchestratorDeps> {
  const blobs = new SharedBlobStore();
  const qualification = new InMemoryImageQualificationStore();
  await seedFakeImageQualification(qualification);
  return {
    pool: createPool(env),
    text: new FakeTextAdapter(),
    tts: new FakeTtsAdapter(),
    image: new FakeImageAdapter(),
    qualification,
    contentBlobs: blobs.asset,
    renderBlobs: blobs.content,
    runner: new ProcessFfmpegRunner(),
    workerId: env.HOSTNAME ?? 'worker',
  };
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
    console.log(`${options.role}-worker ready on :${options.port}`);
  });
  return server;
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  const role = resolveWorkerRole(process.env.ROLE);
  const stages = role === 'render' ? RENDER_STAGES : CONTENT_STAGES;
  const port = Number.parseInt(
    process.env.WORKER_HTTP_PORT ?? (role === 'render' ? '8082' : '8081'),
    10,
  );

  void ensureWorkerBucket(process.env).then((result) => {
    console.log(
      `bucket ${process.env.MINIO_BUCKET ?? 'reels'} ${result.created ? 'created' : 'already present'}`,
    );
  });

  const server = startWorkerHealthServer({
    port,
    role,
    probe: createDependencyProbe(process.env),
  });

  let stopping = false;
  process.on('SIGTERM', () => {
    console.log(`${role}-worker received SIGTERM; finishing the current job, then exiting`);
    stopping = true;
  });
  process.on('SIGINT', () => {
    console.log(`${role}-worker received SIGINT; finishing the current job, then exiting`);
    stopping = true;
  });

  void (async () => {
    const deps = await buildWorkerDeps(process.env);
    const processed = await runWorkerLoop({
      pool: deps.pool,
      stages,
      runStage: (job) => runStage(deps, job),
      advanceAfterStage: (job) => advanceAfterStage(deps.pool, job),
      shouldStop: () => stopping,
      logger: (message) => console.log(`[${role}] ${message}`),
    });
    console.log(`${role}-worker loop exited after ${processed} job(s); closing health server`);
    server.close(() => process.exit(0));
  })();
}
