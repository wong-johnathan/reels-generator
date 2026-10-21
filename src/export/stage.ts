/**
 * The EX stage — build the per-video package after final approval (US-026,
 * TECH_DESIGN §8.1/§8.2, R-005-3).
 *
 * R-005-3 and US-026's hard prerequisite: **final approval is the only path to
 * export**. The stage therefore refuses to build anything unless an `FA`
 * approve decision exists for the project, and it refuses a package whose QC
 * report is not `pass` — an export is the one artefact that leaves the system,
 * so neither gate may be assumed from stage state alone.
 *
 * Package contents: the MP4, `.srt`, `.vtt`, `metadata.json` and `sources.json`.
 * `content_sha256` is unique per blob (R-026), so the media files in the
 * are the RE assets themselves; EX adds the two data sidecars plus a
 * `package-manifest.json` that names all five files with their hashes. The
 * metadata comes from the approved script revision (title, description,
 * hashtags); the source manifest from `claim` joined to `source` (§8.2), and
 * creative-mode series record no claims at all (R-027-4).
 */
import type { Pool } from 'pg';

import {
  assetKeyContextFor,
  insertOrReuseAsset,
  linkAssetToProject,
  type AssetRow,
} from '../db/repositories/assets.js';
import { withTransaction } from '../db/client.js';
import { markJobStatus } from '../db/repositories/jobs.js';
import { latestApproval } from '../db/repositories/review-decisions.js';
import {
  applyStageEvent,
  beginStage,
  findProjectState,
  setProjectCurrentStage,
} from '../db/repositories/stage-state.js';
import { assetObjectKey, PACKAGE_MANIFEST_OBJECT_NAME } from '../storage/object-key.js';
import { sha256Hex, type ContentAddressedStore } from '../storage/object-store.js';
import type { StageState } from '../shared/index.js';
import { buildVideoPackage, type PackageFileRecord, type SourceManifestClaim } from './package.js';

const ASSET_COLUMNS =
  'id, project_id, stage, scene_id, kind, content_sha256, object_key, object_size_bytes, ' +
  'mime_type, width, height, series_version_id, provider, model, seed, provider_request_id, ' +
  'prompt_hash, prompt_text, rights_metadata, generation_run_id, retention_eligible_at, created_at';
const ASSET_COLUMNS_A = ASSET_COLUMNS.split(',')
  .map((column) => 'a.' + column.trim())
  .join(', ');

export type ExportStageErrorCode =
  | 'final_approval_missing'
  | 'render_missing'
  | 'qc_not_passed'
  | 'caption_missing'
  | 'script_missing'
  | 'blob_missing'
  | 'illegal_stage_state';

export class ExportStageError extends Error {
  constructor(
    readonly code: ExportStageErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'ExportStageError';
  }
}

export interface ExportStageDeps {
  readonly pool: Pool;
  readonly blobs: ContentAddressedStore;
  readonly now?: () => Date;
  readonly retentionDays?: number;
}

export interface ExportStageJob {
  readonly jobId: string;
  readonly projectId: string;
}

export interface ExportStageResult {
  readonly status: 'built' | 'refused';
  readonly project_id: string;
  readonly job_id: string;
  readonly stage_state: StageState;
  readonly package_stem: string | null;
  readonly files: readonly PackageFileRecord[];
  readonly total_bytes: number;
  readonly error: string | null;
}

interface ScriptView {
  readonly title: string;
  readonly description: string;
  readonly hashtags: readonly string[];
}

async function loadApprovedScript(pool: Pool, projectId: string): Promise<ScriptView> {
  const result = await pool.query<{ content: unknown }>(
    `SELECT content FROM script_revision
      WHERE project_id = $1 AND status = 'approved'
      ORDER BY revision DESC LIMIT 1`,
    [projectId],
  );
  const content = result.rows[0]?.content as
    { title?: unknown; description?: unknown; hashtags?: unknown } | undefined;
  if (content === undefined) {
    throw new ExportStageError(
      'script_missing',
      `project ${projectId} has no approved script revision to take the title/description/hashtags from`,
    );
  }
  return {
    title: typeof content.title === 'string' ? content.title : '',
    description: typeof content.description === 'string' ? content.description : '',
    hashtags: Array.isArray(content.hashtags)
      ? content.hashtags.filter((tag): tag is string => typeof tag === 'string')
      : [],
  };
}

