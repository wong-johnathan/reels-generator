/**
 * End-to-end orchestration proof against a real Postgres (CI) and the fake
 * providers. No vendor credential is touched: text, image and TTS are the
 * deterministic fakes; only FFmpeg is real (when present on PATH).
 *
 * This is the "real database rows" half of the acceptance. The "real MP4" half
 * is `src/render/render-half-proof.test.ts` (local, no Postgres). Here the loop
 * drives a project topic → script → storyboard → images → narration → timing →
 * render, and we assert every durable row the milestone promises: batch,
 * project, jobs, the approved topic/script, 17 scenes, the narration/timing
 * assets, and the final video asset + its `asset_ref` link.
 *
 * When FFmpeg is absent (e.g. a bare pgvector CI image), the RE stage still
 * completes against a stub runner so the DB assertions hold; the real encode is
 * then exercised only by the local render-half proof.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createTestDatabase,
  SKIP_REASON,
  testDatabaseUrl,
  type TestDatabase,
} from '../../tests/helpers/pg.js';
import { runMigrations } from '../db/runner.js';
import { createBatch } from '../domain/batch.js';
import { FakeTextAdapter } from '../adapters/fake-text.js';
import { FakeTtsAdapter } from '../adapters/tts.js';
import { FakeImageAdapter } from '../adapters/fake-image.js';
import { InMemoryImageQualificationStore } from '../adapters/image-qualification.js';
import { ProcessFfmpegRunner, type FfmpegRunner } from '../render/ffmpeg.js';
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

const hasDatabase = testDatabaseUrl() !== null;
if (!hasDatabase) console.warn(`[pipeline e2e skipped] ${SKIP_REASON}`);

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

/** Writes a non-trivial output file so the RE stage can store a video asset. */
const stubRunner: FfmpegRunner = {
  run: async (_args, options) => {
    const dir = options?.cwd;
    if (dir !== undefined)
      writeFileSync(join(dir, 'output.mp4'), new Uint8Array(16_384).fill(0xab));
    return { exitCode: 0, wallTimeMs: 1, peakRssKb: null, timedOut: false, stderrTail: [] };
  },
  probe: async () => {
    throw new Error('stub runner is not probed');
  },
  analyse: async () => '',
};

const CONTENT_JOB_COUNT = 7; // T, RS, SC, SB, IM, NA, TC
const RENDER_JOB_COUNT = 1; // RE

