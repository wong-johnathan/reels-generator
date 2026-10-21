/**
 * Per-scene image replace — US-020, promoted into Milestone A by RULINGS L-2.
 *
 * Replacing one scene's image is a one-call edit, not a stage re-run:
 *
 *   the scene's prompt (optionally edited at enqueue) -> one committed
 *   generation_run -> one image call -> the new content-addressed asset ->
 *   the scene points at it, the old asset stays as an orphaned row -> the
 *   render becomes stale and nothing else does.
 *
 * The call counts are not invented here: they come from the `image_replace` row
 * of the invalidation matrix (TECH_DESIGN §4.3 — 1 image call, 0 TTS calls, 1
 * render pass). The IM(scene) half of that row is discharged by this very call
 * (the scene now shows a fresh image), which is why only RE is written stale:
 * marking the whole IM stage stale would claim the other 16 images are stale,
 * and the card's Signal forbids that.
 *
 * `scene.scene_no` is never touched (R-007-2) and `position` is not read for
 * identity (R-006-3): a reorder after a replace moves the scene, not its image.
 */
import { assertImageQualified } from '../adapters/image-qualification.js';
import type { ImageGenerateResult } from '../adapters/image.js';
import {
  findOrphanedSceneImages,
  replaceSceneImage,
  type SceneImageReplacementResult,
} from '../db/repositories/assets.js';
import { finishGenerationRun } from '../db/repositories/generation-runs.js';
import { finishJobAttempt, markAttemptRunning } from '../db/repositories/job-attempts.js';
import { findJobById, markJobStatus } from '../db/repositories/jobs.js';
import { findSceneInProject, type SceneRow } from '../db/repositories/scenes.js';
import {
  applyProjectStatusTransition,
  applyStageTransition,
  findProject,
  findVideoStage,
  updateStageProgress,
} from '../db/repositories/video-stages.js';
import {
  executePersisted,
  openAttempt,
  type PersistedGenerationRun,
} from '../domain/generation-run.js';
import { computeInvalidation, ruleFor, type CallCounts } from './invalidation.js';
import type { StageState, VideoState } from '../shared/index.js';
import { objectKeyFor, sha256Hex } from '../storage/object-store.js';
import {
  buildImageRequest,
  currentSeriesVersionId,
  DEFAULT_RETENTION_DAYS,
  loadReferenceSet,
  promptHashFor,
  rightsMetadataFor,
  type ImageStageDeps,
} from '../workers/image-stage.js';
import { classifyFailure, type ClassifiedFailure } from '../workers/attempt.js';

/** The edit kind whose matrix row decides the cost of a replacement (§4.3). */
export const SCENE_REPLACE_EDIT_KIND = 'image_replace' as const;

/** F-06's replace affordance may edit the prompt with the replacement. */
export type SceneReplaceErrorCode =
  'no_prompt' | 'scene_not_found' | 'project_not_found' | 'job_mismatch';

export class SceneReplacePreconditionError extends Error {
  constructor(
    readonly code: SceneReplaceErrorCode,
    message: string,
  ) {
    super(code + ': ' + message);
    this.name = 'SceneReplacePreconditionError';
  }
}

/** The subset of `scene` a replacement decides on. */
export interface ReplaceableScene {
  readonly id: string;
  readonly project_id: string;
  readonly scene_no: string;
  readonly position: number;
  readonly image_prompt: string | null;
  readonly asset_id: string | null;
  readonly revision: number;
}

export interface PlanSceneReplaceInput {
  readonly scene: ReplaceableScene;
  /** An operator override; omitted means "use the scene's current prompt". */
  readonly imagePrompt?: string | null;
}

export interface SceneReplacePlan {
  readonly scene_id: string;
  readonly scene_no: string;
  /** Exactly one image call, zero TTS calls, one render pass — from the matrix. */
  readonly calls: CallCounts;
  readonly prompt: string;
  readonly prompt_changed: boolean;
  readonly previous_asset_id: string | null;
}

/**
 * Decide what a replacement will spend. Pure: no database, no clock, no call.
 * The only refusal is a blank prompt — a replacement cannot be billed without
 * one (R-013-1 requires the prompt in provenance).
 */
