/**
 * The RE stage — resolve the timing plan and stored media, render, persist
 * (US-024, TECH_DESIGN §1.2 step 6, §6).
 *
 * Inputs come from persisted state, never from the job payload: the newest
 * `TC` timing document (an `NA` sidecar, per the C-B11-2 ruling that `asset.stage`
 * admits no `TC`), the scene images the `IM` stage linked, and the narration
 * take the `NA` stage stored. A job is just `{ job_id, project_id }`, so a
 * resumed render after a kill re-reads the same inputs and produces byte-identical
 * output from stored bytes — no provider call, no cost.
 *
 * The stage writes six assets, all content-addressed:
 *   video          kind video    the deliverable MP4
 *   srt / vtt      kind caption  the deliverable sidecars (same cue list as the burn-in)
 *   ass-source     kind sidecar  the exact ASS that was burned in; QC re-burns it
 *   manifest       kind sidecar  the render manifest (offsets, chapters, frame counts)
 *   benchmark      kind sidecar  wall time + peak RAM of this render
 *
 * R-013-1 provenance applies to the video too: series-version pin, the encoder
 * settings and the render's own measurements travel in `rights_metadata`, and
 * `generation_run_id` stays null — render is local and never billable (§5.6).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Pool } from 'pg';
import { z } from 'zod';

import { withTransaction } from '../db/client.js';
import {
  assetKeyContextFor,
  findAssetById,
  insertOrReuseAsset,
  linkAssetToProject,
  type AssetRow,
} from '../db/repositories/assets.js';
import { markJobStatus } from '../db/repositories/jobs.js';
import { listScenes, type SceneRow } from '../db/repositories/scenes.js';
import {
  applyStageEvent,
  beginStage,
  findProjectState,
  setProjectCurrentStage,
} from '../db/repositories/stage-state.js';
import { applyProjectStatusTransition } from '../db/repositories/video-stages.js';
import type { StageState } from '../shared/index.js';
import {
  assetObjectKey,
  CAPTIONS_ASS_OBJECT_NAME,
  CAPTIONS_SRT_OBJECT_NAME,
  CAPTIONS_VTT_OBJECT_NAME,
  RENDER_BENCHMARK_OBJECT_NAME,
  RENDER_MANIFEST_OBJECT_NAME,
  VIDEO_OBJECT_NAME,
} from '../storage/object-key.js';
import { sha256Hex, type ContentAddressedStore } from '../storage/object-store.js';
import { buildRenderBenchmark } from './benchmark.js';
import { buildCaptionDocuments } from './captions.js';
import type { FfmpegRunner } from './ffmpeg.js';
import { buildRenderPlan, type RenderPlan, type RenderSceneSource } from './plan.js';
import { renderVideo, type RenderManifest } from './render.js';

export const DEFAULT_RETENTION_DAYS = 30;

const TimingDocumentSchema = z.object({
  schema_version: z.string(),
  project_id: z.uuid(),
  target_duration_s: z.number().finite(),
  narration: z.object({
    asset_id: z.uuid(),
    alignment_asset_id: z.uuid(),
    duration_s: z.number().finite(),
    provider: z.string().nullable(),
    model: z.string().nullable(),
    provider_request_id: z.string().nullable(),
  }),
  lead_s: z.number().finite(),
  trail_s: z.number().finite(),
  final_audio_duration_s: z.number().finite(),
  band: z.object({
    target_s: z.number().finite(),
    tolerance_s: z.number().finite(),
    min_s: z.number().finite(),
    max_s: z.number().finite(),
    within_band: z.boolean(),
  }),
  word_count: z.number().int(),
  words: z.array(
    z.object({ word: z.string(), start_ms: z.number().int(), end_ms: z.number().int() }),
  ),
  scenes: z.array(
    z.object({
      scene_no: z.string(),
      position: z.number().int(),
      start_ms: z.number().int(),
      end_ms: z.number().int(),
      duration_s: z.number().finite(),
    }),
  ),
});

export type TimingDocumentView = z.infer<typeof TimingDocumentSchema>;

export type RenderStageErrorCode =
  | 'timing_missing'
  | 'timing_invalid'
  | 'scene_plan_mismatch'
  | 'images_missing'
  | 'image_blob_missing'
  | 'narration_missing'
  | 'narration_blob_missing'
  | 'unsupported_mime'
  | 'illegal_stage_state'
  | 'render_failed';

export class RenderStageError extends Error {
  constructor(
    readonly code: RenderStageErrorCode,
    message: string,
    readonly detail?: unknown,
  ) {
    super(`${code}: ${message}`);
    this.name = 'RenderStageError';
  }
}

export interface RenderStageDeps {
  readonly pool: Pool;
  readonly blobs: ContentAddressedStore;
  readonly runner: FfmpegRunner;
  /** Directory renders are built in; a temp dir per attempt by default. */
  readonly workRoot?: string;
  readonly now?: () => Date;
  readonly retentionDays?: number;
}

