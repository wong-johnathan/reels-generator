/**
 * B-12 acceptance tests — the EX stage against a real database (US-026,
 * R-005-3, R-014-1, R-027-4).
 *
 * The render and the QC report are produced by the real RE and QC stages over
 * faked FFmpeg/ffprobe, so the gate the export walks through is the one the
 * pipeline actually writes.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Pool } from 'pg';

import { recordReviewDecision } from '../db/repositories/review-decisions.js';
import { runMigrations } from '../db/runner.js';
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
import { runQcStage } from '../render/qc-stage.js';
import { runRenderStage } from '../render/stage.js';
import { FakeFfmpegRunner } from '../render/fake-ffmpeg.js';
import type { RenderManifest } from '../render/render.js';
import { runExportStage } from './stage.js';

vi.setConfig({ testTimeout: 180_000 });
const hasDatabase = testDatabaseUrl() !== null;
if (!hasDatabase) console.warn('[B-12 export stage tests skipped] ' + SKIP_REASON);

interface Delivered {
  readonly fixture: RenderFixture;
  readonly manifest: RenderManifest;
  readonly qcReportAssetId: string;
}

describe.skipIf(!hasDatabase)('EX stage', () => {
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

  async function approveScript(pool: Pool, fixture: RenderFixture): Promise<void> {
    await pool.query(
      `INSERT INTO script_revision (project_id, revision, content, schema_version, word_count, status, approved_by, approved_at)
       VALUES ($1, 1, $2::jsonb, 'script.v1', 228, 'approved', $3, now())`,
      [
        fixture.projectId,
        JSON.stringify({
          title: 'The Attention Tax',
          description: 'Why focus compounds.',
          hashtags: ['#focus', '#psychology'],
        }),
        fixture.operatorId,
      ],
    );
  }

  async function deliver(): Promise<Delivered> {
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

    const row = await db.pool.query<{ object_key: string }>(
      `SELECT a.object_key FROM asset a JOIN asset_ref r ON r.asset_id = a.id
        WHERE r.project_id = $1 AND r.role = 'render-manifest' LIMIT 1`,
      [fixture.projectId],
    );
    const stored = await blobs.get(row.rows[0]!.object_key);
    const manifest = JSON.parse(new TextDecoder().decode(stored!.bytes)) as RenderManifest;

    const qc = await runQcStage(
      { pool: db.pool, blobs, runner: fakeForManifest(manifest) },
      { jobId: fixture.qcJobId, projectId: fixture.projectId },
    );
    expect(qc.status).toBe('pass');
    await approveScript(db.pool, fixture);
    return { fixture, manifest, qcReportAssetId: qc.report_asset_id! };
  }

  async function finalApprove(fixture: RenderFixture, decision: 'approve' | 'reject' = 'approve') {
    await recordReviewDecision(db.pool, {
      projectId: fixture.projectId,
      stage: 'FA',
      decision,
      targetStage: decision === 'reject' ? 'RE' : null,
      reason: decision === 'reject' ? 'captions too small' : null,
      decidedBy: fixture.operatorId,
    });
  }

  async function exAssets(pool: Pool, projectId: string) {
    const result = await pool.query<{
      name: string;
      role: string;
      kind: string;
      size: number;
      sha: string;
      package_stem: string;
    }>(
      `SELECT a.rights_metadata->>'name' AS name, r.role, a.kind,
              a.object_size_bytes AS size, a.content_sha256 AS sha,
              a.rights_metadata->>'package_stem' AS package_stem
         FROM asset a JOIN asset_ref r ON r.asset_id = a.id
        WHERE r.project_id = $1 AND a.stage = 'EX' ORDER BY r.created_at ASC, a.id ASC`,
      [projectId],
    );
    return result.rows;
  }

  it('builds the five-file package after final approval', async () => {
    const { fixture, manifest } = await deliver();
    await finalApprove(fixture);

    const result = await runExportStage(
      { pool: db.pool, blobs },
      { jobId: fixture.exJobId, projectId: fixture.projectId },
    );

    expect(result.status).toBe('built');
    expect(result.package_stem).toMatch(/^quiet-machines-/);
    expect(result.files.map((file) => file.name)).toEqual([
      `${result.package_stem}.mp4`,
      `${result.package_stem}.srt`,
      `${result.package_stem}.vtt`,
      'metadata.json',
      'sources.json',
    ]);
    expect(result.total_bytes).toBeGreaterThan(0);

    // R-026: the MP4/.srt/.vtt are the RE assets themselves (one blob per hash),
    // so EX records the two sidecars plus the manifest that names all five files.
    const assets = await exAssets(db.pool, fixture.projectId);
    expect(assets.map((asset) => asset.name).sort()).toEqual([
      'metadata.json',
      'package-manifest.json',
      'sources.json',
    ]);
    for (const asset of assets) expect(asset.sha).toMatch(/^[0-9a-f]{64}$/);

    const manifestRow = assets.find((asset) => asset.name === 'package-manifest.json');
    expect(manifestRow).toBeDefined();
    const manifestBytes = await db.pool.query<{ object_key: string }>(
      'SELECT object_key FROM asset WHERE content_sha256 = $1',
      [manifestRow!.sha],
    );
    const storedManifest = await blobs.get(manifestBytes.rows[0]!.object_key);
    const packageManifest = JSON.parse(new TextDecoder().decode(storedManifest!.bytes)) as {
      schema_version: string;
      package_stem: string;
      files: { name: string; kind: string; sha256: string; size_bytes: number }[];
    };
    expect(packageManifest.schema_version).toBe('video-package.v1');
    expect(packageManifest.package_stem).toBe(result.package_stem);
    expect(packageManifest.files.map((file) => file.name)).toEqual(
      result.files.map((file) => file.name),
    );

    // The package's MP4 is byte-identical to the render the QC stage passed.
    const renderVideo = await db.pool.query<{ content_sha256: string }>(
      `SELECT a.content_sha256 FROM asset a JOIN asset_ref r ON r.asset_id = a.id
        WHERE r.project_id = $1 AND r.role = 'video' AND a.stage = 'RE' LIMIT 1`,
      [fixture.projectId],
    );
    expect(packageManifest.files[0]!.sha256).toBe(renderVideo.rows[0]!.content_sha256);

    // metadata.json carries the approved script's title and hashtags.
    const metadataRow = assets.find((asset) => asset.name === 'metadata.json');
    const metadataBytes = await db.pool.query<{ object_key: string }>(
      'SELECT object_key FROM asset WHERE content_sha256 = $1',
      [metadataRow!.sha],
    );
    const metadata = JSON.parse(
      new TextDecoder().decode((await blobs.get(metadataBytes.rows[0]!.object_key))!.bytes),
    ) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      title: 'The Attention Tax',
      description: 'Why focus compounds.',
      hashtags: ['#focus', '#psychology'],
    });

    const stage = await db.pool.query<{ state: string }>(
      `SELECT state FROM video_stage WHERE project_id = $1 AND stage = 'EX'`,
      [fixture.projectId],
    );
    expect(stage.rows[0]!.state).toBe('done');
    expect(manifest.scenes).toHaveLength(3);
  });

  it('refuses to export without an FA approval (R-005-3)', async () => {
    const { fixture } = await deliver();

    const result = await runExportStage(
      { pool: db.pool, blobs },
      { jobId: fixture.exJobId, projectId: fixture.projectId },
    );

    expect(result.status).toBe('refused');
    expect(result.error).toContain('final_approval_missing');
    expect(await exAssets(db.pool, fixture.projectId)).toHaveLength(0);
  });

  it('refuses a rejected final approval, not just a missing one', async () => {
    const { fixture } = await deliver();
    await finalApprove(fixture, 'reject');

    const result = await runExportStage(
      { pool: db.pool, blobs },
      { jobId: fixture.exJobId, projectId: fixture.projectId },
    );

    expect(result.status).toBe('refused');
    expect(result.error).toContain('final_approval_missing');
  });

  it('refuses to export a render whose QC did not pass', async () => {
    const { fixture } = await deliver();
    await finalApprove(fixture);
    await db.pool.query(
      `UPDATE asset SET rights_metadata = jsonb_set(rights_metadata, '{status}', '"fail"')
        WHERE id = $1`,
      [
        (
          await db.pool.query<{ id: string }>(
            `SELECT a.id FROM asset a JOIN asset_ref r ON r.asset_id = a.id
              WHERE r.project_id = $1 AND r.role = 'qc-report' LIMIT 1`,
            [fixture.projectId],
          )
        ).rows[0]!.id,
      ],
    );

    const result = await runExportStage(
      { pool: db.pool, blobs },
      { jobId: fixture.exJobId, projectId: fixture.projectId },
    );

    expect(result.status).toBe('refused');
    expect(result.error).toContain('qc_not_passed');
  });

  it('records no citation rows for a creative series (R-027-4)', async () => {
    const { fixture } = await deliver();
    await finalApprove(fixture);
    await db.pool.query(
      `INSERT INTO claim (project_id, text, is_factual, status) VALUES ($1, $2, true, 'unsourced')`,
      [fixture.projectId, 'Invented but true to life.'],
    );

    const result = await runExportStage(
      { pool: db.pool, blobs },
      { jobId: fixture.exJobId, projectId: fixture.projectId },
    );

    expect(result.status).toBe('built');
    const sourcesAsset = await db.pool.query<{ object_key: string }>(
      `SELECT a.object_key FROM asset a JOIN asset_ref r ON r.asset_id = a.id
        WHERE r.project_id = $1 AND r.role = 'sidecar'
          AND a.rights_metadata->>'name' = 'sources.json' LIMIT 1`,
      [fixture.projectId],
    );
    const stored = await blobs.get(sourcesAsset.rows[0]!.object_key);
    const sources = JSON.parse(new TextDecoder().decode(stored!.bytes)) as {
      mode: string;
      claims: unknown[];
    };
    expect(sources.mode).toBe('creative');
    expect(sources.claims).toEqual([]);
  });

  it('copies sourced claims and their URLs for a factual series', async () => {
    const { fixture } = await deliver();
    await finalApprove(fixture);
    await db.pool.query(`UPDATE series SET mode = 'factual' WHERE id = $1`, [fixture.seriesId]);
    const source = await db.pool.query<{ id: string }>(
      `INSERT INTO source (project_id, url, title, retrieved_at, rerank_score, status)
       VALUES ($1, $2, $3, $4, 2.0, 'accepted') RETURNING id`,
      [fixture.projectId, 'https://example.test/attention', 'Attention study', new Date()],
    );
    await db.pool.query(
      `INSERT INTO claim (project_id, text, is_factual, status, source_id)
       VALUES ($1, $2, true, 'sourced', $3)`,
      [fixture.projectId, 'Attention compounds.', source.rows[0]!.id],
    );

    const result = await runExportStage(
      { pool: db.pool, blobs },
      { jobId: fixture.exJobId, projectId: fixture.projectId },
    );

    expect(result.status).toBe('built');
    const sourcesAsset = await db.pool.query<{ object_key: string }>(
      `SELECT a.object_key FROM asset a JOIN asset_ref r ON r.asset_id = a.id
        WHERE r.project_id = $1 AND r.role = 'sidecar'
          AND a.rights_metadata->>'name' = 'sources.json' LIMIT 1`,
      [fixture.projectId],
    );
    const stored = await blobs.get(sourcesAsset.rows[0]!.object_key);
    const sources = JSON.parse(new TextDecoder().decode(stored!.bytes)) as {
      mode: string;
      claims: { claim_text: string; url: string; status: string }[];
    };
    expect(sources.mode).toBe('factual');
    expect(sources.claims).toHaveLength(1);
    expect(sources.claims[0]).toMatchObject({
      claim_text: 'Attention compounds.',
      url: 'https://example.test/attention',
      status: 'sourced',
    });
  });
});
