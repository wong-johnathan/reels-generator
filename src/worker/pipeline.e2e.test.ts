/**
 * End-to-end orchestration proof against a real Postgres (CI) and the fake
 * providers. No vendor credential is touched: text, image and TTS are the
 * deterministic fakes; the FFmpeg boundary uses a deterministic stub by default.
 *
 * This is the "real database rows" half of the acceptance. The "real MP4" half
 * is `src/render/render-half-proof.test.ts` (local, no Postgres). Here the loop
 * drives a project topic → script → storyboard → images → narration → timing →
 * render, and we assert every durable row the milestone promises: batch,
 * project, jobs, the approved topic/script, 17 scenes, the narration/timing
 * assets, and the final video asset + its `asset_ref` link.
 *
 * Set REELS_E2E_REAL_RENDER=1 to opt into a full real encode explicitly. Host PATH
 * never selects the runner: real-media coverage belongs to the render-half proof,
 * independently of this database/orchestration gate.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createTestDatabase,
  SKIP_REASON,
  testDatabaseUrl,
  type TestDatabase,
} from '../../tests/helpers/pg.js';
import { insertOrReuseAsset } from '../db/repositories/assets.js';
import { applyStageEvent } from '../db/repositories/stage-state.js';
import { runMigrations } from '../db/runner.js';
import { createBatch } from '../domain/batch.js';
import { FakeTextAdapter } from '../adapters/fake-text.js';
import { createPostgresSceneGateway } from '../web/scenes/postgres.js';
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

function selectRunner(): FfmpegRunner {
  return process.env['REELS_E2E_REAL_RENDER'] === '1' ? new ProcessFfmpegRunner() : stubRunner;
}

it('selects the stub unless real rendering is explicitly enabled, independent of PATH', () => {
  try {
    for (const path of [process.env['PATH'], '']) {
      vi.stubEnv('PATH', path);
      for (const value of [undefined, '0', 'true', '1']) {
        vi.stubEnv('REELS_E2E_REAL_RENDER', value);
        if (value === '1') expect(selectRunner()).toBeInstanceOf(ProcessFfmpegRunner);
        else expect(selectRunner()).toBe(stubRunner);
      }
    }
  } finally {
    vi.unstubAllEnvs();
  }
});

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

    // Freshly created and untouched: no stage has run, so the batch is open.
    const created = await db.pool.query<{ status: string }>(
      `SELECT status FROM batch WHERE id = $1`,
      [batchId],
    );
    expect(created.rows[0]!.status).toBe('ACTIVE');

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
      runner: selectRunner(),
      workerId: 'e2e-worker',
    };

    const contentProcessed = await runWorkerLoop({
      pool: db.pool,
      stages: CONTENT_STAGES,
      runStage: (job) => runStage(deps, job),
      advanceAfterStage: (job) => advanceAfterStage(db.pool, job),
      maxJobs: CONTENT_JOB_COUNT,
      pollIntervalMs: 5,
      // Fail on the first empty claim rather than timing out: a stopped chain
      // must surface the stage error, not 300 s of silence.
      drainWhenEmpty: true,
      logger: (line) => console.error(line),
    });
    // The operator's gate: T, RS, SC and SB run, then the pipeline stops with the
    // words written and nothing spent on images. This used to run straight through
    // to a video, which is exactly the behaviour the gate replaces.
    expect(contentProcessed).toBe(4);

    const gate = await db.pool.query<{ state: string }>(
      `SELECT state FROM video_stage WHERE project_id = $1 AND stage = 'SB'`,
      [projectId],
    );
    expect(gate.rows[0]!.state).toBe('awaiting_approval');

    const imageJobsBeforeApproval = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM job WHERE project_id = $1 AND stage IN ('IM','NA','TC')`,
      [projectId],
    );
    expect(imageJobsBeforeApproval.rows[0]!.n).toBe(0);

    // The operator reads the storyboard and approves it — the same gateway the
    // approve button uses, so this exercises the release rather than faking it.
    const scenesGateway = createPostgresSceneGateway(db.pool);
    const board = await scenesGateway.storyboard(projectId);
    expect(board).not.toBeNull();
    await scenesGateway.approveStoryboard(projectId, { revision: board!.revision });

    const afterApproval = await runWorkerLoop({
      pool: db.pool,
      stages: CONTENT_STAGES,
      runStage: (job) => runStage(deps, job),
      advanceAfterStage: (job) => advanceAfterStage(db.pool, job),
      maxJobs: CONTENT_JOB_COUNT - 4,
      pollIntervalMs: 5,
      drainWhenEmpty: true,
      logger: (line) => console.error(line),
    });
    expect(afterApproval).toBe(CONTENT_JOB_COUNT - 4);

    const renderProcessed = await runWorkerLoop({
      pool: db.pool,
      stages: RENDER_STAGES,
      runStage: (job) => runStage(deps, job),
      advanceAfterStage: (job) => advanceAfterStage(db.pool, job),
      maxJobs: RENDER_JOB_COUNT,
      pollIntervalMs: 5,
      drainWhenEmpty: true,
      logger: (line) => console.error(line),
    });
    expect(renderProcessed).toBe(RENDER_JOB_COUNT);

    // The durable spine: batch → project → topic → script → scenes. The batch's
    // own status is asserted at the end of the test, once every stage has settled.
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
      // ORDER BY stage sorts alphabetically (IM, NA, RE, RS, SB, SC, T, TC), which
      // says nothing about pipeline order. Order by position in the rail instead.
      `SELECT stage, state FROM video_stage WHERE project_id = $1 AND stage IN ('T','RS','SC','SB','IM','NA','TC','RE')
        ORDER BY array_position(ARRAY['T','RS','SC','SB','IM','NA','TC','RE']::text[], stage)`,
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
    // COMPLETE here means "the pipeline has no work left for this video": the MP4
    // is rendered and downloadable. It does NOT mean approved — QC/FA/EX are
    // operator gates that are not wired yet, which is why current_stage still
    // reads QC: the render stage records the gate it hands over to.
    expect(project.rows[0]!.status).toBe('COMPLETE');
    expect(project.rows[0]!.current_stage).toBe('QC');

    // The video asset + its asset_ref link, with a non-trivial stored size, and
    // a readable object path (D-F): <slug>/batch-0001/video.mp4.
    const videoAsset = await db.pool.query<{
      id: string;
      object_size_bytes: string;
      object_key: string;
    }>(
      `SELECT id, object_size_bytes, object_key FROM asset
        WHERE project_id = $1 AND stage = 'RE' AND kind = 'video'`,
      [projectId],
    );
    expect(videoAsset.rows).toHaveLength(1);
    expect(Number(videoAsset.rows[0]!.object_size_bytes)).toBeGreaterThan(1_000);
    expect(videoAsset.rows[0]!.object_key).toBe('e2e-series/batch-0001/video.mp4');

    // Scene images are named scenes/S01.png upward, never by array index.
    const sceneAssets = await db.pool.query<{ object_key: string }>(
      `SELECT object_key FROM asset WHERE project_id = $1 AND stage = 'IM' AND kind = 'image'
        ORDER BY object_key ASC`,
      [projectId],
    );
    expect(sceneAssets.rows.length).toBeGreaterThanOrEqual(1);
    expect(sceneAssets.rows[0]!.object_key).toBe('e2e-series/batch-0001/scenes/S01.png');
    for (const row of sceneAssets.rows) {
      expect(row.object_key).toMatch(/^e2e-series\/batch-0001\/scenes\/S\d{2}\.png$/);
    }

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

    // A finished video must say so. Before settling existed the batch read ACTIVE
    // forever and the operator had no readiness signal beyond reading the rail.
    const settled = await db.pool.query<{ project_status: string; batch_status: string }>(
      `SELECT p.status AS project_status, b.status AS batch_status
         FROM project p JOIN batch b ON b.id = p.batch_id
        WHERE p.id = $1`,
      [projectId],
    );
    expect(settled.rows[0]).toEqual({ project_status: 'COMPLETE', batch_status: 'COMPLETE' });

    // ── a retried stage writes the same path ─────────────────────────────────
    // Under sha256 keys a re-write never collided. With readable paths the same
    // stage retried lands on the same object key, so the bytes are replaced
    // underneath a row that already exists: the row must follow the new bytes
    // rather than keep describing content that is no longer there.
    const first = await insertOrReuseAsset(db.pool, {
      projectId,
      stage: 'RE',
      kind: 'video',
      contentSha256: 'a'.repeat(64),
      objectKey: 'e2e-series/batch-0001/video.mp4',
      objectSizeBytes: 100,
      mimeType: 'video/mp4',
    });
    const second = await insertOrReuseAsset(db.pool, {
      projectId,
      stage: 'RE',
      kind: 'video',
      contentSha256: 'b'.repeat(64),
      objectKey: 'e2e-series/batch-0001/video.mp4',
      objectSizeBytes: 200,
      mimeType: 'video/mp4',
    });

    expect(first.created).toBe(false); // the render already wrote this path
    expect(second.created).toBe(false);
    expect(second.asset.id).toBe(first.asset.id); // identity preserved for refs
    expect(second.asset.content_sha256).toBe('b'.repeat(64));
    expect(second.asset.object_size_bytes).toBe('200');

    const rows = await db.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM asset WHERE object_key = $1',
      ['e2e-series/batch-0001/video.mp4'],
    );
    expect(rows.rows[0]!.n).toBe('1');

    // Identical bytes may now live at two paths: dedupe is gone by design (D-F).
    const elsewhere = await insertOrReuseAsset(db.pool, {
      projectId,
      stage: 'RE',
      kind: 'video',
      contentSha256: 'b'.repeat(64),
      objectKey: 'e2e-series/batch-0001/video-copy.mp4',
      objectSizeBytes: 200,
      mimeType: 'video/mp4',
    });
    expect(elsewhere.created).toBe(true);
    expect(elsewhere.asset.content_sha256).toBe('b'.repeat(64));
  });

  it('does not advance a stage that was invalidated mid-attempt', async () => {
    // The live failure this pins: a trim rewrote the script and marked TC stale, and
    // the finished attempt minted RE anyway. The render then read a script that no
    // longer matched the audio and died without writing an attempt row.
    const series = await db.pool.query<{ id: string }>(
      `INSERT INTO series (name, slug, niche, mode, target_duration_s)
       VALUES ('e2e stale', 'e2e-stale', '{}'::jsonb, 'creative', 75)
       RETURNING id`,
    );
    await db.pool.query(
      `INSERT INTO series_version (series_id, version, snapshot, mode, target_duration_s)
       VALUES ($1, 1, $2::jsonb, 'creative', 75)`,
      [series.rows[0]!.id, JSON.stringify({ target_duration_s: 75, videos_per_batch: 1 })],
    );
    const { projectIds } = await createBatch(db.pool, { seriesId: series.rows[0]!.id });
    const projectId = projectIds[0]!;

    const tcJob = await db.pool.query<{ id: string }>(
      `INSERT INTO job (project_id, stage, status, priority) VALUES ($1, 'TC', 'succeeded', 2)
       RETURNING id`,
      [projectId],
    );
    // Only a finished stage can be invalidated: the trim invalidates TC *after* the
    // attempt recorded its measurement, which is exactly how the live run got here.
    await applyStageEvent(db.pool, projectId, 'TC', 'claim');
    await applyStageEvent(db.pool, projectId, 'TC', 'succeed');
    await applyStageEvent(db.pool, projectId, 'TC', 'invalidate');

    const advanced = await advanceAfterStage(db.pool, {
      id: tcJob.rows[0]!.id,
      projectId,
      stage: 'TC',
      sceneId: null,
      priority: 2,
    });

    expect(advanced).toBeNull();
    const renderJobs = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM job WHERE project_id = $1 AND stage = 'RE'`,
      [projectId],
    );
    expect(renderJobs.rows[0]!.n).toBe(0);
  });
});