export interface RenderStageJob {
  readonly jobId: string;
  readonly projectId: string;
}

export interface RenderStageResult {
  readonly status: 'rendered' | 'failed';
  readonly project_id: string;
  readonly job_id: string;
  readonly stage_state: StageState;
  readonly video_asset_id: string | null;
  readonly caption_asset_ids: readonly string[];
  readonly manifest_asset_id: string | null;
  readonly wall_time_ms: number;
  readonly peak_ram_mb: number | null;
  readonly duration_s: number | null;
  readonly error: string | null;
}

function extensionForMime(mime: string | null): string {
  switch (mime) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'audio/mpeg':
    case 'audio/mp3':
      return 'mp3';
    case 'audio/mp4':
    case 'audio/aac':
      return 'm4a';
    case 'audio/wav':
    case 'audio/x-wav':
      return 'wav';
    default:
      throw new RenderStageError('unsupported_mime', `no known extension for ${String(mime)}`);
  }
}

/** The newest `TC` timing document for a project, read and validated. */
export async function loadTimingDocument(
  pool: Pool,
  blobs: ContentAddressedStore,
  projectId: string,
): Promise<{ row: AssetRow; document: TimingDocumentView }> {
  const result = await pool.query<AssetRow>(
    `SELECT id, project_id, stage, scene_id, kind, content_sha256, object_key, object_size_bytes,
            mime_type, width, height, series_version_id, provider, model, seed,
            provider_request_id, prompt_hash, prompt_text, rights_metadata, generation_run_id,
            retention_eligible_at, created_at
       FROM asset
      WHERE project_id = $1
        AND stage = 'NA'
        AND kind = 'sidecar'
        AND rights_metadata->>'stage' = 'TC'
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [projectId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new RenderStageError(
      'timing_missing',
      `project ${projectId} has no TC timing document; the timing stage must succeed before render`,
    );
  }
  const stored = await blobs.get(row.object_key);
  if (stored === null) {
    throw new RenderStageError(
      'timing_missing',
      `timing asset ${row.id} has no bytes in the store`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(stored.bytes));
  } catch (error) {
    throw new RenderStageError('timing_invalid', `timing asset ${row.id} is not JSON`, error);
  }
  const validated = TimingDocumentSchema.safeParse(parsed);
  if (!validated.success) {
    throw new RenderStageError(
      'timing_invalid',
      `timing asset ${row.id} does not match timing.v1: ${validated.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  if (validated.data.project_id !== projectId) {
    throw new RenderStageError(
      'timing_invalid',
      `timing asset ${row.id} belongs to project ${validated.data.project_id}, not ${projectId}`,
    );
  }
  return { row, document: validated.data };
}

export interface LoadedRenderInputs {
  readonly timing: { row: AssetRow; document: TimingDocumentView };
  readonly scenes: readonly SceneRow[];
  readonly sceneBytes: ReadonlyMap<
    string,
    { bytes: Uint8Array; mime: string | null; assetId: string }
  >;
  readonly narrationBytes: { bytes: Uint8Array; mime: string | null; assetId: string };
}

/**
 * Read every byte the render needs. A missing image is refused before FFmpeg
 * starts: a render that silently drops a scene would still pass the duration
 * check and fail only at visual review.
 */
export async function loadRenderInputs(
  pool: Pool,
  blobs: ContentAddressedStore,
  projectId: string,
): Promise<LoadedRenderInputs> {
  const timing = await loadTimingDocument(pool, blobs, projectId);
  const scenes = await listScenes(pool, projectId);
  if (scenes.length === 0) {
    throw new RenderStageError('scene_plan_mismatch', `project ${projectId} has no scenes`);
  }

  const timingScenes = new Set(timing.document.scenes.map((scene) => scene.scene_no));
  const dbScenes = new Set(scenes.map((scene) => scene.scene_no));
  const missingFromTiming = scenes
    .filter((scene) => !timingScenes.has(scene.scene_no))
    .map((scene) => scene.scene_no);
  const missingFromDb = [...timingScenes].filter((sceneNo) => !dbScenes.has(sceneNo));
  if (missingFromTiming.length > 0 || missingFromDb.length > 0) {
    throw new RenderStageError(
      'scene_plan_mismatch',
      `the timing document and the storyboard name different scenes ` +
        `(no timing: ${missingFromTiming.join(', ') || '—'}; no scene: ${missingFromDb.join(', ') || '—'})`,
    );
  }

  const missingImages = scenes
    .filter((scene) => scene.asset_id === null)
    .map((scene) => scene.scene_no);
  if (missingImages.length > 0) {
    throw new RenderStageError(
      'images_missing',
      `scenes without an image: ${missingImages.join(', ')}; run the IM stage first`,
    );
  }

  const sceneBytes = new Map<string, { bytes: Uint8Array; mime: string | null; assetId: string }>();
  for (const scene of scenes) {
    const asset = await findAssetById(pool, scene.asset_id!);
    if (asset === null) {
      throw new RenderStageError(
        'image_blob_missing',
        `scene ${scene.scene_no} points at a missing asset`,
      );
    }
    const stored = await blobs.get(asset.object_key);
    if (stored === null) {
      throw new RenderStageError(
        'image_blob_missing',
        `scene ${scene.scene_no} image ${asset.id} has no bytes in the store`,
      );
    }
    sceneBytes.set(scene.scene_no, {
      bytes: stored.bytes,
      mime: asset.mime_type ?? stored.mimeType,
      assetId: asset.id,
    });
  }

  const narrationAsset = await findAssetById(pool, timing.document.narration.asset_id);
  if (narrationAsset === null) {
    throw new RenderStageError(
      'narration_missing',
      `timing document names narration asset ${timing.document.narration.asset_id}, which does not exist`,
    );
  }
  const narration = await blobs.get(narrationAsset.object_key);
  if (narration === null) {
    throw new RenderStageError(
      'narration_blob_missing',
      `narration asset ${narrationAsset.id} has no bytes in the store`,
    );
  }

  return {
    timing,
    scenes,
    sceneBytes,
    narrationBytes: {
      bytes: narration.bytes,
      mime: narrationAsset.mime_type ?? narration.mimeType,
      assetId: narrationAsset.id,
    },
  };
}

/** Build the render plan from stored state: timing spans + storyboard camera moves. */
export function planFromPersisted(inputs: LoadedRenderInputs): RenderPlan {
  const cameraByScene = new Map(inputs.scenes.map((scene) => [scene.scene_no, scene.camera_move]));
  const sources: RenderSceneSource[] = inputs.timing.document.scenes.map((span) => ({
    sceneNo: span.scene_no,
    position: span.position,
    cameraMove: (cameraByScene.get(span.scene_no) ?? null) as RenderSceneSource['cameraMove'],
    imageFileName: `img-${span.scene_no}.${extensionForMime(
      inputs.sceneBytes.get(span.scene_no)?.mime ?? null,
    )}`,
    narrationStartMs: span.start_ms,
    narrationEndMs: span.end_ms,
  }));
  return buildRenderPlan({
    scenes: sources,
    leadS: inputs.timing.document.lead_s,
    trailS: inputs.timing.document.trail_s,
  });
}

interface StoredFile {
  readonly assetId: string;
  readonly asset: AssetRow;
}

async function storeAsset(
  pool: Pool,
  blobs: ContentAddressedStore,
  input: {
    projectId: string;
    stage: 'RE' | 'QC' | 'EX';
    kind: 'video' | 'caption' | 'sidecar';
    bytes: Uint8Array;
    mime: string;
    objectKey: string;
    seriesVersionId: string | null;
    width?: number | null;
    height?: number | null;
    rightsMetadata: Record<string, unknown>;
    retentionEligibleAt: Date | null;
  },
): Promise<StoredFile> {
  const contentSha256 = sha256Hex(input.bytes);
  const put = await blobs.put(input.objectKey, input.bytes, input.mime);
  void put;
  const stored = await withTransaction(pool, async (client) => {
    const inserted = await insertOrReuseAsset(client, {
      projectId: input.projectId,
      stage: input.stage,
      kind: input.kind,
      contentSha256,
      objectKey: input.objectKey,
      objectSizeBytes: input.bytes.byteLength,
      mimeType: input.mime,
      width: input.width ?? null,
      height: input.height ?? null,
      seriesVersionId: input.seriesVersionId,
      rightsMetadata: input.rightsMetadata,
      retentionEligibleAt: input.retentionEligibleAt,
    });
    // R-026: the blob is shared across projects; asset_ref is what says this
    // project may use it, and every reader goes through asset_ref for that
    // reason (a deduped row keeps the *first* project's provenance).
    await linkAssetToProject(client, {
      assetId: inserted.asset.id,
      projectId: input.projectId,
      role: String(input.rightsMetadata['role'] ?? input.kind),
    });
    return inserted;
  });
  return { assetId: stored.asset.id, asset: stored.asset };
}

/**
 * Run one RE attempt. Failures leave the stage `failed`, the video
 * NEEDS_ATTENTION and the job `failed` — the same terminal shape as the image
 * stage — and rethrow so the queue's failure classifier sees the cause.
 */
export async function runRenderStage(
  deps: RenderStageDeps,
  job: RenderStageJob,
): Promise<RenderStageResult> {
  const now = deps.now ?? (() => new Date());
  const projectBefore = await findProjectState(deps.pool, job.projectId);
  if (projectBefore === null) {
    throw new RenderStageError('illegal_stage_state', `project ${job.projectId} does not exist`);
  }

  let stageRow;
  try {
    stageRow = await beginStage(deps.pool, job.projectId, 'RE');
  } catch (error) {
    throw new RenderStageError('illegal_stage_state', (error as Error).message);
  }
  const seriesVersionId = stageRow.series_version_id;
  // §4.5: the first claim moves NOT_STARTED → RUNNING; a resumed video moves
  // NEEDS_ATTENTION → RUNNING. Anything else is already RUNNING.
  if (projectBefore.status === 'NOT_STARTED') {
    await applyProjectStatusTransition(deps.pool, {
      projectId: job.projectId,
      event: 'first_claim',
    });
  } else if (projectBefore.status === 'NEEDS_ATTENTION') {
    await applyProjectStatusTransition(deps.pool, { projectId: job.projectId, event: 'resume' });
  }

  const workDir = mkdtempSync(join(deps.workRoot ?? tmpdir(), 'reels-render-'));
  try {
    const inputs = await loadRenderInputs(deps.pool, deps.blobs, job.projectId);
    const plan = planFromPersisted(inputs);
    const keyCtx = await assetKeyContextFor(deps.pool, job.projectId);
    const key = (name: string): string =>
      assetObjectKey({ seriesSlug: keyCtx.seriesSlug, batchOrdinal: keyCtx.batchOrdinal, name });

    for (const scene of plan.scenes) {
      const stored = inputs.sceneBytes.get(scene.sceneNo)!;
      writeFileSync(join(workDir, scene.imageFileName), stored.bytes);
    }
    const narrationFileName = `narration.${extensionForMime(inputs.narrationBytes.mime)}`;
    writeFileSync(join(workDir, narrationFileName), inputs.narrationBytes.bytes);

    const captions = buildCaptionDocuments({
      words: inputs.timing.document.words,
      leadS: inputs.timing.document.lead_s,
    });

    const rendered = await renderVideo({
      plan,
      workDir,
      narrationFileName,
      captions: captions.documents,
      captionCueCount: captions.cues.length,
      band: inputs.timing.document.band,
      runner: deps.runner,
      projectId: job.projectId,
      now: now(),
      sceneAssetIds: Object.fromEntries(
        [...inputs.sceneBytes.entries()].map(([sceneNo, value]) => [sceneNo, value.assetId]),
      ),
    });

    const benchmark = buildRenderBenchmark({
      plan,
      result: rendered,
      hostLabel: process.env.RENDER_HOST_LABEL ?? 'unspecified host',
      sourceResolution: '1K',
      now: now(),
    });

    const retentionEligibleAt = new Date(
      now().getTime() + (deps.retentionDays ?? DEFAULT_RETENTION_DAYS) * 24 * 60 * 60 * 1000,
    );
    const manifestJson = new TextEncoder().encode(JSON.stringify(rendered.manifest));
    const benchmarkJson = new TextEncoder().encode(JSON.stringify(benchmark));
    const assBytes = new TextEncoder().encode(captions.documents.ass);
    const srtBytes = new TextEncoder().encode(captions.documents.srt);
    const vttBytes = new TextEncoder().encode(captions.documents.vtt);
    const videoBytes = new Uint8Array(readFileSync(rendered.videoPath));

    const videoAsset = await storeAsset(deps.pool, deps.blobs, {
      projectId: job.projectId,
      stage: 'RE',
      kind: 'video',
      bytes: videoBytes,
      mime: 'video/mp4',
      objectKey: key(VIDEO_OBJECT_NAME),
      seriesVersionId,
      width: plan.width,
      height: plan.height,
      rightsMetadata: {
        stage: 'RE',
        role: 'video',
        duration_ms: plan.durationMs,
        frame_count: plan.totalFrames,
        wall_time_ms: rendered.wallTimeMs,
        peak_ram_mb: benchmark.peak_ram_mb,
        host_label: benchmark.host_label,
      },
      retentionEligibleAt,
    });
    const srtAsset = await storeAsset(deps.pool, deps.blobs, {
      projectId: job.projectId,
      stage: 'RE',
      kind: 'caption',
      bytes: srtBytes,
      mime: 'application/x-subrip',
      objectKey: key(CAPTIONS_SRT_OBJECT_NAME),
      seriesVersionId,
      rightsMetadata: { stage: 'RE', role: 'srt', video_asset_id: videoAsset.assetId },
      retentionEligibleAt,
    });
    const vttAsset = await storeAsset(deps.pool, deps.blobs, {
      projectId: job.projectId,
      stage: 'RE',
      kind: 'caption',
      bytes: vttBytes,
      mime: 'text/vtt',
      objectKey: key(CAPTIONS_VTT_OBJECT_NAME),
      seriesVersionId,
      rightsMetadata: { stage: 'RE', role: 'vtt', video_asset_id: videoAsset.assetId },
      retentionEligibleAt,
    });
    const assAsset = await storeAsset(deps.pool, deps.blobs, {
      projectId: job.projectId,
      stage: 'RE',
      kind: 'sidecar',
      bytes: assBytes,
      mime: 'text/x-ssa',
      objectKey: key(CAPTIONS_ASS_OBJECT_NAME),
      seriesVersionId,
      rightsMetadata: { stage: 'RE', role: 'ass-source', video_asset_id: videoAsset.assetId },
      retentionEligibleAt,
    });
    const manifestAsset = await storeAsset(deps.pool, deps.blobs, {
      projectId: job.projectId,
      stage: 'RE',
      kind: 'sidecar',
      bytes: manifestJson,
      mime: 'application/json',
      objectKey: key(RENDER_MANIFEST_OBJECT_NAME),
      seriesVersionId,
      rightsMetadata: { stage: 'RE', role: 'render-manifest', video_asset_id: videoAsset.assetId },
      retentionEligibleAt,
    });
    await storeAsset(deps.pool, deps.blobs, {
      projectId: job.projectId,
      stage: 'RE',
      kind: 'sidecar',
      bytes: benchmarkJson,
      mime: 'application/json',
      objectKey: key(RENDER_BENCHMARK_OBJECT_NAME),
      seriesVersionId,
      rightsMetadata: {
        stage: 'RE',
        role: 'render-benchmark',
        video_asset_id: videoAsset.assetId,
        host_label: benchmark.host_label,
      },
      retentionEligibleAt,
    });

    // The ASS is stored so QC re-burns the exact file that produced the deliverable.
    void assAsset;
    await applyStageEvent(deps.pool, job.projectId, 'RE', 'succeed');
    await setProjectCurrentStage(deps.pool, job.projectId, 'QC');
    await markJobStatus(deps.pool, job.jobId, 'succeeded');

    return {
      status: 'rendered',
      project_id: job.projectId,
      job_id: job.jobId,
      stage_state: 'done',
      video_asset_id: videoAsset.assetId,
      caption_asset_ids: [srtAsset.assetId, vttAsset.assetId],
      manifest_asset_id: manifestAsset.assetId,
      wall_time_ms: rendered.wallTimeMs,
      peak_ram_mb: benchmark.peak_ram_mb,
      duration_s: plan.durationMs / 1000,
      error: null,
    };
  } catch (error) {
    await markJobStatus(deps.pool, job.jobId, 'failed').catch(() => undefined);
    await applyStageEvent(deps.pool, job.projectId, 'RE', 'fail').catch(() => undefined);
    const projectAfter = await findProjectState(deps.pool, job.projectId).catch(() => null);
    if (projectAfter !== null && projectAfter.status !== 'NEEDS_ATTENTION') {
      await applyProjectStatusTransition(deps.pool, {
        projectId: job.projectId,
        event: 'needs_attention',
      }).catch(() => undefined);
    }
    return {
      status: 'failed',
      project_id: job.projectId,
      job_id: job.jobId,
      stage_state: 'failed',
      video_asset_id: null,
      caption_asset_ids: [],
      manifest_asset_id: null,
      wall_time_ms: 0,
      peak_ram_mb: null,
      duration_s: null,
      error: (error as Error).message,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

export type { RenderManifest };
