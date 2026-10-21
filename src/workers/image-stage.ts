/**
 * The image generation stage — US-019 (R-013 provenance, PRD 10 checkpoint).
 *
 * One stage attempt generates the pending scene images and persists each one
 * with full provenance, in this order per scene:
 *
 *   resolve the prompt + reference set -> open a committed generation_run ->
 *   call the adapter through executePersisted -> store the bytes content-
 *   addressed -> persist the asset + scene link + run link in one transaction
 *   -> close the run billed/succeeded.
 *
 * The first-three checkpoint (PRD 10, UX A-14/A-15, UI S-12) is a stop inside
 * this stage: when the series uses a recurring protagonist, only scenes 1..3 are
 * generated, the stage records 3/N progress, and the project goes
 * NEEDS_ATTENTION. Scenes 4+ are refused by planImageStage() until an operator
 * approve decision for IM is newer than the newest scene 1..3 image; that anchor
 * is what re-arms the checkpoint after the images are regenerated.
 *
 * Retry accounting follows R-011-2 exactly as B-08 implements it: one job
 * attempt = one queue execution; every image call inside it gets its own
 * generation_run (TECH_DESIGN 4.7). A transient failure ends the attempt with the
 * 1 s / 4 s / 16 s ladder and the next attempt resumes at the first scene that
 * still has no asset, so a retry never re-buys an image that was persisted.
 */
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

import {
  assertImageQualified,
  type ImageQualificationStore,
} from '../adapters/image-qualification.js';
import {
  MAX_REFERENCE_IMAGES,
  referenceSetDigest,
  type ImageAdapter,
  type ImageGenerateRequest,
  type ImageGenerateResult,
  type ImageSize,
  type InlineImageData,
  type ImageMimeType,
} from '../adapters/image.js';
import {
  findProjectReferenceAssets,
  latestCheckpointSceneAssetAt,
  persistSceneImage,
} from '../db/repositories/assets.js';
import { finishGenerationRun } from '../db/repositories/generation-runs.js';
import { finishJobAttempt, markAttemptRunning } from '../db/repositories/job-attempts.js';
import { markJobStatus } from '../db/repositories/jobs.js';
import { latestApproval, type ReviewDecisionRow } from '../db/repositories/review-decisions.js';
import { listScenes, type SceneRow } from '../db/repositories/scenes.js';
import {
  applyProjectStatusTransition,
  applyStageTransition,
  countStagesNeedingAttention,
  findProject,
  requireVideoStage,
  updateStageProgress,
  type ProjectRow,
  type VideoStageRow,
} from '../db/repositories/video-stages.js';
import {
  executePersisted,
  openAttempt,
  openRunInAttempt,
  type PersistedGenerationRun,
} from '../domain/generation-run.js';
import type { StageCode, StageState, VideoState } from '../shared/index.js';
import { objectKeyFor, sha256Hex, type ContentAddressedStore } from '../storage/object-store.js';
import {
  MAX_ATTEMPTS_PER_JOB,
  backoffSecondsForAttempt,
  classifyFailure,
  planRetry,
  refuseReissueOfPendingRuns,
  type ClassifiedFailure,
  type SleepFn,
} from './attempt.js';

/** PRD 10: review the first three scenes before the remaining scenes. */
export const FIRST_THREE_CHECKPOINT_SCENES = 3;

/** R-025-1 default when the caller does not pass the configured retention. */
export const DEFAULT_RETENTION_DAYS = 30;

const IMAGE_ASPECT_RATIO = '9:16' as const;

export type ImageStageErrorCode =
  | 'no_scenes'
  | 'script_not_approved'
  | 'duplicate_scene_no'
  | 'empty_prompt'
  | 'too_many_references'
  | 'reference_rights_missing'
  | 'reference_object_missing'
  | 'reference_mime_invalid'
  | 'illegal_stage_state'
  | 'scene_already_has_asset';

/** A precondition the stage refuses to spend money on (TECH_DESIGN 4.8, 5.6). */
export class ImageStagePreconditionError extends Error {
  constructor(
    readonly code: ImageStageErrorCode,
    message: string,
  ) {
    super(code + ': ' + message);
    this.name = 'ImageStagePreconditionError';
  }
}