async function loadSeries(
  pool: Pool,
  projectId: string,
): Promise<{ slug: string; mode: 'factual' | 'creative' }> {
  const result = await pool.query<{ slug: string; mode: 'factual' | 'creative' }>(
    `SELECT s.slug, s.mode FROM project p JOIN series s ON s.id = p.series_id WHERE p.id = $1`,
    [projectId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ExportStageError('script_missing', `project ${projectId} has no series`);
  }
  return row;
}

/** §8.2: one row per factual claim, with its source and acknowledgement. */
async function loadClaimManifest(pool: Pool, projectId: string): Promise<SourceManifestClaim[]> {
  const result = await pool.query<{
    text: string;
    url: string | null;
    retrieved_at: Date | null;
    status: string;
    acknowledged_by: string | null;
    acknowledged_at: Date | null;
  }>(
    `SELECT c.text,
            s.url,
            s.retrieved_at,
            c.status,
            c.acknowledged_by,
            c.acknowledged_at
       FROM claim c
       LEFT JOIN source s ON s.id = c.source_id
      WHERE c.project_id = $1 AND c.is_factual = true AND c.status <> 'non_factual'
      ORDER BY c.created_at ASC, c.id ASC`,
    [projectId],
  );
  return result.rows.map((row) => ({
    claim_text: row.text,
    url: row.url ?? '',
    retrieved_at: row.retrieved_at === null ? null : row.retrieved_at.toISOString(),
    status: row.status,
    acknowledged_by: row.acknowledged_by,
    acknowledged_at: row.acknowledged_at === null ? null : row.acknowledged_at.toISOString(),
  }));
}

/**
 * R-026: the blob and its provenance row can belong to an earlier project, so
 * "this project's newest asset of role R" is an `asset_ref` question, not an
 * `asset.project_id` one.
 */
async function newestAsset(
  pool: Pool,
  projectId: string,
  stage: string,
  kind: string,
  role: string,
): Promise<AssetRow | null> {
  const result = await pool.query<AssetRow>(
    `SELECT ${ASSET_COLUMNS_A} FROM asset a
       JOIN asset_ref r ON r.asset_id = a.id
      WHERE r.project_id = $1 AND a.stage = $2 AND a.kind = $3 AND r.role = $4
      ORDER BY r.created_at DESC, a.id DESC LIMIT 1`,
    [projectId, stage, kind, role],
  );
  return result.rows[0] ?? null;
}

async function bytesOf(blobs: ContentAddressedStore, asset: AssetRow): Promise<Uint8Array> {
  const stored = await blobs.get(asset.object_key);
  if (stored === null) throw new ExportStageError('blob_missing', `asset ${asset.id} has no bytes`);
  return stored.bytes;
}

export async function runExportStage(
  deps: ExportStageDeps,
  job: ExportStageJob,
): Promise<ExportStageResult> {
  const now = deps.now ?? (() => new Date());
  const projectBefore = await findProjectState(deps.pool, job.projectId);
  if (projectBefore === null) {
    throw new ExportStageError('illegal_stage_state', `project ${job.projectId} does not exist`);
  }
  try {
    await beginStage(deps.pool, job.projectId, 'EX');
  } catch (error) {
    throw new ExportStageError('illegal_stage_state', (error as Error).message);
  }

  try {
    // R-005-3 / US-026: final approval is the gate. A stage state is not a
    // decision — only a recorded FA approve opens export.
    const approval = await latestApproval(deps.pool, job.projectId, 'FA');
    if (approval === null) {
      throw new ExportStageError(
        'final_approval_missing',
        `project ${job.projectId} has no FA approve decision; export is only reachable after final approval`,
      );
    }

    const video = await newestAsset(deps.pool, job.projectId, 'RE', 'video', 'video');
    if (video === null) {
      throw new ExportStageError(
        'render_missing',
        `project ${job.projectId} has no rendered video`,
      );
    }
    const qcReport = await newestAsset(deps.pool, job.projectId, 'QC', 'sidecar', 'qc-report');
    const qcStatus = qcReport?.rights_metadata as { status?: unknown } | null;
    if (qcReport === null || qcStatus?.status !== 'pass') {
      throw new ExportStageError(
        'qc_not_passed',
        `project ${job.projectId} has no passing QC report; a failed QC cannot be exported`,
      );
    }

    const srt = await newestAsset(deps.pool, job.projectId, 'RE', 'caption', 'srt');
    const vtt = await newestAsset(deps.pool, job.projectId, 'RE', 'caption', 'vtt');
    if (srt === null || vtt === null) {
      throw new ExportStageError(
        'caption_missing',
        `render ${video.id} is missing its .srt/.vtt assets; the package requires both`,
      );
    }

    const [script, series, claims] = await Promise.all([
      loadApprovedScript(deps.pool, job.projectId),
      loadSeries(deps.pool, job.projectId),
      loadClaimManifest(deps.pool, job.projectId),
    ]);

    const meta = video.rights_metadata as { duration_ms?: number } | null;
    const durationS =
      typeof meta?.duration_ms === 'number'
        ? meta.duration_ms / 1000
        : (projectBefore.target_duration_s ?? 0);

    const pkg = buildVideoPackage({
      projectId: job.projectId,
      seriesSlug: series.slug,
      seriesVersionId: video.series_version_id,
      videoSlug: script.title,
      video: { bytes: await bytesOf(deps.blobs, video), mimeType: 'video/mp4' },
      srt: { bytes: await bytesOf(deps.blobs, srt) },
      vtt: { bytes: await bytesOf(deps.blobs, vtt) },
      metadata: {
        title: script.title,
        description: script.description,
        hashtags: script.hashtags,
        durationS,
        width: video.width ?? 1080,
        height: video.height ?? 1920,
        fps: 30,
      },
      sources: { mode: series.mode, claims },
      generatedAt: now(),
    });

    const retentionEligibleAt = new Date(
      now().getTime() + (deps.retentionDays ?? 30) * 24 * 60 * 60 * 1000,
    );
    const keyCtx = await assetKeyContextFor(deps.pool, job.projectId);
    const storedIds: string[] = [];
    for (const entry of pkg.contents) {
      const sha = sha256Hex(entry.bytes);
      // Packages live under export/: they carry the publishable filename
      // (<video-slug>.mp4), not the batch's internal video.mp4, so the two never
      // look like the same file to a human reading the bucket.
      const objectKey = assetObjectKey({
        seriesSlug: keyCtx.seriesSlug,
        batchOrdinal: keyCtx.batchOrdinal,
        name: 'export/' + entry.record.name,
      });
      await deps.blobs.put(objectKey, entry.bytes, entry.record.mime_type);
      const inserted = await withTransaction(deps.pool, async (client) => {
        const written = await insertOrReuseAsset(client, {
          projectId: job.projectId,
          stage: 'EX',
          kind:
            entry.record.kind === 'video'
              ? 'video'
              : entry.record.kind === 'sidecar'
                ? 'sidecar'
                : 'caption',
          contentSha256: sha,
          objectKey,
          objectSizeBytes: entry.bytes.byteLength,
          mimeType: entry.record.mime_type,
          seriesVersionId: video.series_version_id,
          rightsMetadata: {
            stage: 'EX',
            role: entry.record.kind,
            name: entry.record.name,
            package_stem: pkg.stem,
            video_asset_id: video.id,
            final_approval_id: approval.id,
          },
          retentionEligibleAt,
        });
        await linkAssetToProject(client, {
          assetId: written.asset.id,
          projectId: job.projectId,
          role: entry.record.kind,
        });
        return written;
      });
      storedIds.push(inserted.asset.id);
    }

    // R-026 makes content_sha256 unique across the deployment, so the MP4, .srt
    // and .vtt in the package *are* the RE assets — inserting them again would
    // duplicate nothing and record nothing. What ties the five files together is
    // this manifest: the deliverable names, their hashes and the approval that
    // opened the gate.
    const packageManifest = {
      schema_version: 'video-package.v1',
      project_id: job.projectId,
      package_stem: pkg.stem,
      final_approval_id: approval.id,
      generated_at: now().toISOString(),
      files: pkg.files.map((file) => ({
        name: file.name,
        kind: file.kind,
        mime_type: file.mime_type,
        sha256: file.sha256,
        size_bytes: file.size_bytes,
      })),
    };
    const manifestBytes = new TextEncoder().encode(JSON.stringify(packageManifest, null, 2));
    const manifestSha = sha256Hex(manifestBytes);
    const manifestKey = assetObjectKey({
      seriesSlug: keyCtx.seriesSlug,
      batchOrdinal: keyCtx.batchOrdinal,
      name: 'export/' + PACKAGE_MANIFEST_OBJECT_NAME,
    });
    await deps.blobs.put(manifestKey, manifestBytes, 'application/json');
    storedIds.push(
      await withTransaction(deps.pool, async (client) => {
        const written = await insertOrReuseAsset(client, {
          projectId: job.projectId,
          stage: 'EX',
          kind: 'sidecar',
          contentSha256: manifestSha,
          objectKey: manifestKey,
          objectSizeBytes: manifestBytes.byteLength,
          mimeType: 'application/json',
          seriesVersionId: video.series_version_id,
          rightsMetadata: {
            stage: 'EX',
            role: 'sidecar',
            name: 'package-manifest.json',
            package_stem: pkg.stem,
            video_asset_id: video.id,
            final_approval_id: approval.id,
          },
          retentionEligibleAt,
        });
        await linkAssetToProject(client, {
          assetId: written.asset.id,
          projectId: job.projectId,
          role: 'sidecar',
        });
        return written.asset.id;
      }),
    );

    await applyStageEvent(deps.pool, job.projectId, 'EX', 'succeed');
    await setProjectCurrentStage(deps.pool, job.projectId, null);
    await markJobStatus(deps.pool, job.jobId, 'succeeded');

    return {
      status: 'built',
      project_id: job.projectId,
      job_id: job.jobId,
      stage_state: 'done',
      package_stem: pkg.stem,
      files: pkg.files,
      total_bytes: pkg.total_bytes,
      error: null,
    };
  } catch (error) {
    await markJobStatus(deps.pool, job.jobId, 'failed').catch(() => undefined);
    await applyStageEvent(deps.pool, job.projectId, 'EX', 'fail').catch(() => undefined);
    return {
      status: 'refused',
      project_id: job.projectId,
      job_id: job.jobId,
      stage_state: 'failed',
      package_stem: null,
      files: [],
      total_bytes: 0,
      error: (error as Error).message,
    };
  }
}