export function planSceneReplace(input: PlanSceneReplaceInput): SceneReplacePlan {
  const override = input.imagePrompt?.trim() ?? '';
  const current = (input.scene.image_prompt ?? '').trim();
  const prompt = override === '' ? current : override;
  if (prompt === '') {
    throw new SceneReplacePreconditionError(
      'no_prompt',
      'scene ' +
        input.scene.scene_no +
        ' has no image prompt; a replacement cannot be billed without one (R-013-1)',
    );
  }
  const preview = computeInvalidation(ruleFor(SCENE_REPLACE_EDIT_KIND), { sceneCount: 1 });
  return {
    scene_id: input.scene.id,
    scene_no: input.scene.scene_no,
    calls: preview.calls,
    prompt,
    prompt_changed: prompt !== current,
    previous_asset_id: input.scene.asset_id,
  };
}

/** The deps a replacement needs: the image stage's bundle minus the stage loop. */
export type SceneReplaceDeps = ImageStageDeps;

export interface SceneReplaceJob {
  /** The `queued` job row the route wrote. Its attempt/run rows are written here. */
  readonly jobId: string;
  readonly projectId: string;
  readonly sceneId: string;
  readonly attemptNo?: number;
  readonly workerId?: string | null;
}

export interface SceneReplaceResult {
  readonly status: 'succeeded' | 'failed';
  readonly job_id: string;
  readonly project_id: string;
  readonly scene_id: string;
  readonly scene_no: string;
  /** The scene's image after the run (unchanged when the run failed). */
  readonly asset_id: string | null;
  readonly previous_asset_id: string | null;
  /** Superseded images of this scene: retained rows + blobs, no longer current. */
  readonly orphaned_asset_ids: readonly string[];
  /** false when the content hash already had a row (R-026-1 dedupe hit). */
  readonly created: boolean;
  readonly content_sha256: string | null;
  readonly calls: { readonly image: number; readonly tts: number };
  readonly prompt_changed: boolean;
  /** R-002-2: the series version pinned into the new asset and the IM stage. */
  readonly series_version_id: string | null;
  readonly stage_state: StageState;
  readonly render_state: StageState;
  readonly render_stale: boolean;
  readonly project_status: VideoState;
  readonly failure: ClassifiedFailure | null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toReplaceable(scene: SceneRow): ReplaceableScene {
  return {
    id: scene.id,
    project_id: scene.project_id,
    scene_no: scene.scene_no,
    position: scene.position,
    image_prompt: scene.image_prompt,
    asset_id: scene.asset_id,
    revision: scene.revision,
  };
}

async function countScenes(deps: SceneReplaceDeps, projectId: string): Promise<number> {
  const result = await deps.pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM scene WHERE project_id = $1',
    [projectId],
  );
  return Number.parseInt(result.rows[0]?.count ?? '0', 10);
}

async function stageStateOf(
  deps: SceneReplaceDeps,
  projectId: string,
  stage: 'IM' | 'RE',
): Promise<StageState> {
  const row = await findVideoStage(deps.pool, projectId, stage);
  return row?.state ?? 'not_run';
}

async function projectStatusOf(deps: SceneReplaceDeps, projectId: string): Promise<VideoState> {
  const project = await findProject(deps.pool, projectId);
  return project?.status ?? 'RUNNING';
}

/**
 * Mark the render stale (§4.4 step 4) through the state machine. Only `done` and
 * `awaiting_approval` have a legal → `stale` edge; a render that never ran has
 * nothing to invalidate, and `stale` is never re-written (IP-01/UC-05).
 */
async function invalidateRender(
  deps: SceneReplaceDeps,
  projectId: string,
  cause: string,
): Promise<{ readonly state: StageState; readonly stale: boolean }> {
  const stage = await findVideoStage(deps.pool, projectId, 'RE');
  if (stage === null) return { state: 'not_run', stale: false };
  if (stage.state === 'done' || stage.state === 'awaiting_approval') {
    const next = await applyStageTransition(deps.pool, {
      projectId,
      stage: 'RE',
      event: 'invalidate',
      lastEvent: cause,
    });
    return { state: next.state, stale: next.stale };
  }
  return { state: stage.state, stale: stage.stale };
}

/**
 * Execute one queued replacement: exactly one image call for exactly one scene.
 *
 * Every write is committed before the function returns; a thrown error means
 * nothing billable was attempted (an unmet precondition or the qualification
 * gate) and the job is marked failed. A provider failure returns a structured
 * `status: 'failed'` result with the run/attempt ledger already finished.
 */