export class ImageStageStateError extends Error {
  constructor(
    readonly stageState: string,
    message: string,
  ) {
    super(message);
    this.name = 'ImageStageStateError';
  }
}

export interface PlannerScene {
  readonly id: string;
  readonly scene_no: string;
  readonly position: number;
  readonly image_prompt: string | null;
  readonly asset_id: string | null;
}

export interface ImageStageCheckpoint {
  readonly applies: boolean;
  readonly reviewed: boolean;
  readonly open: boolean;
  readonly first_three_total: number;
  readonly first_three_generated: number;
  readonly remaining: number;
}

export type ImageStagePlanStatus = 'complete' | 'generate' | 'awaiting_review';

export interface ImageStagePlan {
  readonly status: ImageStagePlanStatus;
  readonly scene_count: number;
  readonly already_generated: number;
  readonly to_generate: readonly PlannerScene[];
  readonly blocked_by_checkpoint: number;
  readonly checkpoint: ImageStageCheckpoint;
}

export interface PlanImageStageInput {
  readonly scenes: readonly PlannerScene[];
  readonly checkpointApplies: boolean;
  readonly checkpointReviewed: boolean;
}

/**
 * Decide what this pass may generate. Pure: no database, no clock.
 *
 * The checkpoint rule is deliberately a refusal, not a warning: with the gate
 * open, scenes 4+ are not in to_generate at all, so no caller can spend 14 image
 * calls by re-running the stage (Signal: blocks scenes 4+ until review).
 */
export function planImageStage(input: PlanImageStageInput): ImageStagePlan {
  const scenes = [...input.scenes].sort((left, right) => left.position - right.position);
  if (scenes.length === 0) {
    throw new ImageStagePreconditionError(
      'no_scenes',
      'the storyboard has no scenes yet; IM runs after the approved storyboard (R-009-2)',
    );
  }

  const seen = new Set<string>();
  for (const scene of scenes) {
    if (seen.has(scene.scene_no)) {
      throw new ImageStagePreconditionError(
        'duplicate_scene_no',
        'scene_no ' + scene.scene_no + ' appears twice; ids are stable and unique (R-007-2)',
      );
    }
    seen.add(scene.scene_no);
    if (scene.image_prompt === null || scene.image_prompt.trim() === '') {
      throw new ImageStagePreconditionError(
        'empty_prompt',
        'scene ' + scene.scene_no + ' has no image prompt; a blank prompt cannot be billed',
      );
    }
  }

  const pending = scenes.filter((scene) => scene.asset_id === null);
  const firstThree = scenes.filter((scene) => scene.position <= FIRST_THREE_CHECKPOINT_SCENES);
  const checkpointOpen = input.checkpointApplies && !input.checkpointReviewed;
  const blocked = checkpointOpen
    ? pending.filter((scene) => scene.position > FIRST_THREE_CHECKPOINT_SCENES)
    : [];
  const toGenerate = checkpointOpen
    ? pending.filter((scene) => scene.position <= FIRST_THREE_CHECKPOINT_SCENES)
    : pending;
  const status: ImageStagePlanStatus =
    pending.length === 0 ? 'complete' : toGenerate.length > 0 ? 'generate' : 'awaiting_review';

  return {
    status,
    scene_count: scenes.length,
    already_generated: scenes.length - pending.length,
    to_generate: toGenerate,
    blocked_by_checkpoint: blocked.length,
    checkpoint: {
      applies: input.checkpointApplies,
      reviewed: input.checkpointReviewed,
      open: checkpointOpen && pending.length > 0,
      first_three_total: firstThree.length,
      first_three_generated: firstThree.filter((scene) => scene.asset_id !== null).length,
      remaining: pending.length,
    },
  };
}

export interface ImageStageJob {
  readonly jobId: string;
  readonly projectId: string;
  /** First attempt to run. BullMQ passes data.attemptNo + job.attemptsMade. */
  readonly attemptNo?: number;
  readonly workerId?: string | null;
  /**
   * Series override: a recurring protagonist uses the checkpoint even when no
   * REF asset exists yet (the operator can still eyeball three scenes before
   * spending the other 14 calls).
   */
  readonly recurringProtagonist?: boolean;
}

