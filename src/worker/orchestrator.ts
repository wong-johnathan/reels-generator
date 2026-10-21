/**
 * Orchestration spine — the stage dispatch table and the pipeline advance.
 *
 * This is the missing piece between the queue and the existing stage runners:
 * it knows, per stage, which runner to call, what persisted inputs to gather
 * first (narration needs the approved script + voice; timing needs the NA audio
 * and the storyboard's word ranges), and what the next stage is. Every stage
 * move still flows through `beginStage`/`applyStageEvent` (the state machine's
 * only writers) — this module never issues a bare UPDATE against `video_stage`.
 *
 * `RS` (research) is a pass-through in this milestone: research requires real
 * source capture (B-02), which is out of scope for proving the render spine, so
 * the stage is marked done without a provider call. Stated plainly, not hidden.
 */
import type { Pool } from 'pg';

import { spokenNarration } from '../domain/authoring.js';
import { resolveProjectTargetDuration } from '../domain/series.js';
import type { ScriptDocument } from '../domain/authoring.js';
import type { StageCode } from '../shared/stages.js';
import { applyProjectStatusTransition } from '../db/repositories/video-stages.js';
import { applyStageEvent, setProjectCurrentStage } from '../db/repositories/stage-state.js';
import { insertQueuedJob } from '../db/repositories/jobs.js';
import type { ContentAddressedStore } from '../storage/object-store.js';
import type { AssetBlobStore } from '../workers/asset-store.js';
import type { ImageAdapter } from '../adapters/image.js';
import type { ImageQualificationStore } from '../adapters/image-qualification.js';
import type { TextAdapter } from '../adapters/text.js';
import type { TtsAdapter } from '../adapters/tts.js';
import type { FfmpegRunner } from '../render/ffmpeg.js';
import { runTextStage, type TextStageDeps, type TextStageJob } from '../workers/text-stage.js';
import { runImageStage } from '../workers/image-stage.js';
import { runNarrationStage, type NarrationVoiceConfig } from '../workers/narration-stage.js';
import { runTimingStage, type TimingSceneInput } from '../workers/timing-stage.js';
import { runRenderStage } from '../render/stage.js';

/** Stages the content worker claims. */
export const CONTENT_STAGES: readonly StageCode[] = ['T', 'RS', 'SC', 'SB', 'IM', 'NA', 'TC'];
/** Stages the render worker claims. */
export const RENDER_STAGES: readonly StageCode[] = ['RE'];

/** What the content worker produces next after a stage succeeds. */
const NEXT_STAGE: Partial<Record<StageCode, StageCode>> = {
  T: 'RS',
  RS: 'SC',
  SC: 'SB',
  SB: 'IM',
  IM: 'NA',
  NA: 'TC',
  TC: 'RE',
  // RE is terminal for this milestone: QC/FA/EX are operator gates (B-04).
};

export interface ClaimedJob {
  readonly id: string;
  readonly projectId: string;
  readonly stage: StageCode;
  readonly sceneId: string | null;
  readonly priority: number;
}

export interface OrchestratorDeps {
  readonly pool: Pool;
  readonly text: TextAdapter;
  readonly tts: TtsAdapter;
  readonly image: ImageAdapter;
  readonly qualification: ImageQualificationStore;
  /** Narration/timing/storyboard-plan blobs (AssetBlobStore surface). */
  readonly contentBlobs: AssetBlobStore;
  /** Image/render blobs (ContentAddressedStore surface). */
  readonly renderBlobs: ContentAddressedStore;
  readonly runner: FfmpegRunner;
  readonly workerId?: string | null;
}

export type StageRunStatus = 'succeeded' | 'retryable' | 'failed';

export interface StageRunOutcome {
  readonly status: StageRunStatus;
  readonly message?: string;
}

/**
 * A "succeeded but gated" result is terminal for the *automatic* loop: an
 * operator must approve before the pipeline advances. The milestone fake run
 * never reaches it (the fixture sits inside the timing band), but it must not
 * be silently treated as progress.
 */
function gated(message: string): StageRunOutcome {
  return { status: 'failed', message };
}

/** The voice the fake run speaks with when the series has none configured. */
export const FAKE_VOICE: NarrationVoiceConfig = {
  voice_id: 'fake-voice',
  model_id: 'fake-tts-model',
  licence_kind: 'elevenlabs-commercial',
  licence_note: 'fake milestone voice (no series voice_config)',
};

