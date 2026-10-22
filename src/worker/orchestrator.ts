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
import { settleAfterStage } from './settle.js';
import { MAX_ATTEMPTS_PER_JOB } from '../workers/attempt.js';
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
import { resolveVoiceId } from './providers.js';

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
  /** `ELEVENLABS_VOICE_ID` fallback when a series has no voice configured. */
  readonly defaultVoiceId?: string;
  /**
   * The voice model when a series does not configure one. Without it the loader
   * fell back to FAKE_VOICE.model_id ('fake-tts-model'), which ElevenLabs
   * rejects — so the first real narration would have failed on a model name that
   * only ever existed for the fixture.
   */
  readonly defaultModelId?: string;
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

async function loadVoice(
  pool: Pool,
  projectId: string,
  fallbackVoiceId: string | undefined,
  fallbackModelId: string | undefined,
): Promise<NarrationVoiceConfig> {
  const result = await pool.query<{ voice_config: unknown }>(
    `SELECT s.voice_config FROM project p JOIN series s ON s.id = p.series_id WHERE p.id = $1`,
    [projectId],
  );
  const config = result.rows[0]?.voice_config as
    { voice_id?: unknown; model_id?: unknown; licence_kind?: unknown } | null | undefined;

  if (config === null || config === undefined) {
    return {
      ...FAKE_VOICE,
      voice_id: resolveVoiceId(undefined, fallbackVoiceId) ?? FAKE_VOICE.voice_id,
      model_id: resolveVoiceId(undefined, fallbackModelId) ?? FAKE_VOICE.model_id,
    };
  }

  // `voice_config.voice_id` may be `''` (the "not set" sentinel). A non-empty
  // check, not `??`, so blank/whitespace falls back to ELEVENLABS_VOICE_ID.
  const seriesVoiceId = typeof config.voice_id === 'string' ? config.voice_id : undefined;
  return {
    voice_id: resolveVoiceId(seriesVoiceId, fallbackVoiceId) ?? FAKE_VOICE.voice_id,
    model_id:
      resolveVoiceId(
        typeof config.model_id === 'string' ? config.model_id : undefined,
        fallbackModelId,
      ) ?? FAKE_VOICE.model_id,
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
/**
 * The attempt number this dispatch should record.
 *
 * The job row does not carry a counter — `job_attempt` is the ledger, and
 * (job_id, attempt_no) is unique. Hardcoding 1 meant any second dispatch of the
 * same job collided with its own first attempt and the stage died with
 * 'another worker holds it' while nobody held anything.
 */
async function nextAttemptNo(pool: Pool, jobId: string): Promise<number> {
  const result = await pool.query<{ next: number }>(
    `SELECT coalesce(max(attempt_no), 0) + 1 AS next FROM job_attempt WHERE job_id = $1`,
    [jobId],
  );
  return Number(result.rows[0]?.next ?? 1);
}

export async function runStage(deps: OrchestratorDeps, job: ClaimedJob): Promise<StageRunOutcome> {
  await ensureProjectRunning(deps.pool, job.projectId);
  const attemptNo = await nextAttemptNo(deps.pool, job.id);
  // R-011-2's ladder caps *automatic* attempts. An operator pressing Regenerate is a
  // deliberate human decision, so it may go past three — the flag is set by
  // regenerate and consumed when the attempt opens (D-H, M-009).
  const retry = await deps.pool.query<{ operator_retry_at: Date | null }>(
    'SELECT operator_retry_at FROM job WHERE id = $1',
    [job.id],
  );
  const operatorInitiated = retry.rows[0]?.operator_retry_at != null;
  if (!operatorInitiated && attemptNo > MAX_ATTEMPTS_PER_JOB) {
    // A fourth automatic dispatch is a bug upstream, not a provider problem.
    // Say *why* the earlier attempts failed: "budget exhausted" alone sent the
    // operator looking for a provider fault that was already recorded.
    const last = await deps.pool.query<{ error_message: string | null }>(
      `SELECT error_message FROM job_attempt
        WHERE job_id = $1 AND status = 'failed'
        ORDER BY attempt_no DESC LIMIT 1`,
      [job.id],
    );
    const cause = last.rows[0]?.error_message?.trim();
    return {
      status: 'failed',
      message:
        `attempt budget exhausted for job ${job.id} (${MAX_ATTEMPTS_PER_JOB} automatic attempts)` +
        (cause === undefined || cause === '' ? '' : `; last failure: ${cause}`),
    };
  }
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
      const voice = await loadVoice(
        deps.pool,
        job.projectId,
        deps.defaultVoiceId,
        deps.defaultModelId,
      );
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
 * Whether this video must wait for a human before images. A video whose storyboard
 * is already approved (SB `done`) is past the gate, so a retry of an earlier stage
 * does not re-park it.
 */
export async function storyboardGateApplies(pool: Pool, projectId: string): Promise<boolean> {
  // "Has anybody approved this?" is answered by the ledger, not by SB's state:
  // the stage is already `done` when this runs, and approval sets it to `done`
  // too, so the two are indistinguishable by state alone. Image generation only
  // ever exists because an operator released the gate (or a legacy batch predates
  // it), which makes the IM job's absence the one honest signal.
  const result = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM job WHERE project_id = $1 AND stage = 'IM'`,
    [projectId],
  );
  return result.rows[0]?.n === '0';
}

/**
 * Mint the next job after a stage succeeds. Idempotent: a duplicate advance
 * (crash between the stage completing and the mint) is refused because a
 * non-failed job for that (project, stage) already exists.
 */
export async function advanceAfterStage(pool: Pool, job: ClaimedJob): Promise<StageCode | null> {
  // The operator's gate: every word is written and readable before a single image
  // or second of voice is paid for. SB parks in `awaiting_approval` and nothing is
  // minted; `POST /videos/:id/generate` approves the storyboard and mints IM.
  if (job.stage === 'SB' && (await storyboardGateApplies(pool, job.projectId))) {
    await applyStageEvent(pool, job.projectId, 'SB', 'gate');
    await setProjectCurrentStage(pool, job.projectId, 'SB');
    return null;
  }

  const next = NEXT_STAGE[job.stage];
  if (next === undefined) {
    // RE is the end of the rail for this milestone, so this is where a finished
    // video (and possibly its batch) is marked complete. Without this the batch
    // read ACTIVE forever and the UI could not say a video was ready.
    await settleAfterStage(pool, job.projectId);
    return null;
  }

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