export interface ImageStageDeps {
  readonly pool: Pool;
  readonly adapter: ImageAdapter;
  readonly blobs: ContentAddressedStore;
  readonly qualification: ImageQualificationStore;
  /** R-025-1 retention window; omitted leaves retention_eligible_at null. */
  readonly retentionDays?: number;
  readonly now?: () => Date;
  /** Injectable for tests; R-011-2's wait is the only thing that sleeps. */
  readonly sleep?: SleepFn;
  readonly maxAttempts?: number;
  readonly workerId?: string | null;
}

export interface ImageStageAttemptResult {
  readonly attemptNo: number;
  readonly jobAttemptId: string | null;
  readonly status: 'succeeded' | 'failed' | 'not_started';
  readonly calls: number;
  readonly generated_scene_ids: readonly string[];
  readonly charge: 'billed' | 'unbilled' | 'unknown' | null;
  readonly failure: ClassifiedFailure | null;
}

export interface ImageStageResult {
  readonly status: 'complete' | 'awaiting_review' | 'failed';
  readonly project_id: string;
  readonly job_id: string;
  readonly scene_count: number;
  readonly generated_scene_ids: readonly string[];
  readonly generated_asset_ids: readonly string[];
  readonly calls: number;
  readonly attempts: readonly ImageStageAttemptResult[];
  readonly checkpoint: ImageStageCheckpoint;
  readonly stage_state: StageState;
  readonly project_status: VideoState;
  readonly failure: ClassifiedFailure | null;
}

interface LoadedReference {
  readonly asset_id: string;
  readonly content_sha256: string;
  readonly rights_note: string;
}

interface LoadedReferenceSet {
  readonly images: readonly InlineImageData[];
  readonly rights: readonly LoadedReference[];
  readonly digest: string;
}

interface StageContext {
  readonly project: ProjectRow;
  readonly stage: VideoStageRow;
  readonly series_version_id: string | null;
  readonly scenes: SceneRow[];
  readonly references: LoadedReferenceSet;
  readonly checkpoint_applies: boolean;
  readonly checkpoint_reviewed: boolean;
  readonly approval: ReviewDecisionRow | null;
}

function rightsNoteOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const note = record['rights_note'] ?? record['rights'];
  return typeof note === 'string' && note.trim() !== '' ? note.trim() : null;
}

function imageMimeOrThrow(value: string | null, assetId: string): ImageMimeType {
  if (value === 'image/png' || value === 'image/jpeg' || value === 'image/webp') return value;
  throw new ImageStagePreconditionError(
    'reference_mime_invalid',
    'reference asset ' +
      assetId +
      ' has mime_type ' +
      String(value) +
      '; the image adapter accepts image/png, image/jpeg or image/webp',
  );
}

/**
 * Load the approved reference set as inlineData plus the rights note that
 * travels into every asset's provenance (R-013-1, PRD 10). A reference without
 * a rights note or without its object refuses the whole stage: identity can not
 * be reproduced from bytes the store does not have.
 */
async function loadReferenceSet(
  deps: ImageStageDeps,
  projectId: string,
): Promise<LoadedReferenceSet> {
  const rows = await findProjectReferenceAssets(deps.pool, projectId);
  if (rows.length > MAX_REFERENCE_IMAGES) {
    throw new ImageStagePreconditionError(
      'too_many_references',
      rows.length +
        ' reference images are attached to this video; the adapter accepts at most ' +
        MAX_REFERENCE_IMAGES +
        ' (D4)',
    );
  }

  const images: InlineImageData[] = [];
  const rights: LoadedReference[] = [];
  for (const row of rows) {
    const note = rightsNoteOf(row.rights_metadata);
    if (note === null) {
      throw new ImageStagePreconditionError(
        'reference_rights_missing',
        'reference asset ' +
          row.asset_id +
          ' has no rights note; PRD 10 requires owner-confirmed rights per uploaded reference (R-003-4)',
      );
    }
    const stored = await deps.blobs.get(row.object_key);
    if (stored === null) {
      throw new ImageStagePreconditionError(
        'reference_object_missing',
        'asset ' +
          row.asset_id +
          ' has a row but no object at ' +
          row.object_key +
          ' (DB/object-store drift)',
      );
    }
    images.push({
      mime_type: imageMimeOrThrow(row.mime_type, row.asset_id),
      data: Buffer.from(stored.bytes).toString('base64'),
    });
    rights.push({
      asset_id: row.asset_id,
      content_sha256: row.content_sha256,
      rights_note: note,
    });
  }
  return { images, rights, digest: referenceSetDigest(images) };
}

