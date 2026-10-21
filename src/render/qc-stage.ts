/**
 * The QC stage — run R-010-2…7 against the delivered MP4 and persist the report
 * (US-025, TECH_DESIGN §6.7).
 *
 * The stage reads the newest `RE` video asset and the sidecars the render stage
 * stored next to it: the exact ASS that was burned in and the render manifest.
 * QC never re-derives the plan from the timing document — the manifest is what
 * the render actually did, and the point of QC is to compare the delivered file
 * against that record.
 *
 * A failed check is a normal outcome, not an exception: the report is stored,
 * the QC stage goes `failed`, the video NEEDS_ATTENTION, and S-15 renders the
 * number that failed. Only infrastructure errors (missing asset, unreadable
 * blob, FFmpeg crash inside the scan) throw.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Pool } from 'pg';

import {
  findAssetById,
  insertOrReuseAsset,
  linkAssetToProject,
  type AssetRow,
} from '../db/repositories/assets.js';
import { withTransaction } from '../db/client.js';
import { markJobStatus } from '../db/repositories/jobs.js';
import {
  applyStageEvent,
  beginStage,
  findProjectState,
  setProjectCurrentStage,
} from '../db/repositories/stage-state.js';
import { applyProjectStatusTransition } from '../db/repositories/video-stages.js';
import { objectKeyFor, sha256Hex, type ContentAddressedStore } from '../storage/object-store.js';
import type { StageState } from '../shared/index.js';
import type { FfmpegRunner } from './ffmpeg.js';
import { runVideoQc, type QcCheck, type QcReport } from './qc.js';
import type { RenderManifest } from './render.js';

export type QcStageErrorCode =
  | 'render_asset_missing'
  | 'render_blob_missing'
  | 'ass_source_missing'
  | 'manifest_missing'
  | 'manifest_invalid'
  | 'band_missing'
  | 'illegal_stage_state';

export class QcStageError extends Error {
  constructor(
    readonly code: QcStageErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'QcStageError';
  }
}

export interface QcStageDeps {
  readonly pool: Pool;
  readonly blobs: ContentAddressedStore;
  readonly runner: FfmpegRunner;
  readonly workRoot?: string;
  readonly now?: () => Date;
  readonly retentionDays?: number;
}

export interface QcStageJob {
  readonly jobId: string;
  readonly projectId: string;
}

export interface QcStageResult {
  readonly status: 'pass' | 'fail' | 'error';
  readonly project_id: string;
  readonly job_id: string;
  readonly stage_state: StageState;
  readonly report_asset_id: string | null;
  readonly checks: readonly QcCheck[];
  readonly error: string | null;
}

const ASSET_COLUMNS =
  'id, project_id, stage, scene_id, kind, content_sha256, object_key, object_size_bytes, ' +
  'mime_type, width, height, series_version_id, provider, model, seed, provider_request_id, ' +
  'prompt_hash, prompt_text, rights_metadata, generation_run_id, retention_eligible_at, created_at';
const ASSET_COLUMNS_A = ASSET_COLUMNS.split(',')
  .map((column) => 'a.' + column.trim())
  .join(', ');

/**
 * R-026: an asset blob is shared between projects, so the provenance row
 * (`asset.project_id`) belongs to whichever project wrote the bytes first.
 * Every reader therefore scopes through `asset_ref` — the link records that
 * *this* project may use the asset, and its `created_at` is when this project
 * started using it, which is what "newest render" has to mean on a retry.
 */