export async function runSceneReplace(
  deps: SceneReplaceDeps,
  job: SceneReplaceJob,
): Promise<SceneReplaceResult> {
  const project = await findProject(deps.pool, job.projectId);
  if (project === null) {
    throw new SceneReplacePreconditionError(
      'project_not_found',
      'video ' + job.projectId + ' does not exist',
    );
  }

  // The job row names the work; a job from another video must not open a run here.
  const queued = await findJobById(deps.pool, job.jobId);
  if (
    queued === null ||
    queued.project_id !== job.projectId ||
    (queued.scene_id !== null && queued.scene_id !== job.sceneId) ||
    queued.stage !== 'IM'
  ) {
    throw new SceneReplacePreconditionError(
      'job_mismatch',
      'job ' +
        job.jobId +
        ' is not an IM replace job for scene ' +
        job.sceneId +
        ' of video ' +
        job.projectId,
    );
  }

  let scene: SceneRow;
  let plan: SceneReplacePlan;
  let references: Awaited<ReturnType<typeof loadReferenceSet>>;
  let seriesVersionId: string | null;
  try {
    const found = await findSceneInProject(deps.pool, job.projectId, job.sceneId);
    if (found === null) {
      throw new SceneReplacePreconditionError(
        'scene_not_found',
        'scene ' + job.sceneId + ' does not exist in video ' + job.projectId,
      );
    }
    scene = found;
    // 5.6: the qualification gate is checked before anything billable is opened.
    await assertImageQualified(deps.qualification, deps.adapter);
    plan = planSceneReplace({ scene: toReplaceable(scene) });
    references = await loadReferenceSet(deps, job.projectId);
    seriesVersionId = await currentSeriesVersionId(deps.pool, project.series_id);
  } catch (error) {
    await markJobStatus(deps.pool, job.jobId, 'failed');
    throw error;
  }

  const request = buildImageRequest(scene, references, deps.adapter.imageSize);
  const promptHash = promptHashFor(request);

  await markJobStatus(deps.pool, job.jobId, 'running');

  let run: PersistedGenerationRun;
  try {
    run = await openAttempt(deps.pool, {
      jobId: job.jobId,
      attemptNo: job.attemptNo ?? 1,
      projectId: job.projectId,
      stage: 'IM',
      sceneId: scene.id,
      provider: deps.adapter.provider,
      model: deps.adapter.model,
      promptHash,
      seriesVersionId,
      workerId: job.workerId ?? deps.workerId ?? null,
    });
  } catch (error) {
    await markJobStatus(deps.pool, job.jobId, 'failed');
    throw error;
  }
  await markAttemptRunning(deps.pool, run.jobAttemptId, job.workerId ?? deps.workerId ?? null);

  let result: ImageGenerateResult;
  try {
    result = await executePersisted({ pool: deps.pool }, deps.adapter.bind(request), run);
  } catch (error) {
    const failure = classifyFailure(error);
    await finishGenerationRun(deps.pool, run.id, {
      status: failure.timedOut ? 'timed_out' : 'failed',
      chargeStatus: failure.mayHaveBilled ? 'unknown' : 'unbilled',
      errorClass: failure.errorClass,
      httpStatus: failure.httpStatus,
    });
    await finishJobAttempt(deps.pool, run.jobAttemptId, {
      status: failure.mayHaveBilled ? 'unknown_charge' : 'failed',
      errorClass: failure.errorClass,
      errorMessage: failure.message,
      httpStatus: failure.httpStatus,
    });
    await markJobStatus(deps.pool, job.jobId, 'failed');
    return {
      status: 'failed',
      job_id: job.jobId,
      project_id: job.projectId,
      scene_id: scene.id,
      scene_no: scene.scene_no,
      asset_id: scene.asset_id,
      previous_asset_id: scene.asset_id,
      orphaned_asset_ids: [],
      created: false,
      content_sha256: null,
      calls: { image: 0, tts: 0 },
      prompt_changed: plan.prompt_changed,
      series_version_id: seriesVersionId,
      stage_state: await stageStateOf(deps, job.projectId, 'IM'),
      render_state: await stageStateOf(deps, job.projectId, 'RE'),
      render_stale: false,
      project_status: await projectStatusOf(deps, job.projectId),
      failure,
    };
  }

  const contentSha256 = sha256Hex(result.image_bytes);
  const now = deps.now?.() ?? new Date();
  const retentionDays = deps.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const retentionEligibleAt = new Date(now.getTime() + retentionDays * 86_400_000);

  let persisted: SceneImageReplacementResult;
  try {
    await deps.blobs.put(objectKeyFor(contentSha256), result.image_bytes, result.mime_type);
    persisted = await replaceSceneImage(deps.pool, {
      projectId: job.projectId,
      stage: 'IM',
      sceneId: scene.id,
      kind: 'image',
      contentSha256,
      objectSizeBytes: result.image_bytes.byteLength,
      mimeType: result.mime_type,
      width: result.width,
      height: result.height,
      seriesVersionId,
      provider: deps.adapter.provider,
      model: result.model,
      seed: result.seed === undefined ? null : String(result.seed),
      providerRequestId: result.provider_request_id,
      promptHash,
      promptText: request.prompt,
      rightsMetadata: rightsMetadataFor({
        provider: deps.adapter.provider,
        model: result.model,
        runId: run.id,
        seriesVersionId,
        references,
      }),
      generationRunId: run.id,
      retentionEligibleAt,
      expectedAssetId: scene.asset_id,
    });
  } catch (error) {
    const failure: ClassifiedFailure = {
      errorClass: 'non_retryable',
      httpStatus: null,
      mayHaveBilled: true,
      timedOut: false,
      message:
        'the provider call succeeded but the replacement could not be persisted: ' +
        messageOf(error),
    };
    await finishGenerationRun(deps.pool, run.id, {
      status: 'failed',
      chargeStatus: 'unknown',
      errorClass: 'non_retryable',
    });
    await finishJobAttempt(deps.pool, run.jobAttemptId, {
      status: 'unknown_charge',
      errorClass: 'non_retryable',
      errorMessage: failure.message,
    });
    await markJobStatus(deps.pool, job.jobId, 'failed');
    return {
      status: 'failed',
      job_id: job.jobId,
      project_id: job.projectId,
      scene_id: scene.id,
      scene_no: scene.scene_no,
      asset_id: scene.asset_id,
      previous_asset_id: scene.asset_id,
      orphaned_asset_ids: [],
      created: false,
      content_sha256: null,
      calls: { image: 0, tts: 0 },
      prompt_changed: plan.prompt_changed,
      series_version_id: seriesVersionId,
      stage_state: await stageStateOf(deps, job.projectId, 'IM'),
      render_state: await stageStateOf(deps, job.projectId, 'RE'),
      render_stale: false,
      project_status: await projectStatusOf(deps, job.projectId),
      failure,
    };
  }

  await finishGenerationRun(deps.pool, run.id, {
    status: 'succeeded',
    chargeStatus: 'billed',
    providerRequestId: result.provider_request_id,
  });
  await finishJobAttempt(deps.pool, run.jobAttemptId, { status: 'succeeded' });
  await markJobStatus(deps.pool, job.jobId, 'succeeded');

  // X-8/OQ-6: the IM stage's pin is the version that produced its newest image.
  const sceneCount = await countScenes(deps, job.projectId);
  await updateStageProgress(deps.pool, {
    projectId: job.projectId,
    stage: 'IM',
    progress: { current: sceneCount, total: sceneCount },
    seriesVersionId,
    lastEvent: 'image_replaced:' + scene.scene_no,
  });

  const cause = 'image_replace: ' + scene.scene_no + ' replaced';
  const render = await invalidateRender(deps, job.projectId, cause);

  // §4.5: an edit after completion reopens the video for attention.
  let projectStatus = await projectStatusOf(deps, job.projectId);
  if (projectStatus === 'COMPLETE') {
    projectStatus = (
      await applyProjectStatusTransition(deps.pool, { projectId: job.projectId, event: 'reopen' })
    ).status;
  }

  const orphans = await findOrphanedSceneImages(deps.pool, job.projectId);
  return {
    status: 'succeeded',
    job_id: job.jobId,
    project_id: job.projectId,
    scene_id: scene.id,
    scene_no: scene.scene_no,
    asset_id: persisted.scene.asset_id,
    previous_asset_id: persisted.previous_asset_id,
    orphaned_asset_ids: orphans
      .filter((orphan) => orphan.scene_id === scene.id)
      .map((orphan) => orphan.asset_id),
    created: persisted.created,
    content_sha256: persisted.asset.content_sha256,
    calls: { image: 1, tts: 0 },
    prompt_changed: plan.prompt_changed,
    series_version_id: seriesVersionId,
    stage_state: await stageStateOf(deps, job.projectId, 'IM'),
    render_state: render.state,
    render_stale: render.stale,
    project_status: projectStatus,
    failure: null,
  };
}