/** X-8/OQ-6: the pin a stage starts with is the newest series version. */
async function currentSeriesVersionId(pool: Pool, seriesId: string): Promise<string | null> {
  const result = await pool.query<{ current_version_id: string | null }>(
    'SELECT current_version_id FROM series WHERE id = $1',
    [seriesId],
  );
  return result.rows[0]?.current_version_id ?? null;
}

async function loadStageContext(
  deps: ImageStageDeps,
  projectId: string,
  job: ImageStageJob,
): Promise<StageContext> {
  const project = await findProject(deps.pool, projectId);
  if (project === null) throw new Error('project ' + projectId + ' does not exist');
  const stage = await requireVideoStage(deps.pool, projectId, 'IM');
  const script = await deps.pool.query<{ status: string }>(
    'SELECT status FROM script_revision WHERE project_id = $1 ORDER BY revision DESC LIMIT 1',
    [projectId],
  );
  const scriptStatus = script.rows[0]?.status;
  if (scriptStatus !== 'approved') {
    throw new ImageStagePreconditionError(
      'script_not_approved',
      'the latest script revision is ' +
        (scriptStatus ?? 'missing') +
        '; IM runs only after script approval (R-005-2, TECH_DESIGN 4.8)',
    );
  }
  const scenes = await listScenes(deps.pool, projectId);
  const references = await loadReferenceSet(deps, projectId);
  const approval = await latestApproval(deps.pool, projectId, 'IM');
  const anchor = await latestCheckpointSceneAssetAt(
    deps.pool,
    projectId,
    FIRST_THREE_CHECKPOINT_SCENES,
  );
  const reviewed =
    approval !== null && (anchor === null || approval.decided_at.getTime() >= anchor.getTime());
  // An approval with no scene 1..3 image behind it reviewed nothing: at the start
  // of a cycle the anchor is null, so a decision recorded before the checkpoint
  // images exists must not release scenes 4+ (PRD 10).
  const checkpointReviewed = reviewed && anchor !== null;
  const derivesProtagonist =
    references.images.length > 0 || scenes.some((scene) => scene.uses_protagonist);
  return {
    project,
    stage,
    series_version_id: await currentSeriesVersionId(deps.pool, project.series_id),
    scenes,
    references,
    checkpoint_applies: job.recurringProtagonist ?? derivesProtagonist,
    checkpoint_reviewed: checkpointReviewed,
    approval,
  };
}

function buildImageRequest(
  scene: PlannerScene,
  references: LoadedReferenceSet,
  imageSize: ImageSize,
): ImageGenerateRequest {
  return {
    prompt: (scene.image_prompt ?? '').trim(),
    reference_images: references.images,
    image_size: imageSize,
    aspect_ratio: IMAGE_ASPECT_RATIO,
  };
}

/** sha256 of the exact request body — the R-013-1 provenance key of the call. */
function promptHashFor(request: ImageGenerateRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        prompt: request.prompt,
        reference_digest: referenceSetDigest(request.reference_images),
        image_size: request.image_size ?? null,
        aspect_ratio: request.aspect_ratio ?? null,
      }),
    )
    .digest('hex');
}

function rightsMetadataFor(input: {
  readonly provider: string;
  readonly model: string;
  readonly runId: string;
  readonly seriesVersionId: string | null;
  readonly references: LoadedReferenceSet;
}): Record<string, unknown> {
  return {
    kind: 'generated',
    generated_by: {
      provider: input.provider,
      model: input.model,
      generation_run_id: input.runId,
    },
    licence_context:
      'model-generated image: the provider output terms and the per-reference rights notes apply (PRD 10)',
    series_version_id: input.seriesVersionId,
    reference_rights: input.references.rights.map((reference) => ({
      asset_id: reference.asset_id,
      content_sha256: reference.content_sha256,
      rights_note: reference.rights_note,
    })),
  };
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'unknown failure';
}