async function newestRenderVideo(pool: Pool, projectId: string): Promise<AssetRow> {
  const result = await pool.query<AssetRow>(
    `SELECT ${ASSET_COLUMNS_A} FROM asset a
       JOIN asset_ref r ON r.asset_id = a.id
      WHERE r.project_id = $1 AND a.stage = 'RE' AND a.kind = 'video' AND r.role = 'video'
      ORDER BY r.created_at DESC, a.id DESC LIMIT 1`,
    [projectId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new QcStageError(
      'render_asset_missing',
      `project ${projectId} has no RE video asset; render must succeed before QC`,
    );
  }
  return row;
}

async function renderSidecar(
  pool: Pool,
  projectId: string,
  role: string,
): Promise<AssetRow | null> {
  const result = await pool.query<AssetRow>(
    `SELECT ${ASSET_COLUMNS_A} FROM asset a
       JOIN asset_ref r ON r.asset_id = a.id
      WHERE r.project_id = $1 AND a.stage = 'RE' AND a.kind = 'sidecar' AND r.role = $2
      ORDER BY r.created_at DESC, a.id DESC LIMIT 1`,
    [projectId, role],
  );
  return result.rows[0] ?? null;
}

async function bytesOf(
  blobs: ContentAddressedStore,
  asset: AssetRow,
  code: QcStageErrorCode,
): Promise<Uint8Array> {
  const stored = await blobs.get(asset.object_key);
  if (stored === null) throw new QcStageError(code, `asset ${asset.id} has no bytes in the store`);
  return stored.bytes;
}

export async function runQcStage(deps: QcStageDeps, job: QcStageJob): Promise<QcStageResult> {
  const now = deps.now ?? (() => new Date());
  const projectBefore = await findProjectState(deps.pool, job.projectId);
  if (projectBefore === null) {
    throw new QcStageError('illegal_stage_state', `project ${job.projectId} does not exist`);
  }
  try {
    await beginStage(deps.pool, job.projectId, 'QC');
  } catch (error) {
    throw new QcStageError('illegal_stage_state', (error as Error).message);
  }
  if (projectBefore.status === 'NOT_STARTED') {
    await applyProjectStatusTransition(deps.pool, {
      projectId: job.projectId,
      event: 'first_claim',
    });
  } else if (projectBefore.status === 'NEEDS_ATTENTION') {
    await applyProjectStatusTransition(deps.pool, { projectId: job.projectId, event: 'resume' });
  }

  const workDir = mkdtempSync(join(deps.workRoot ?? tmpdir(), 'reels-qc-'));
  let report: QcReport;
  try {
    const videoAsset = await newestRenderVideo(deps.pool, job.projectId);
    const assAsset = await renderSidecar(deps.pool, job.projectId, 'ass-source');
    if (assAsset === null) {
      throw new QcStageError(
        'ass_source_missing',
        `render ${videoAsset.id} has no ass-source sidecar; the caption scan is not reproducible`,
      );
    }
    const manifestAsset = await renderSidecar(deps.pool, job.projectId, 'render-manifest');
    if (manifestAsset === null) {
      throw new QcStageError('manifest_missing', `render ${videoAsset.id} has no render manifest`);
    }

    const videoPath = join(workDir, 'rendered.mp4');
    writeFileSync(videoPath, await bytesOf(deps.blobs, videoAsset, 'render_blob_missing'));
    writeFileSync(
      join(workDir, 'captions.ass'),
      await bytesOf(deps.blobs, assAsset, 'ass_source_missing'),
    );

    let manifest: RenderManifest;
    try {
      manifest = JSON.parse(
        new TextDecoder().decode(await bytesOf(deps.blobs, manifestAsset, 'manifest_missing')),
      ) as RenderManifest;
    } catch (error) {
      throw new QcStageError(
        'manifest_invalid',
        `render manifest is not JSON: ${(error as Error).message}`,
      );
    }
    if (manifest.band === null || manifest.band === undefined) {
      throw new QcStageError(
        'band_missing',
        'the render manifest carries no R-009-3 band, so the duration check cannot be asserted',
      );
    }

    report = await runVideoQc({
      videoPath,
      workDir,
      manifest,
      band: manifest.band,
      runner: deps.runner,
      now: now(),
    });

    const reportBytes = new TextEncoder().encode(JSON.stringify(report));
    const sha = sha256Hex(reportBytes);
    await deps.blobs.put(objectKeyFor(sha), reportBytes, 'application/json');
    const reportAsset = await withTransaction(deps.pool, async (client) => {
      const inserted = await insertOrReuseAsset(client, {
        projectId: job.projectId,
        stage: 'QC',
        kind: 'sidecar',
        contentSha256: sha,
        objectSizeBytes: reportBytes.byteLength,
        mimeType: 'application/json',
        seriesVersionId: videoAsset.series_version_id,
        rightsMetadata: {
          stage: 'QC',
          role: 'qc-report',
          video_asset_id: videoAsset.id,
          status: report.status,
        },
        retentionEligibleAt: new Date(
          now().getTime() + (deps.retentionDays ?? 30) * 24 * 60 * 60 * 1000,
        ),
      });
      await linkAssetToProject(client, {
        assetId: inserted.asset.id,
        projectId: job.projectId,
        role: 'qc-report',
      });
      return inserted;
    });

    if (report.status === 'pass') {
      await applyStageEvent(deps.pool, job.projectId, 'QC', 'succeed');
      // QC pass opens the FA gate: the operator's approval is still required,
      // and is recorded as a review_decision, never by this worker.
      await applyStageEvent(deps.pool, job.projectId, 'FA', 'claim').catch(() => undefined);
      await applyStageEvent(deps.pool, job.projectId, 'FA', 'gate').catch(() => undefined);
      await setProjectCurrentStage(deps.pool, job.projectId, 'FA');
      await markJobStatus(deps.pool, job.jobId, 'succeeded');
      return {
        status: 'pass',
        project_id: job.projectId,
        job_id: job.jobId,
        stage_state: 'done',
        report_asset_id: reportAsset.asset.id,
        checks: report.checks,
        error: null,
      };
    }

    await applyStageEvent(deps.pool, job.projectId, 'QC', 'fail');
    const projectAfter = await findProjectState(deps.pool, job.projectId);
    if (projectAfter !== null && projectAfter.status !== 'NEEDS_ATTENTION') {
      await applyProjectStatusTransition(deps.pool, {
        projectId: job.projectId,
        event: 'needs_attention',
      });
    }
    await markJobStatus(deps.pool, job.jobId, 'failed');
    return {
      status: 'fail',
      project_id: job.projectId,
      job_id: job.jobId,
      stage_state: 'failed',
      report_asset_id: reportAsset.asset.id,
      checks: report.checks,
      error: null,
    };
  } catch (error) {
    await markJobStatus(deps.pool, job.jobId, 'failed').catch(() => undefined);
    await applyStageEvent(deps.pool, job.projectId, 'QC', 'fail').catch(() => undefined);
    await applyProjectStatusTransition(deps.pool, {
      projectId: job.projectId,
      event: 'needs_attention',
    }).catch(() => undefined);
    return {
      status: 'error',
      project_id: job.projectId,
      job_id: job.jobId,
      stage_state: 'failed',
      report_asset_id: null,
      checks: [],
      error: (error as Error).message,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

export { findAssetById };