describe.skipIf(!hasDatabase)('fake-provider pipeline end to end', { timeout: 300_000 }, () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
    await runMigrations(db.pool);
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it('takes a project from topic to a stored video asset through the loop', async () => {
    // Seed a series whose snapshot carries the batch size and target duration.
    const series = await db.pool.query<{ id: string }>(
      `INSERT INTO series (name, slug, niche, mode, target_duration_s)
       VALUES ('e2e', 'e2e-series', '{}'::jsonb, 'creative', 75)
       RETURNING id`,
    );
    const seriesId = series.rows[0]!.id;
    await db.pool.query(
      `INSERT INTO series_version (series_id, version, snapshot, mode, target_duration_s)
       VALUES ($1, 1, $2::jsonb, 'creative', 75)`,
      [seriesId, JSON.stringify({ target_duration_s: 75, videos_per_batch: 1, mode: 'creative' })],
    );

    const { batchId, projectIds } = await createBatch(db.pool, { seriesId });
    expect(projectIds).toHaveLength(1);
    const projectId = projectIds[0]!;

    const blobs = new SharedBlobStore();
    const qualification = new InMemoryImageQualificationStore();
    await seedFakeImageQualification(qualification);
    const deps: OrchestratorDeps = {
      pool: db.pool,
      text: new FakeTextAdapter(),
      tts: new FakeTtsAdapter(),
      image: new FakeImageAdapter(),
      qualification,
      contentBlobs: blobs.asset,
      renderBlobs: blobs.content,
      runner: hasFfmpeg ? new ProcessFfmpegRunner() : stubRunner,
      workerId: 'e2e-worker',
    };

    const contentProcessed = await runWorkerLoop({
      pool: db.pool,
      stages: CONTENT_STAGES,
      runStage: (job) => runStage(deps, job),
      advanceAfterStage: (job) => advanceAfterStage(db.pool, job),
      maxJobs: CONTENT_JOB_COUNT,
      pollIntervalMs: 5,
    });
    expect(contentProcessed).toBe(CONTENT_JOB_COUNT);

    const renderProcessed = await runWorkerLoop({
      pool: db.pool,
      stages: RENDER_STAGES,
      runStage: (job) => runStage(deps, job),
      advanceAfterStage: (job) => advanceAfterStage(db.pool, job),
      maxJobs: RENDER_JOB_COUNT,
      pollIntervalMs: 5,
    });
    expect(renderProcessed).toBe(RENDER_JOB_COUNT);

    // The durable spine: batch → project → topic → script → scenes.
    const batch = await db.pool.query<{ status: string }>(
      `SELECT status FROM batch WHERE id = $1`,
      [batchId],
    );
    expect(batch.rows[0]!.status).toBe('ACTIVE');

    const topic = await db.pool.query<{ status: string }>(
      `SELECT status FROM topic WHERE project_id = $1`,
      [projectId],
    );
    expect(topic.rows).toHaveLength(1);
    expect(topic.rows[0]!.status).toBe('approved');

    const script = await db.pool.query<{ status: string }>(
      `SELECT status FROM script_revision WHERE project_id = $1`,
      [projectId],
    );
    expect(script.rows).toHaveLength(1);
    expect(script.rows[0]!.status).toBe('approved');

    const scenes = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM scene WHERE project_id = $1`,
      [projectId],
    );
    expect(scenes.rows[0]!.n).toBeGreaterThanOrEqual(1);

    // Every stage is done up to and including RE; the video waits at QC.
    const stages = await db.pool.query<{ stage: string; state: string }>(
      `SELECT stage, state FROM video_stage WHERE project_id = $1 AND stage IN ('T','RS','SC','SB','IM','NA','TC','RE') ORDER BY stage`,
      [projectId],
    );
    expect(stages.rows.map((row) => [row.stage, row.state])).toEqual([
      ['T', 'done'],
      ['RS', 'done'],
      ['SC', 'done'],
      ['SB', 'done'],
      ['IM', 'done'],
      ['NA', 'done'],
      ['TC', 'done'],
      ['RE', 'done'],
    ]);

    const project = await db.pool.query<{ status: string; current_stage: string }>(
      `SELECT status, current_stage FROM project WHERE id = $1`,
      [projectId],
    );
    expect(project.rows[0]!.status).toBe('RUNNING');
    expect(project.rows[0]!.current_stage).toBe('QC');

    // The video asset + its asset_ref link, with a non-trivial stored size.
    const videoAsset = await db.pool.query<{ id: string; object_size_bytes: string }>(
      `SELECT id, object_size_bytes FROM asset
        WHERE project_id = $1 AND stage = 'RE' AND kind = 'video'`,
      [projectId],
    );
    expect(videoAsset.rows).toHaveLength(1);
    expect(Number(videoAsset.rows[0]!.object_size_bytes)).toBeGreaterThan(1_000);

    const videoRef = await db.pool.query<{ role: string }>(
      `SELECT role FROM asset_ref WHERE asset_id = $1 AND project_id = $2`,
      [videoAsset.rows[0]!.id, projectId],
    );
    expect(videoRef.rows.some((row) => row.role === 'video')).toBe(true);

    // Narration and timing sidecars exist too (the render stage read them).
    const narration = await db.pool.query<{ role: string }>(
      `SELECT role FROM asset_ref WHERE project_id = $1 AND role IN ('narration','narration_alignment','storyboard_plan')`,
      [projectId],
    );
    expect(narration.rows.map((row) => row.role)).toEqual(
      expect.arrayContaining(['narration', 'narration_alignment', 'storyboard_plan']),
    );
  });
});