async function ensureProjectRunning(pool: Pool, projectId: string): Promise<void> {
  const project = await findProject(pool, projectId);
  if (project === null) throw new Error('project ' + projectId + ' does not exist');
  if (project.status === 'NOT_STARTED') {
    await applyProjectStatusTransition(pool, { projectId, event: 'first_claim' });
  }
}

async function markNeedsAttention(pool: Pool, projectId: string): Promise<VideoState> {
  await ensureProjectRunning(pool, projectId);
  const project = await findProject(pool, projectId);
  if (project === null) throw new Error('project ' + projectId + ' does not exist');
  if (project.status === 'RUNNING') {
    const next = await applyProjectStatusTransition(pool, { projectId, event: 'needs_attention' });
    return next.status;
  }
  return project.status;
}

/**
 * After a stage succeeds, resume only when no other stage is failed, blocked or
 * waiting on a gate. Flipping a different stage's failure to RUNNING would hide
 * it from the operator (4.5).
 */
async function resumeAfterStage(pool: Pool, projectId: string): Promise<VideoState> {
  const project = await findProject(pool, projectId);
  if (project === null) throw new Error('project ' + projectId + ' does not exist');
  if (project.status !== 'NEEDS_ATTENTION') return project.status;
  if ((await countStagesNeedingAttention(pool, projectId, 'IM')) > 0) return project.status;
  const next = await applyProjectStatusTransition(pool, { projectId, event: 'resume' });
  return next.status;
}

function generatedCount(scenes: readonly SceneRow[]): number {
  return scenes.filter((scene) => scene.asset_id !== null).length;
}

async function blockStage(pool: Pool, projectId: string, lastEvent: string): Promise<void> {
  const stage = await requireVideoStage(pool, projectId, 'IM');
  if (stage.state === 'not_run') {
    await applyStageTransition(pool, { projectId, stage: 'IM', event: 'block', lastEvent });
  }
  await markNeedsAttention(pool, projectId);
}

/**
 * Claim the stage for this run: not_run/failed/stale/blocked -> running, or a
 * no-op progress update when it is already running. Throws for done and
 * awaiting_approval, which 4.2 forbids re-entering without the regenerate path.
 */
async function claimStage(deps: ImageStageDeps, context: StageContext): Promise<VideoStageRow> {
  const progress = { current: generatedCount(context.scenes), total: context.scenes.length };
  const base = {
    projectId: context.project.id,
    stage: 'IM' as StageCode,
    progress,
    seriesVersionId: context.series_version_id,
    lastEvent: 'running',
  };
  if (context.stage.state === 'blocked') {
    await applyStageTransition(deps.pool, { ...base, event: 'unblock' });
  }
  if (context.stage.state === 'not_run' || context.stage.state === 'blocked') {
    await ensureProjectRunning(deps.pool, context.project.id);
    return applyStageTransition(deps.pool, { ...base, event: 'claim' });
  }
  if (context.stage.state === 'failed') {
    return applyStageTransition(deps.pool, { ...base, event: 'retry' });
  }
  if (context.stage.state === 'stale') {
    return applyStageTransition(deps.pool, { ...base, event: 'regenerate' });
  }
  if (context.stage.state === 'running') {
    return updateStageProgress(deps.pool, base);
  }
  throw new ImageStageStateError(
    context.stage.state,
    'stage IM is ' +
      context.stage.state +
      '; it cannot be claimed (TECH_DESIGN 4.2: running only from not_run, failed, stale or blocked)',
  );
}

interface PassOutcome {
  readonly result: ImageStageAttemptResult;
  readonly asset_ids: readonly string[];
  readonly retry: ReturnType<typeof planRetry> | null;
  readonly error: unknown;
}

const PENDING_RUN_FAILURE: ClassifiedFailure = {
  errorClass: 'non_retryable',
  httpStatus: null,
  mayHaveBilled: true,
  timedOut: false,
  message:
    'a generation_run from a previous process is still pending: the provider call may have billed, so it was marked unknown charge and not reissued (R-012-3/R-012-4)',
};

