/**
 * Regression: TC must open its own `job_attempt` row before the timing stage
 * runs, so the overshoot repair can record its trim under that attempt.
 *
 * The live failure this pins: IM and NA succeeded, then TC's overshoot repair
 * queried the *latest* `job_attempt` for the job, found none (TC never opened
 * one), and failed the take non-retryably with
 * "no attempt row to record the trim against". Opening the attempt up front and
 * passing its id straight into `repairOvershoot` removes the dependency on a
 * pre-existing row.
 *
 * Postgres-gated like the rest of the spine tests (TEST_DATABASE_URL).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createTestDatabase,
  SKIP_REASON,
  testDatabaseUrl,
  type TestDatabase,
} from '../../tests/helpers/pg.js';
import { FakeImageAdapter } from '../adapters/fake-image.js';
import { InMemoryImageQualificationStore } from '../adapters/image-qualification.js';
import { FakeTextAdapter } from '../adapters/fake-text.js';
import { FakeTtsAdapter } from '../adapters/tts.js';
import { runMigrations } from '../db/runner.js';
import { createBatch } from '../domain/batch.js';
import type { FfmpegRunner } from '../render/ffmpeg.js';
import { createPostgresSceneGateway } from '../web/scenes/postgres.js';
import { SharedBlobStore } from './blobs.js';
import { runWorkerLoop } from './loop.js';
import {
  advanceAfterStage,
  CONTENT_STAGES,
  runStage,
  seedFakeImageQualification,
  type OrchestratorDeps,
} from './orchestrator.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
const hasDatabase = testDatabaseUrl() !== null;
if (!hasDatabase) console.warn(`[TC attempt-row regression skipped] ${SKIP_REASON}`);

/** RE is never driven here; the runner only has to satisfy the deps type. */
const stubRunner: FfmpegRunner = {
  run: async () => ({
    exitCode: 0,
    wallTimeMs: 1,
    peakRssKb: null,
    timedOut: false,
    stderrTail: [],
  }),
  probe: async () => {
    throw new Error('stub runner is not probed');
  },
  analyse: async () => '',
};

describe.skipIf(!hasDatabase)('TC opens its attempt before the overshoot repair', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
    await runMigrations(db.pool);
  }, 240_000);

  afterAll(async () => {
    await db?.close();
  });

  it('repairs an over-band take when no job_attempt row pre-exists', async () => {
    const series = await db.pool.query<{ id: string }>(
      `INSERT INTO series (name, slug, niche, mode, target_duration_s)
       VALUES ('tc-regression', 'tc-regression-series', '{}'::jsonb, 'creative', 75)
       RETURNING id`,
    );
    const seriesId = series.rows[0]!.id;
    await db.pool.query(
      `INSERT INTO series_version (series_id, version, snapshot, mode, target_duration_s)
       VALUES ($1, 1, $2::jsonb, 'creative', 75)`,
      [seriesId, JSON.stringify({ target_duration_s: 75, videos_per_batch: 1, mode: 'creative' })],
    );

    const { projectIds } = await createBatch(db.pool, { seriesId });
    const projectId = projectIds[0]!;

    const blobs = new SharedBlobStore();
    const qualification = new InMemoryImageQualificationStore();
    await seedFakeImageQualification(qualification);
    // A slow fake TTS narrates the ~228-word script long enough to overshoot the
    // 75 s band, which is what forces the timing repair under test.
    const deps: OrchestratorDeps = {
      pool: db.pool,
      text: new FakeTextAdapter(),
      tts: new FakeTtsAdapter({ rateLimitPerMinute: 600, wordsPerSecond: 2.0 }),
      image: new FakeImageAdapter(),
      qualification,
      contentBlobs: blobs.asset,
      renderBlobs: blobs.content,
      runner: stubRunner,
      workerId: 'tc-regression-worker',
    };

    // Topic → script → storyboard: the operator gate parks the loop at SB.
    await runWorkerLoop({
      pool: db.pool,
      stages: CONTENT_STAGES,
      runStage: (job) => runStage(deps, job),
      advanceAfterStage: (job) => advanceAfterStage(db.pool, job),
      maxJobs: 4,
      pollIntervalMs: 5,
      drainWhenEmpty: true,
    });

    const scenesGateway = createPostgresSceneGateway(db.pool);
    const board = await scenesGateway.storyboard(projectId);
    await scenesGateway.approveStoryboard(projectId, { revision: board!.revision });

    // Images + narration only; stop before TC so its attempt ledger is empty.
    await runWorkerLoop({
      pool: db.pool,
      stages: ['IM', 'NA'],
      runStage: (job) => runStage(deps, job),
      advanceAfterStage: (job) => advanceAfterStage(db.pool, job),
      maxJobs: 2,
      pollIntervalMs: 5,
      drainWhenEmpty: true,
    });

    // Precondition: TC is queued and has never opened an attempt row.
    const tcJob = await db.pool.query<{ id: string }>(
      `SELECT id FROM job WHERE project_id = $1 AND stage = 'TC' ORDER BY created_at DESC LIMIT 1`,
      [projectId],
    );
    expect(tcJob.rows).toHaveLength(1);
    const attemptsBefore = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM job_attempt WHERE job_id = $1`,
      [tcJob.rows[0]!.id],
    );
    expect(attemptsBefore.rows[0]!.n).toBe(0);

    // Run TC: the take overshoots and must be repaired, not failed with the
    // "no attempt row to record the trim against" error.
    await runWorkerLoop({
      pool: db.pool,
      stages: ['TC'],
      runStage: (job) => runStage(deps, job),
      advanceAfterStage: (job) => advanceAfterStage(db.pool, job),
      maxJobs: 1,
      pollIntervalMs: 5,
      drainWhenEmpty: true,
    });

    // The repair opened and spent a job_attempt row: a repaired take marks the
    // job failed so NA's success mints a fresh TC job for the trimmed script.
    const attempts = await db.pool.query<{ status: string; attempt_no: number }>(
      `SELECT status, attempt_no FROM job_attempt WHERE job_id = $1 ORDER BY attempt_no`,
      [tcJob.rows[0]!.id],
    );
    expect(attempts.rows).toHaveLength(1);
    expect(attempts.rows[0]!.attempt_no).toBe(1);
    expect(attempts.rows[0]!.status).toBe('failed');

    // The trim applied: a second script revision exists (original + trimmed),
    // and NA is re-queued rather than the project parked needs-attention at TC.
    const revisions = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM script_revision WHERE project_id = $1`,
      [projectId],
    );
    expect(revisions.rows[0]!.n).toBeGreaterThanOrEqual(2);
    const naJob = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM job WHERE project_id = $1 AND stage = 'NA'`,
      [projectId],
    );
    expect(naJob.rows[0]!.n).toBeGreaterThanOrEqual(1);
  });
});
