/**
 * B-12 acceptance tests — the RE stage against a real database (US-024, R-010-1,
 * R-013-1, R-026). FFmpeg is faked here on purpose: the child process is proven
 * by render.integration.test.ts; this file proves what the stage *writes*.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Pool } from 'pg';

import { runMigrations } from '../db/runner.js';
import { readVideoStage } from '../../tests/helpers/stage-fixtures.js';
import { readProject } from '../../tests/helpers/stage-fixtures.js';
import { FakeFfmpegRunner } from './fake-ffmpeg.js';
import { InMemoryContentAddressedStore } from '../storage/object-store.js';
import {
  createTestDatabase,
  SKIP_REASON,
  testDatabaseUrl,
  type TestDatabase,
} from '../../tests/helpers/pg.js';
import { seedRenderReadyProject, type RenderFixture } from '../../tests/helpers/render-fixtures.js';
import { runRenderStage } from './stage.js';

vi.setConfig({ testTimeout: 120_000 });
const hasDatabase = testDatabaseUrl() !== null;
if (!hasDatabase) console.warn('[B-12 render stage tests skipped] ' + SKIP_REASON);

interface AssetRowView {
  id: string;
  stage: string;
  kind: string;
  role: string | null;
  mime_type: string | null;
  content_sha256: string;
  rights_metadata: Record<string, unknown> | null;
}

async function listAssets(pool: Pool, projectId: string): Promise<AssetRowView[]> {
  const result = await pool.query<AssetRowView>(
    `SELECT a.id, a.stage, a.kind, r.role, a.mime_type, a.content_sha256, a.rights_metadata
       FROM asset a JOIN asset_ref r ON r.asset_id = a.id
      WHERE r.project_id = $1 ORDER BY r.created_at ASC, a.id ASC`,
    [projectId],
  );
  return result.rows;
}

describe.skipIf(!hasDatabase)('RE stage', () => {
  let db: TestDatabase;
  let blobs: InMemoryContentAddressedStore;

  beforeAll(async () => {
    db = await createTestDatabase();
    await runMigrations(db.pool);
    blobs = new InMemoryContentAddressedStore();
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  async function seed(): Promise<RenderFixture> {
    return seedRenderReadyProject(db.pool, blobs);
  }

  function runner(projectId: string): FakeFfmpegRunner {
    return new FakeFfmpegRunner({
      outputFile: 'output.mp4',
      outputBytes: new TextEncoder().encode('fake-mp4-bytes-' + projectId),
    });
  }

  it('renders, persists the deliverables and advances the project to QC', async () => {
    const fixture = await seed();
    const result = await runRenderStage(
      { pool: db.pool, blobs, runner: runner(fixture.projectId) },
      { jobId: fixture.reJobId, projectId: fixture.projectId },
    );

    expect(result.status).toBe('rendered');
    expect(result.duration_s).toBeCloseTo(8.6, 3);
    expect(result.caption_asset_ids).toHaveLength(2);
    expect(result.manifest_asset_id).not.toBeNull();

    const assets = await listAssets(db.pool, fixture.projectId);
    const renderAssets = assets.filter((asset) => asset.stage === 'RE');
    expect(renderAssets.map((asset) => asset.role).sort()).toEqual([
      'ass-source',
      'render-benchmark',
      'render-manifest',
      'srt',
      'video',
      'vtt',
    ]);
    const video = renderAssets.filter((asset) => asset.role === 'video');
    expect(video).toHaveLength(1);
    expect(video[0]).toMatchObject({ kind: 'video', mime_type: 'video/mp4' });
    expect(video[0]!.rights_metadata).toMatchObject({
      stage: 'RE',
      role: 'video',
      duration_ms: 8600,
      frame_count: 258,
    });
    expect(renderAssets.find((asset) => asset.role === 'srt')).toMatchObject({ kind: 'caption' });

    expect((await readVideoStage(db.pool, fixture.projectId, 'RE'))?.state).toBe('done');
    const project = await readProject(db.pool, fixture.projectId);
    expect(project?.current_stage).toBe('QC');
    const job = await db.pool.query<{ status: string }>('SELECT status FROM job WHERE id = $1', [
      fixture.reJobId,
    ]);
    expect(job.rows[0]!.status).toBe('succeeded');
  });

  it('re-running the stage reuses the content-addressed assets (R-026)', async () => {
    const fixture = await seed();
    const first = await runRenderStage(
      { pool: db.pool, blobs, runner: runner(fixture.projectId) },
      { jobId: fixture.reJobId, projectId: fixture.projectId },
    );
    expect(first.status).toBe('rendered');

    await db.pool.query(
      `UPDATE video_stage SET state = 'failed' WHERE project_id = $1 AND stage = 'RE'`,
      [fixture.projectId],
    );
    await db.pool.query(
      `UPDATE project SET status = 'RUNNING', current_stage = 'RE' WHERE id = $1`,
      [fixture.projectId],
    );
    const secondJob = await db.pool.query<{ id: string }>(
      `INSERT INTO job (project_id, stage, status) VALUES ($1, 'RE', 'running') RETURNING id`,
      [fixture.projectId],
    );
    const second = await runRenderStage(
      { pool: db.pool, blobs, runner: runner(fixture.projectId) },
      { jobId: secondJob.rows[0]!.id, projectId: fixture.projectId },
    );

    expect(second.status).toBe('rendered');
    expect(second.video_asset_id).toBe(first.video_asset_id);
    const videos = (await listAssets(db.pool, fixture.projectId)).filter(
      (asset) => asset.role === 'video',
    );
    if (videos.length === 0)
      console.log(
        'DEBUG',
        JSON.stringify(
          (await listAssets(db.pool, fixture.projectId)).filter((a) => a.stage === 'RE'),
        ),
      );
    expect(videos).toHaveLength(1);
  });

  it('refuses to render when a scene has no image and parks the project', async () => {
    const fixture = await seed();
    await db.pool.query('UPDATE scene SET asset_id = NULL WHERE id = $1', [
      fixture.sceneIds['S02'],
    ]);

    const result = await runRenderStage(
      { pool: db.pool, blobs, runner: runner(fixture.projectId) },
      { jobId: fixture.reJobId, projectId: fixture.projectId },
    );

    expect(result.status).toBe('failed');
    expect(result.error).toContain('images_missing');
    expect(result.error).toContain('S02');
    expect(result.video_asset_id).toBeNull();
    expect((await readVideoStage(db.pool, fixture.projectId, 'RE'))?.state).toBe('failed');
    expect((await readProject(db.pool, fixture.projectId))?.status).toBe('NEEDS_ATTENTION');
    const assets = await listAssets(db.pool, fixture.projectId);
    expect(assets.filter((asset) => asset.stage === 'RE')).toHaveLength(0);
  });

  it('refuses to render without a timing document', async () => {
    const fixture = await seed();
    await db.pool.query('DELETE FROM asset WHERE id = $1', [fixture.timingAssetId]);

    const result = await runRenderStage(
      { pool: db.pool, blobs, runner: runner(fixture.projectId) },
      { jobId: fixture.reJobId, projectId: fixture.projectId },
    );

    expect(result.status).toBe('failed');
    expect(result.error).toContain('timing_missing');
    expect((await readProject(db.pool, fixture.projectId))?.status).toBe('NEEDS_ATTENTION');
  });

  it('refuses when the timing document names scenes the storyboard does not have', async () => {
    const fixture = await seed();
    await db.pool.query(`DELETE FROM scene WHERE project_id = $1 AND scene_no = 'S03'`, [
      fixture.projectId,
    ]);

    const result = await runRenderStage(
      { pool: db.pool, blobs, runner: runner(fixture.projectId) },
      { jobId: fixture.reJobId, projectId: fixture.projectId },
    );

    expect(result.status).toBe('failed');
    expect(result.error).toContain('scene_plan_mismatch');
    expect(result.error).toContain('S03');
  });
});
