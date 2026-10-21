/**
 * Worker entry — health server + job loop.
 *
 * The job loop (B-04) is the orchestration spine: it claims queued jobs with
 * `SELECT … FOR UPDATE SKIP LOCKED`, dispatches each through the stage runners
 * in `orchestrator.ts`, and advances the pipeline. On SIGTERM it stops
 * *between* jobs (finishing the in-flight one) within the 30 s grace period.
 *
 * Provider adapters are selected by configuration (`src/worker/providers.ts`):
 * `PROVIDERS=fake` opts into the deterministic fixtures; otherwise the real
 * DeepSeek/Gemini/ElevenLabs adapters are wired and all three credentials are
 * required, so a half-configured stack refuses to start (like the MINIO binding).
 */
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

import { createDependencyProbe } from '../api/server.js';
import { createPool } from '../db/client.js';
import { ensureBucket, type ContentAddressedStore } from '../storage/object-store.js';
import { createS3Stores, s3ConfigFromEnv } from '../storage/s3-store.js';
import {
  InMemoryImageQualificationStore,
  PgImageQualificationStore,
} from '../adapters/image-qualification.js';
import {
  isFakeProviderMode,
  resolveVoiceId,
  selectImageAdapter,
  selectTextAdapter,
  selectTtsAdapter,
} from './providers.js';
import { BlobNotFoundError, type AssetBlobStore } from '../workers/asset-store.js';
import { ProcessFfmpegRunner } from '../render/ffmpeg.js';
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

/**
 * An `AssetBlobStore` facade over a `ContentAddressedStore` — the narration and
 * timing stages address the same S3 bucket through their own port, so both
 * production ports share one S3 client (the same role `SharedBlobStore` plays
 * for the in-memory fake path).
 */
function assetBlobStore(content: ContentAddressedStore): AssetBlobStore {
  return {
    put: async (objectKey, bytes, contentType) => {
      await content.put(objectKey, bytes, contentType);
    },
    get: async (objectKey) => {
      const stored = await content.get(objectKey);
      if (stored === null) throw new BlobNotFoundError(objectKey);
      return stored.bytes;
    },
    has: (objectKey) => content.has(objectKey),
  };
}

/**
 * R-018: the bucket is ensured at boot, idempotently — never `mc mb` by hand.
 * The S3/MinIO binding is a hard production dependency: `s3ConfigFromEnv`
 * throws (naming every missing key) rather than falling back to in-memory.
 */
export async function ensureWorkerBucket(env: NodeJS.ProcessEnv): Promise<{ created: boolean }> {
  const stores = createS3Stores(s3ConfigFromEnv(env));
  return ensureBucket(stores.bucket, stores.bucketName);
}

/** The production dependency graph: providers selected by configuration. */
export async function buildWorkerDeps(env: NodeJS.ProcessEnv): Promise<OrchestratorDeps> {
  const stores = createS3Stores(s3ConfigFromEnv(env));
  const pool = createPool(env);
  const fakeMode = isFakeProviderMode(env);

  // Fake mode pre-qualifies the fixture image adapter by construction (the only
  // case where that is honest). Real mode reads `provider_qualification` from
  // Postgres, so nothing is qualified until a real qualification run is recorded.
  const qualification = fakeMode
    ? new InMemoryImageQualificationStore()
    : new PgImageQualificationStore(pool);

  if (fakeMode) {
    await seedFakeImageQualification(qualification);
  } else {
    // R-008-3: the image gate is closed by default. Say so, and say what opens
    // it — never seed a fake pass, and never bypass the gate.
    console.log(
      'image qualification gate is unqualified: no provider_qualification row exists for ' +
        'gemini/GeminiImageAdapter, so the image stage will refuse to render. Run the image ' +
        'qualification flow (runImageQualification) to open the gate.',
    );
  }

  const defaultVoiceId = fakeMode ? undefined : resolveVoiceId(undefined, env.ELEVENLABS_VOICE_ID);
  // The series snapshot does not carry voice_config.model_id, so without this the
  // loader falls back to the fixture's model name and ElevenLabs rejects it.
  const defaultModelId = fakeMode ? undefined : env.ELEVENLABS_MODEL_ID;

  return {
    pool,
    text: selectTextAdapter(env),
    tts: selectTtsAdapter(env),
    image: selectImageAdapter(env),
    qualification,
    contentBlobs: assetBlobStore(stores.content),
    renderBlobs: stores.content,
    runner: new ProcessFfmpegRunner(),
    workerId: env.HOSTNAME ?? 'worker',
    defaultVoiceId,
    defaultModelId,
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
  async function run(): Promise<void> {
    const role = resolveWorkerRole(process.env.ROLE);
    const stages = role === 'render' ? RENDER_STAGES : CONTENT_STAGES;
    const port = Number.parseInt(
      process.env.WORKER_HTTP_PORT ?? (role === 'render' ? '8082' : '8081'),
      10,
    );

    // R-018 + the production object-store binding. `s3ConfigFromEnv` throws a
    // key-naming error when MINIO_* is absent, so a worker that cannot reach
    // object storage fails before the health server opens — never in-memory.
    const bucket = await ensureWorkerBucket(process.env);
    console.log(
      `bucket ${process.env.MINIO_BUCKET} ${bucket.created ? 'created' : 'already present'}`,
    );

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
  }

  void run().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`worker: refusing to start — ${message}`);
    process.exit(1);
  });
}