/**
 * One job attempt: up to N scene calls sharing one job_attempt row.
 * Stops at the first failure and reports whether R-011-2 allows another attempt.
 */
async function runGenerationPass(
  deps: ImageStageDeps,
  job: ImageStageJob,
  context: StageContext,
  plan: ImageStagePlan,
  attemptNo: number,
): Promise<PassOutcome> {
  const workerId = job.workerId ?? deps.workerId ?? null;
  const guard = await refuseReissueOfPendingRuns({ pool: deps.pool }, job.jobId);
  if (!guard.reissueAllowed) {
    await markJobStatus(deps.pool, job.jobId, 'failed');
    return {
      result: {
        attemptNo,
        jobAttemptId: null,
        status: 'failed',
        calls: 0,
        generated_scene_ids: [],
        charge: guard.inProgress ? null : 'unknown',
        failure: PENDING_RUN_FAILURE,
      },
      asset_ids: [],
      retry: null,
      error: null,
    };
  }

  let jobAttemptId: string | null = null;
  const generatedSceneIds: string[] = [];
  const assetIds: string[] = [];
  let calls = 0;
  let failure: ClassifiedFailure | null = null;
  let charge: 'billed' | 'unbilled' | 'unknown' | null = null;
  let fatal: unknown = null;

  for (const [index, scene] of plan.to_generate.entries()) {
    const request = buildImageRequest(scene, context.references, deps.adapter.imageSize);
    const promptHash = promptHashFor(request);
    const runInput = {
      projectId: job.projectId,
      stage: 'IM' as const,
      sceneId: scene.id,
      provider: deps.adapter.provider,
      model: deps.adapter.model,
      promptHash,
      seriesVersionId: context.series_version_id,
    };

    let run: PersistedGenerationRun;
    try {
      run =
        index === 0 || jobAttemptId === null
          ? await openAttempt(deps.pool, { ...runInput, jobId: job.jobId, attemptNo, workerId })
          : await openRunInAttempt(deps.pool, { ...runInput, jobAttemptId, attemptNo });
    } catch (error) {
      failure = {
        errorClass: 'non_retryable',
        httpStatus: null,
        mayHaveBilled: false,
        timedOut: false,
        message: 'the attempt row could not be opened: ' + messageOf(error),
      };
      charge = 'unbilled';
      fatal = error;
      break;
    }

    jobAttemptId = run.jobAttemptId;
    await markAttemptRunning(deps.pool, run.jobAttemptId, workerId);

    let result: ImageGenerateResult;
    try {
      result = await executePersisted({ pool: deps.pool }, deps.adapter.bind(request), run);
    } catch (error) {
      const classified = classifyFailure(error);
      await finishGenerationRun(deps.pool, run.id, {
        status: classified.timedOut ? 'timed_out' : 'failed',
        chargeStatus: classified.mayHaveBilled ? 'unknown' : 'unbilled',
        errorClass: classified.errorClass,
        httpStatus: classified.httpStatus,
      });
      failure = classified;
      fatal = error;
      charge = classified.mayHaveBilled ? 'unknown' : 'unbilled';
      break;
    }

    try {
      const contentSha256 = sha256Hex(result.image_bytes);
      await deps.blobs.put(objectKeyFor(contentSha256), result.image_bytes, result.mime_type);
      const now = deps.now?.() ?? new Date();
      const retentionEligibleAt =
        deps.retentionDays === undefined
          ? null
          : new Date(now.getTime() + deps.retentionDays * 86_400_000);
      const persisted = await persistSceneImage(deps.pool, {
        projectId: job.projectId,
        stage: 'IM',
        sceneId: scene.id,
        kind: 'image',
        contentSha256,
        objectSizeBytes: result.image_bytes.byteLength,
        mimeType: result.mime_type,
        width: result.width,
        height: result.height,
        seriesVersionId: context.series_version_id,
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
          seriesVersionId: context.series_version_id,
          references: context.references,
        }),
        generationRunId: run.id,
        retentionEligibleAt,
      });
      if (!persisted.linked) {
        throw new ImageStageStateError(
          scene.asset_id ?? 'occupied',
          'scene ' +
            scene.scene_no +
            ' already shows a different image; replacing an existing image is B-15',
        );
      }
      await finishGenerationRun(deps.pool, run.id, {
        status: 'succeeded',
        chargeStatus: 'billed',
        providerRequestId: result.provider_request_id,
      });
      generatedSceneIds.push(scene.id);
      assetIds.push(persisted.asset.id);
      calls += 1;
      await updateStageProgress(deps.pool, {
        projectId: job.projectId,
        stage: 'IM',
        progress: {
          current: context.scenes.length - plan.to_generate.length + generatedSceneIds.length,
          total: context.scenes.length,
        },
        lastEvent: 'running',
      });
    } catch (error) {
      const persistenceFailure: ClassifiedFailure = {
        errorClass: 'non_retryable',
        httpStatus: null,
        mayHaveBilled: true,
        timedOut: false,
        message:
          'the provider call succeeded but the image could not be persisted: ' + messageOf(error),
      };
      await finishGenerationRun(deps.pool, run.id, {
        status: 'failed',
        chargeStatus: 'unknown',
        errorClass: 'non_retryable',
      });
      failure = persistenceFailure;
      fatal = error;
      charge = 'unknown';
      break;
    }
  }

  if (failure === null) {
    if (jobAttemptId !== null) {
      await finishJobAttempt(deps.pool, jobAttemptId, { status: 'succeeded' });
    }
    return {
      result: {
        attemptNo,
        jobAttemptId,
        status: 'succeeded',
        calls,
        generated_scene_ids: generatedSceneIds,
        charge: calls > 0 ? 'billed' : null,
        failure: null,
      },
      asset_ids: assetIds,
      retry: null,
      error: null,
    };
  }

  const retry = planRetry({ attemptNo, failure });
  if (jobAttemptId !== null) {
    await finishJobAttempt(deps.pool, jobAttemptId, {
      status: charge === 'unknown' ? 'unknown_charge' : 'failed',
      errorClass: failure.errorClass,
      errorMessage: failure.message,
      httpStatus: failure.httpStatus,
      backoffS: failure.errorClass === 'transient' ? backoffSecondsForAttempt(attemptNo) : null,
    });
  }
  await markJobStatus(deps.pool, job.jobId, retry.requeue ? 'queued' : 'failed');

  return {
    result: {
      attemptNo,
      jobAttemptId,
      status: 'failed',
      calls,
      generated_scene_ids: generatedSceneIds,
      charge,
      failure,
    },
    asset_ids: assetIds,
    retry,
    error: fatal,
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Run the image stage for one job. Returns a structured outcome; every write
 * (stage state, project status, job/attempt/run rows, asset rows) is committed
 * before it returns. A thrown error means nothing could be attempted (a
 * precondition or the qualification gate), and the stage is left blocked.
 */
export async function runImageStage(
  deps: ImageStageDeps,
  job: ImageStageJob,
): Promise<ImageStageResult> {
  const maxAttempts = deps.maxAttempts ?? MAX_ATTEMPTS_PER_JOB;
  const sleep = deps.sleep ?? defaultSleep;
  const firstAttempt = job.attemptNo ?? 1;
  if (!Number.isInteger(firstAttempt) || firstAttempt < 1 || firstAttempt > MAX_ATTEMPTS_PER_JOB) {
    throw new RangeError(
      'attempt number must be an integer 1..' +
        MAX_ATTEMPTS_PER_JOB +
        ' (R-011-2), got ' +
        String(firstAttempt),
    );
  }

  // 5.6: the qualification gate is checked before anything billable is claimed.
  try {
    await assertImageQualified(deps.qualification, deps.adapter);
  } catch (error) {
    await blockStage(deps.pool, job.projectId, 'blocked: image qualification');
    throw error;
  }

  let context: StageContext;
  try {
    context = await loadStageContext(deps, job.projectId, job);
  } catch (error) {
    if (error instanceof ImageStagePreconditionError) {
      await blockStage(deps.pool, job.projectId, 'blocked: ' + error.code);
    }
    throw error;
  }

  const planFor = (loaded: StageContext): ImageStagePlan =>
    planImageStage({
      scenes: loaded.scenes,
      checkpointApplies: loaded.checkpoint_applies,
      checkpointReviewed: loaded.checkpoint_reviewed,
    });

  let plan = planFor(context);
  let stageState = context.stage.state;
  if (stageState === 'done' && plan.status === 'generate') {
    throw new ImageStageStateError(
      stageState,
      'stage IM is done but scenes still have no image: done stages are never re-run (R-023-2)',
    );
  }

  const attempts: ImageStageAttemptResult[] = [];
  const generatedSceneIds: string[] = [];
  const assetIds: string[] = [];
  let calls = 0;
  let failure: ClassifiedFailure | null = null;
  let attemptNo = firstAttempt;

  if (stageState !== 'done' && stageState !== 'awaiting_approval') {
    const claimed = await claimStage(deps, context);
    stageState = claimed.state;
  }

  while (plan.status === 'generate' && attemptNo <= maxAttempts) {
    const pass = await runGenerationPass(deps, job, context, plan, attemptNo);
    attempts.push(pass.result);
    calls += pass.result.calls;
    generatedSceneIds.push(...pass.result.generated_scene_ids);
    assetIds.push(...pass.asset_ids);

    // Reload: a retry resumes at the first scene that still has no asset.
    context = await loadStageContext(deps, job.projectId, job);
    plan = planFor(context);

    if (pass.result.status === 'succeeded') {
      // A later attempt succeeded, so an earlier attempt cannot describe this run
      // (R-011-2: the retry resumes at the first scene that still has no asset).
      failure = null;
      if (plan.status === 'generate') {
        attemptNo += 1;
        continue;
      }
      break;
    }

    failure = pass.result.failure;
    if (pass.retry !== null && pass.retry.requeue && attemptNo < maxAttempts) {
      await sleep(pass.retry.delayMs);
      attemptNo = pass.retry.nextAttemptNo ?? attemptNo + 1;
      if (plan.status !== 'generate') break;
      continue;
    }
    break;
  }

  const base = {
    project_id: job.projectId,
    job_id: job.jobId,
    scene_count: plan.scene_count,
    generated_scene_ids: generatedSceneIds,
    generated_asset_ids: assetIds,
    calls,
    attempts,
    checkpoint: plan.checkpoint,
  };

  if (failure !== null) {
    const failedStage = await applyStageTransition(deps.pool, {
      projectId: job.projectId,
      stage: 'IM',
      event: 'fail',
      progress: { current: plan.already_generated, total: plan.scene_count },
      lastEvent: 'failed',
    });
    const projectStatus = await markNeedsAttention(deps.pool, job.projectId);
    return {
      ...base,
      status: 'failed',
      stage_state: failedStage.state,
      project_status: projectStatus,
      failure,
    };
  }

  if (plan.status === 'complete') {
    if (stageState !== 'done') {
      const done = await applyStageTransition(deps.pool, {
        projectId: job.projectId,
        stage: 'IM',
        event: 'succeed',
        progress: { current: plan.scene_count, total: plan.scene_count },
        lastEvent: 'succeeded',
      });
      stageState = done.state;
    }
    await markJobStatus(deps.pool, job.jobId, 'succeeded');
    const projectStatus = await resumeAfterStage(deps.pool, job.projectId);
    return {
      ...base,
      status: 'complete',
      stage_state: stageState,
      project_status: projectStatus,
      failure: null,
    };
  }

  // The first-three checkpoint is open: 3 of N generated, scenes 4+ refused.
  const parked = await updateStageProgress(deps.pool, {
    projectId: job.projectId,
    stage: 'IM',
    progress: { current: plan.already_generated, total: plan.scene_count },
    lastEvent: 'first_three_checkpoint',
  });
  await markJobStatus(deps.pool, job.jobId, 'succeeded');
  const projectStatus = await markNeedsAttention(deps.pool, job.projectId);
  return {
    ...base,
    status: 'awaiting_review',
    stage_state: parked.state,
    project_status: projectStatus,
    failure: null,
  };
}
