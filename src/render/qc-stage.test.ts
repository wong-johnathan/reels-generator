/**
 * B-12 acceptance tests — the QC stage (US-025, R-010-2…7) against a real
 * database. The render is produced by the RE stage itself with a fake FFmpeg,
 * then QC runs with a fake whose probe/luminance/caption regions are derived
 * from the manifest the render wrote — so the *wiring* is real even though the
 * binary is not. render.integration.test.ts proves the binary.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Pool } from 'pg';

import { readVideoStage, readProject } from '../../tests/helpers/stage-fixtures.js';
import { runMigrations } from '../db/runner.js';
import { FakeFfmpegRunner } from './fake-ffmpeg.js';
import { InMemoryContentAddressedStore } from '../storage/object-store.js';
import {
  createTestDatabase,
  SKIP_REASON,
  testDatabaseUrl,
  type TestDatabase,
} from '../../tests/helpers/pg.js';
import {
  fakeForManifest,
  seedRenderReadyProject,
  type RenderFixture,
} from '../../tests/helpers/render-fixtures.js';
import type { RenderManifest } from './render.js';
import { runQcStage } from './qc-stage.js';
import { runRenderStage } from './stage.js';

vi.setConfig({ testTimeout: 120_000 });
const hasDatabase = testDatabaseUrl() !== null;
if (!hasDatabase) console.warn('[B-12 QC stage tests skipped] ' + SKIP_REASON);

interface ManifestRow {
  object_key: string;
}

describe.skipIf(!hasDatabase)('QC stage', () => {
  let db: TestDatabase;
  let blobs: InMemoryContentAddressedStore;
  afterEach(() => vi.unstubAllEnvs());

  it('with automatic approval ON records FA only after a real QC pass and queues EX', async () => {
    vi.stubEnv('AUTO_APPROVE_ALL', 'true');
    const { fixture, manifest } = await rendered();
    const result = await runQcStage(
      { pool: db.pool, blobs, runner: fakeForManifest(manifest) },
      { jobId: fixture.qcJobId, projectId: fixture.projectId },
    );
    expect(result.status, result.error ?? '').toBe('pass');
    const decisions = await db.pool.query(
      "SELECT decision, reason, revision_at_decision FROM review_decision WHERE project_id = $1 AND stage = 'FA'",
      [fixture.projectId],
    );
    expect(decisions.rows).toEqual([
      { decision: 'approve', reason: 'auto_approve_all', revision_at_decision: 1 },
    ]);
    expect((await readVideoStage(db.pool, fixture.projectId, 'FA'))?.state).toBe('done');
    expect((await readProject(db.pool, fixture.projectId))?.current_stage).toBe('EX');
  });

  beforeAll(async () => {
    db = await createTestDatabase();
    await runMigrations(db.pool);
    blobs = new InMemoryContentAddressedStore();
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  async function rendered(): Promise<{ fixture: RenderFixture; manifest: RenderManifest }> {
    const fixture = await seedRenderReadyProject(db.pool, blobs);
    const render = await runRenderStage(
      {
        pool: db.pool,
        blobs,
        runner: new FakeFfmpegRunner({
          outputFile: 'output.mp4',
          outputBytes: new TextEncoder().encode('fake-mp4-bytes-' + fixture.projectId),
        }),
      },
      { jobId: fixture.reJobId, projectId: fixture.projectId },
    );
    expect(render.status).toBe('rendered');

    const row = await db.pool.query<ManifestRow>(
      `SELECT a.object_key FROM asset a JOIN asset_ref r ON r.asset_id = a.id
        WHERE r.project_id = $1 AND r.role = 'render-manifest'
        ORDER BY r.created_at DESC LIMIT 1`,
      [fixture.projectId],
    );
    const stored = await blobs.get(row.rows[0]!.object_key);
    const manifest = JSON.parse(new TextDecoder().decode(stored!.bytes)) as RenderManifest;
    return { fixture, manifest };
  }

  async function qcRows(pool: Pool, projectId: string) {
    const result = await pool.query<{
      id: string;
      role: string | null;
      status: string | null;
      content_sha256: string;
    }>(
      `SELECT a.id, r.role, a.rights_metadata->>'status' AS status, a.content_sha256
         FROM asset a JOIN asset_ref r ON r.asset_id = a.id
        WHERE r.project_id = $1 AND a.stage = 'QC' ORDER BY r.created_at ASC`,
      [projectId],
    );
    return result.rows;
  }

  it('passes a conforming render, stores the report and opens the FA gate', async () => {
    const { fixture, manifest } = await rendered();

    const result = await runQcStage(
      { pool: db.pool, blobs, runner: fakeForManifest(manifest) },
      { jobId: fixture.qcJobId, projectId: fixture.projectId },
    );

    expect(result.status, result.error || '').toBe('pass');
    expect(result.checks).toHaveLength(6);
    expect(result.checks.every((check) => check.pass)).toBe(true);
    expect(result.report_asset_id).not.toBeNull();

    const rows = await qcRows(db.pool, fixture.projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: 'qc-report', status: 'pass' });

    expect((await readVideoStage(db.pool, fixture.projectId, 'QC'))?.state).toBe('done');
    // The gate opens, but nothing here approves anything: FA is awaiting_approval.
    expect((await readVideoStage(db.pool, fixture.projectId, 'FA'))?.state).toBe(
      'awaiting_approval',
    );
    expect((await readProject(db.pool, fixture.projectId))?.current_stage).toBe('FA');
  });

  it('fails QC on a blank frame, parks the project and does not open the gate', async () => {
    vi.stubEnv('AUTO_APPROVE_ALL', 'true');
    const { fixture, manifest } = await rendered();
    const luminance = Array.from({ length: manifest.total_frames }, () => 120);
    luminance[12] = 5;

    const result = await runQcStage(
      { pool: db.pool, blobs, runner: fakeForManifest(manifest, { luminance }) },
      { jobId: fixture.qcJobId, projectId: fixture.projectId },
    );

    expect(result.status, result.error || '').toBe('fail');
    const blank = result.checks.find((check) => check.id === 'blank_white');
    expect(blank?.pass).toBe(false);

    const rows = await qcRows(db.pool, fixture.projectId);
    expect(rows[0]).toMatchObject({ role: 'qc-report', status: 'fail' });
    expect((await readVideoStage(db.pool, fixture.projectId, 'QC'))?.state).toBe('failed');
    expect((await readVideoStage(db.pool, fixture.projectId, 'FA'))?.state).toBe('not_run');
    expect((await readProject(db.pool, fixture.projectId))?.status).toBe('NEEDS_ATTENTION');
    const job = await db.pool.query<{ status: string }>('SELECT status FROM job WHERE id = $1', [
      fixture.qcJobId,
    ]);
    expect(job.rows[0]!.status).toBe('failed');
    const decisions = await db.pool.query(
      "SELECT id FROM review_decision WHERE project_id = $1 AND stage = 'FA'",
      [fixture.projectId],
    );
    expect(decisions.rows).toEqual([]);
  });

  it('fails QC when caption ink leaves the safe area', async () => {
    const { fixture, manifest } = await rendered();
    const result = await runQcStage(
      {
        pool: db.pool,
        blobs,
        runner: fakeForManifest(manifest, { captionRegions: { outside: 200, inside: 255 } }),
      },
      { jobId: fixture.qcJobId, projectId: fixture.projectId },
    );

    expect(result.status, result.error || '').toBe('fail');
    expect(result.checks.find((check) => check.id === 'caption_safe_area')?.pass).toBe(false);
  });

  it('refuses to QC a render that has no ass-source sidecar', async () => {
    vi.stubEnv('AUTO_APPROVE_ALL', 'true');
    const { fixture, manifest } = await rendered();
    await db.pool.query(
      `DELETE FROM asset WHERE id IN (SELECT asset_id FROM asset_ref
        WHERE project_id = $1 AND role = 'ass-source')`,
      [fixture.projectId],
    );

    const result = await runQcStage(
      { pool: db.pool, blobs, runner: fakeForManifest(manifest) },
      { jobId: fixture.qcJobId, projectId: fixture.projectId },
    );
    expect(result.status, result.error || '').toBe('error');
    expect(result.error).toContain('ass_source_missing');
    expect((await readProject(db.pool, fixture.projectId))?.status).toBe('NEEDS_ATTENTION');
  });
});