async function loadApprovedScript(pool: Pool, projectId: string): Promise<ScriptDocument> {
  const result = await pool.query<{ content: unknown }>(
    `SELECT content FROM script_revision
      WHERE project_id = $1 AND status = 'approved'
      ORDER BY revision DESC
      LIMIT 1`,
    [projectId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`project ${projectId} has no approved script`);
  return row.content as ScriptDocument;
}

async function loadVoice(pool: Pool, projectId: string): Promise<NarrationVoiceConfig> {
  const result = await pool.query<{ voice_config: unknown }>(
    `SELECT s.voice_config FROM project p JOIN series s ON s.id = p.series_id WHERE p.id = $1`,
    [projectId],
  );
  const config = result.rows[0]?.voice_config as
    { voice_id?: unknown; model_id?: unknown; licence_kind?: unknown } | null | undefined;
  if (config === null || config === undefined) return FAKE_VOICE;
  return {
    voice_id: typeof config.voice_id === 'string' ? config.voice_id : FAKE_VOICE.voice_id,
    model_id: typeof config.model_id === 'string' ? config.model_id : FAKE_VOICE.model_id,
    licence_kind:
      typeof config.licence_kind === 'string' ? config.licence_kind : FAKE_VOICE.licence_kind,
  };
}

async function loadNarrationAssets(
  pool: Pool,
  projectId: string,
): Promise<{ narrationAssetId: string; alignmentAssetId: string }> {
  const result = await pool.query<{ role: string; asset_id: string }>(
    `SELECT role, asset_id FROM asset_ref
      WHERE project_id = $1 AND role IN ('narration', 'narration_alignment')`,
    [projectId],
  );
  const narration = result.rows.find((row) => row.role === 'narration')?.asset_id;
  const alignment = result.rows.find((row) => row.role === 'narration_alignment')?.asset_id;
  if (narration === undefined || alignment === undefined) {
    throw new Error(`project ${projectId} has no narration assets; the NA stage must run first`);
  }
  return { narrationAssetId: narration, alignmentAssetId: alignment };
}

async function loadStoryboardPlanScenes(
  pool: Pool,
  blobs: AssetBlobStore,
  projectId: string,
): Promise<TimingSceneInput[]> {
  const result = await pool.query<{ object_key: string }>(
    `SELECT object_key FROM asset
      WHERE project_id = $1 AND stage = 'NA' AND kind = 'sidecar'
        AND rights_metadata->>'stage' = 'SB'
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [projectId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`project ${projectId} has no storyboard plan; the SB stage must run first`);
  }
  const bytes = await blobs.get(row.object_key);
  const document = JSON.parse(new TextDecoder().decode(bytes)) as {
    scenes?: readonly {
      scene_no?: unknown;
      position?: unknown;
      start_word?: unknown;
      end_word?: unknown;
    }[];
  };
  if (document.scenes === undefined) {
    throw new Error(`project ${projectId} storyboard plan has no scenes`);
  }
  return document.scenes.map((scene, index) => {
    const rawPosition = Number(scene.position);
    const position = Number.isInteger(rawPosition) ? rawPosition : index + 1;
    return {
      scene_no: String(scene.scene_no),
      position,
      start_word: Number(scene.start_word),
      end_word: Number(scene.end_word),
    } satisfies TimingSceneInput;
  });
}

/** The fake image adapter's provider + adapter name (image-qualification.ts). */
const FAKE_IMAGE_PROVIDER = 'fake';
const FAKE_IMAGE_ADAPTER = 'FakeImageAdapter';

/**
 * Record a passing qualification for the fake image adapter. The image stage's
 * gate (`assertImageQualified`) only passes when the newest record is a pass;
 * the milestone's fixture adapter is pre-qualified by construction, so this is
 * seeded once at boot rather than running the real US-012 qualification flow.
 */
export async function seedFakeImageQualification(store: ImageQualificationStore): Promise<void> {
  await store.record({
    provider: FAKE_IMAGE_PROVIDER,
    adapter: FAKE_IMAGE_ADAPTER,
    passed: true,
    details: { note: 'fake milestone: fixture adapter, pre-qualified (no provider call)' },
  });
}

/** NOT_STARTED → RUNNING on the first stage that claims (idempotent). */
async function ensureProjectRunning(pool: Pool, projectId: string): Promise<void> {
  const result = await pool.query<{ status: string }>(`SELECT status FROM project WHERE id = $1`, [
    projectId,
  ]);
  const status = result.rows[0]?.status;
  if (status === 'NOT_STARTED') {
    await applyProjectStatusTransition(pool, { projectId, event: 'first_claim' });
  }
}

/**
 * Run one claimed job. Returns a tri-state the loop maps onto job status:
 * `succeeded` (mark job succeeded + advance), `retryable` (leave the job — the
 * retry backoff will re-claim it), `failed` (mark job failed, terminal).
 */
export async function runStage(deps: OrchestratorDeps, job: ClaimedJob): Promise<StageRunOutcome> {
  await ensureProjectRunning(deps.pool, job.projectId);
  const attemptNo = 1;
  const workerId = deps.workerId ?? null;

  switch (job.stage) {
    case 'T':
    case 'SC':
    case 'SB': {
      const textDeps: TextStageDeps = {
        pool: deps.pool,
        text: deps.text,
        blobs: deps.contentBlobs,
      };
      const textJob: TextStageJob = {
        jobId: job.id,
        projectId: job.projectId,
        attemptNo,
        workerId,
      };
      const result = await runTextStage(textDeps, job.stage, textJob);
      if (result.status === 'succeeded') return { status: 'succeeded' };
      return result.attempt.retry.requeue
        ? { status: 'retryable', message: result.attempt.failure?.message }
        : { status: 'failed', message: result.attempt.failure?.message };
    }

    case 'RS': {
      // Research pass-through (see module docstring): no provider call, no
      // generation_run. The stage is marked done so the pipeline can advance.
      await applyStageEvent(deps.pool, job.projectId, 'RS', 'claim');
      await applyStageEvent(deps.pool, job.projectId, 'RS', 'succeed');
      await setProjectCurrentStage(deps.pool, job.projectId, 'SC');
      return { status: 'succeeded' };
    }

    case 'IM': {
      const result = await runImageStage(
        {
          pool: deps.pool,
          adapter: deps.image,
          blobs: deps.renderBlobs,
          qualification: deps.qualification,
          workerId,
        },
        { jobId: job.id, projectId: job.projectId, attemptNo, workerId },
      );
      if (result.status === 'complete') return { status: 'succeeded' };
      if (result.status === 'awaiting_review') {
        return gated(
          `image stage is awaiting operator review (${result.checkpoint.first_three_generated}/${result.checkpoint.first_three_total} checkpoint scenes)`,
        );
      }
      return result.failure?.errorClass === 'transient'
        ? { status: 'retryable', message: result.failure.message }
        : { status: 'failed', message: result.failure?.message };
    }

    case 'NA': {
      const script = await loadApprovedScript(deps.pool, job.projectId);
      const voice = await loadVoice(deps.pool, job.projectId);
      const result = await runNarrationStage(
        { pool: deps.pool, tts: deps.tts, blobs: deps.contentBlobs },
        {
          jobId: job.id,
          attemptNo,
          projectId: job.projectId,
          narration: spokenNarration(script),
          voice,
          seriesVersionId: null,
          workerId,
        },
      );
      if (result.status === 'stored') return { status: 'succeeded' };
      return result.retried
        ? { status: 'retryable', message: result.message }
        : { status: 'failed', message: result.message };
    }

    case 'TC': {
      const { narrationAssetId, alignmentAssetId } = await loadNarrationAssets(
        deps.pool,
        job.projectId,
      );
      const scenes = await loadStoryboardPlanScenes(deps.pool, deps.contentBlobs, job.projectId);
      const target = await resolveProjectTargetDuration(deps.pool, job.projectId);
      const result = await runTimingStage(
        { pool: deps.pool, blobs: deps.contentBlobs },
        {
          jobId: job.id,
          projectId: job.projectId,
          narrationAssetId,
          alignmentAssetId,
          targetDurationS: target.effectiveTargetS,
          scenes,
          seriesVersionId: null,
        },
      );
      if (result.status === 'timed') return { status: 'succeeded' };
      return gated(
        `timing stage returned to review: ${result.review.reason} (${result.review.failures.join('; ')})`,
      );
    }

    case 'RE': {
      const result = await runRenderStage(
        { pool: deps.pool, blobs: deps.renderBlobs, runner: deps.runner },
        { jobId: job.id, projectId: job.projectId },
      );
      if (result.status === 'rendered') return { status: 'succeeded' };
      return { status: 'failed', message: result.error ?? 'render failed' };
    }

    default:
      return { status: 'failed', message: `no runner for stage ${String(job.stage)}` };
  }
}

/**
 * Mint the next job after a stage succeeds. Idempotent: a duplicate advance
 * (crash between the stage completing and the mint) is refused because a
 * non-failed job for that (project, stage) already exists.
 */
export async function advanceAfterStage(pool: Pool, job: ClaimedJob): Promise<StageCode | null> {
  const next = NEXT_STAGE[job.stage];
  if (next === undefined) return null;

  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM job
      WHERE project_id = $1 AND stage = $2 AND status IN ('queued', 'running', 'succeeded')
      LIMIT 1`,
    [job.projectId, next],
  );
  if (existing.rows.length === 0) {
    await insertQueuedJob(pool, { projectId: job.projectId, stage: next, priority: 2 });
  }

  // Keep project.current_stage in lockstep with the minted job. Idempotent: the
  // NA/TC/RE runners already advance it themselves; the image stage does not,
  // so this closes that gap without touching the existing runner.
  await setProjectCurrentStage(pool, job.projectId, next);
  return next;
}
