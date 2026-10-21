/**
 * Timing stage — US-022 (R-009-3/4), TECH_DESIGN §2 step 5, §4.7, §6.6.
 *
 * TC is a **local transform**, not a provider stage: no adapter, no
 * `generation_run` row (§4.7), no cost. It reads the stored narration take, and:
 *
 * 1. re-derives word timings from the provider's character alignment with B-07's
 *    single transform and applies the R-008-3 gate (≥99 % coverage, monotonic);
 * 2. measures the take: final audio = actual narration + the project's lead and
 *    trail (§6.5/§6.6). The acceptance band is R-009-3's **±5 %, clamped to
 *    ±1 s…±5 s** — the clamp is what makes a 10 s video demand ±1 s (not ±0.5)
 *    and a 180 s video tolerate ±5 s (not ±9);
 * 3. on a miss, returns the video to **script/voice review** and stops: the
 *    speech is never time-stretched, no scene span is written, and the take's
 *    bytes are untouched (R-009-4). TC is marked `failed` with the named reason
 *    and the video goes `NEEDS_ATTENTION`;
 * 4. on a pass, recalculates every scene's `narration_start_ms/end_ms` from the
 *    real word timings (R-009-3), stores the derived timing document as a
 *    content-addressed sidecar, and hands the pipeline to RE.
 *
 * Why a sidecar document and not a table: the frozen 22-table schema
 * (TECH_DESIGN §3) has no caption/timing table, while BACKLOG US-022 calls this
 * the title/caption schema and `contract/api.ts`'s `audio.accept` takes an
 * `alignment_id`. A content-addressed `asset` row of kind `sidecar` (stage `TC`)
 * satisfies the id, keeps R-026 dedupe, and is the smallest change that does not
 * invent schema. Raised on the card for a ruling; see evidence §5.
 */
import type { Pool } from 'pg';
import { z } from 'zod';

import { DURATION_BAND_RATIO } from '../shared/calibration.js';
import type { StageCode } from '../shared/index.js';
import {
  assetBelongsToProject,
  assetKeyContextFor,
  findAssetById,
  insertAsset,
} from '../db/repositories/assets.js';
import { markJobStatus } from '../db/repositories/jobs.js';
import { listSceneSpans, writeSceneNarrationSpans } from '../db/repositories/scene-spans.js';
import {
  applyStageEvent,
  applyVideoEvent,
  beginStage,
  findProjectState,
  setProjectCurrentStage,
} from '../db/repositories/stage-state.js';
import {
  alignmentDurationSeconds,
  deriveWordTimings,
  validateWordTimings,
  type AlignmentCoverage,
  type CharacterAlignment,
  type WordTiming,
} from '../domain/word-timing.js';
import { assetObjectKey, TIMING_OBJECT_NAME } from '../storage/object-key.js';
import { jsonBytes, sha256Hex, type AssetBlobStore } from './asset-store.js';
import { NARRATION_ALIGNMENT_SCHEMA_VERSION } from './narration-stage.js';

/** The derived timing document's schema version (R-004's versioning, applied locally). */
export const TIMING_DOCUMENT_SCHEMA_VERSION = 'timing.v1';

/** R-009-3's clamp: a ±5 % band, never narrower than ±1 s and never wider than ±5 s. */
export const MIN_TOLERANCE_S = 1;
export const MAX_TOLERANCE_S = 5;

export interface TimingBand {
  readonly target_s: number;
  readonly tolerance_s: number;
  readonly min_s: number;
  readonly max_s: number;
}

export interface TimingBandWindow extends TimingBand {
  readonly within_band: boolean;
}

function round3(value: number): number {
  return Number(value.toFixed(3));
}

/** R-009-3's band for one target duration. Bounds are rounded to the ms of a rounded tolerance. */
export function timingBand(targetDurationS: number): TimingBand {
  const tolerance = Math.min(
    MAX_TOLERANCE_S,
    Math.max(MIN_TOLERANCE_S, targetDurationS * DURATION_BAND_RATIO),
  );
  const rounded = round3(tolerance);
  return {
    target_s: targetDurationS,
    tolerance_s: rounded,
    min_s: round3(targetDurationS - rounded),
    max_s: round3(targetDurationS + rounded),
  };
}

/** One scene's slice of the narration, expressed in words (from B-09's storyboard plan). */
export interface TimingSceneInput {
  readonly scene_no: string;
  /** 1-based storyboard position. */
  readonly position: number;
  /** Inclusive index into the derived word list. */
  readonly start_word: number;
  /** Exclusive. */
  readonly end_word: number;
}

export interface TimingSceneSpan {
  readonly scene_no: string;
  readonly position: number;
  readonly start_ms: number;
  readonly end_ms: number;
  readonly duration_s: number;
}

/**
 * Map word ranges onto real speech: a scene starts when its first word starts
 * and ends when its last word ends. The plan must partition the narration
 * exactly — a gap or an overlap would hand the render a storyboard that does not
 * match what is spoken, so it is refused instead of patched up.
 */
export function sceneSpansFromWords(
  words: readonly WordTiming[],
  scenes: readonly TimingSceneInput[],
): TimingSceneSpan[] {
  if (scenes.length === 0) throw new RangeError('scene plan is empty');
  if (words.length === 0)
    throw new RangeError('scene plan cannot be mapped onto zero word timings');

  const ordered = [...scenes].sort((left, right) => left.position - right.position);
  let cursor = 0;
  const spans: TimingSceneSpan[] = [];

  for (const scene of ordered) {
    if (!Number.isInteger(scene.start_word) || !Number.isInteger(scene.end_word)) {
      throw new RangeError(`scene plan ${scene.scene_no}: word range must be integers`);
    }
    if (scene.start_word !== cursor) {
      throw new RangeError(
        `scene plan ${scene.scene_no} starts at word ${scene.start_word} but the previous scene ended at ${cursor}`,
      );
    }
    if (scene.end_word <= scene.start_word) {
      throw new RangeError(`scene plan ${scene.scene_no} has an empty word range`);
    }
    if (scene.end_word > words.length) {
      throw new RangeError(
        `scene plan ${scene.scene_no} ends at word ${scene.end_word} but only ${words.length} words are timed`,
      );
    }
    const first = words[scene.start_word]!;
    const last = words[scene.end_word - 1]!;
    spans.push({
      scene_no: scene.scene_no,
      position: scene.position,
      start_ms: first.start_ms,
      end_ms: last.end_ms,
      duration_s: round3((last.end_ms - first.start_ms) / 1000),
    });
    cursor = scene.end_word;
  }

  if (cursor !== words.length) {
    throw new RangeError(
      `scene plan covers ${cursor} of ${words.length} timed words: the narration would lose speech`,
    );
  }
  return spans;
}

export interface TimingStageInput {
  readonly jobId: string;
  readonly projectId: string;
  /** The `NA` audio asset the narration stage stored (R-013-1). */
  readonly narrationAssetId: string;
  /** The `NA` alignment sidecar for the same take. */
  readonly alignmentAssetId: string;
  /** Per-series default with the per-video override already applied (R-009-1). */
  readonly targetDurationS: number;
  /** The storyboard plan's word ranges (US-018 → US-022). */
  readonly scenes: readonly TimingSceneInput[];
  /** Defaults to the project row's `lead_s` / `trail_s` (§6.5). */
  readonly leadS?: number;
  readonly trailS?: number;
  readonly seriesVersionId?: string | null;
  readonly now?: Date;
}

export interface TimingStageDeps {
  readonly pool: Pool;
  readonly blobs: AssetBlobStore;
}

export interface TimingPlan {
  readonly project_id: string;
  readonly narration_asset_id: string;
  readonly alignment_asset_id: string;
  readonly provider: string | null;
  readonly model: string | null;
  readonly provider_request_id: string | null;
  readonly narration_duration_s: number;
  readonly final_audio_duration_s: number;
  readonly lead_s: number;
  readonly trail_s: number;
  readonly band: TimingBandWindow;
  readonly word_count: number;
  readonly words: readonly WordTiming[];
  readonly coverage: AlignmentCoverage;
  readonly monotonic: boolean;
  readonly scenes: readonly TimingSceneSpan[];
}

export type TimingReviewReason =
  'word_timings_invalid' | 'duration_out_of_band' | 'scene_plan_invalid';

/** What the operator is sent back to, and why (R-009-4). */
export interface TimingReview {
  readonly reason: TimingReviewReason;
  /** `SC` = script review, `NA` = voice review (R-009-4 "script/voice review"). */
  readonly review_targets: readonly StageCode[];
  readonly failures: readonly string[];
  readonly measured_duration_s: number;
  readonly band: TimingBandWindow;
  /** Structurally false: this module has no audio transform at all. */
  readonly time_stretched: false;
}

export type TimingStageResult =
  | { readonly status: 'timed'; readonly plan: TimingPlan; readonly timing_asset_id: string }
  | { readonly status: 'review_required'; readonly review: TimingReview };

export interface TimingDocument {
  readonly schema_version: typeof TIMING_DOCUMENT_SCHEMA_VERSION;
  readonly project_id: string;
  readonly target_duration_s: number;
  readonly narration: {
    readonly asset_id: string;
    readonly alignment_asset_id: string;
    readonly duration_s: number;
    readonly provider: string | null;
    readonly model: string | null;
    readonly provider_request_id: string | null;
  };
  readonly lead_s: number;
  readonly trail_s: number;
  readonly final_audio_duration_s: number;
  readonly band: TimingBandWindow;
  readonly word_count: number;
  readonly words: readonly WordTiming[];
  readonly coverage: AlignmentCoverage;
  readonly monotonic: boolean;
  readonly scenes: readonly TimingSceneSpan[];
  readonly derived_at: string;
}

/**
 * The alignment sidecar's wire schema. Untimed characters were `NaN` in process
 * and JSON has no NaN, so they travel as `null` and are restored here — an
 * untimed character must stay untimed, never become 0.
 */
const AlignmentNumber = z.number().finite().nullable();
const AlignmentDocumentSchema = z.object({
  schema_version: z.string(),
  provider: z.string(),
  model: z.string(),
  provider_request_id: z.string().nullable(),
  text: z.string(),
  duration_s: z.number().finite(),
  alignment: z.object({
    characters: z.array(z.string()),
    character_start_times_seconds: z.array(AlignmentNumber),
    character_end_times_seconds: z.array(AlignmentNumber),
  }),
});

export interface ParsedAlignmentDocument {
  readonly provider: string;
  readonly model: string;
  readonly provider_request_id: string | null;
  readonly text: string;
  readonly duration_s: number;
  readonly alignment: CharacterAlignment;
}

/** Parse the narration sidecar; a document that is not ours is refused loudly. */
export function parseAlignmentDocument(bytes: Uint8Array): ParsedAlignmentDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new Error(`the alignment sidecar is not JSON: ${(error as Error).message}`);
  }
  const parsed = AlignmentDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `the alignment sidecar is not a narration-alignment document: ${parsed.error.message}`,
    );
  }
  if (parsed.data.schema_version !== NARRATION_ALIGNMENT_SCHEMA_VERSION) {
    throw new Error(
      `alignment sidecar schema_version ${parsed.data.schema_version} is not ${NARRATION_ALIGNMENT_SCHEMA_VERSION}`,
    );
  }
  const { characters } = parsed.data.alignment;
  const starts = parsed.data.alignment.character_start_times_seconds.map(
    (value) => value ?? Number.NaN,
  );
  const ends = parsed.data.alignment.character_end_times_seconds.map(
    (value) => value ?? Number.NaN,
  );
  if (characters.length !== starts.length || characters.length !== ends.length) {
    throw new Error(
      `alignment sidecar arrays disagree in length: characters=${characters.length}, starts=${starts.length}, ends=${ends.length}`,
    );
  }
  return {
    provider: parsed.data.provider,
    model: parsed.data.model,
    provider_request_id: parsed.data.provider_request_id,
    text: parsed.data.text,
    duration_s: parsed.data.duration_s,
    alignment: {
      characters,
      character_start_times_seconds: starts,
      character_end_times_seconds: ends,
    },
  };
}

function assertTargetDuration(targetDurationS: number): void {
  if (!Number.isInteger(targetDurationS) || targetDurationS < 10 || targetDurationS > 180) {
    throw new RangeError(
      `target duration must be an integer 10..180 s (R-009-1), got ${String(targetDurationS)}`,
    );
  }
}

/** Send the video back to script/voice review and stop (R-009-4). */
async function returnToReview(
  deps: TimingStageDeps,
  input: TimingStageInput,
  reason: TimingReviewReason,
  reviewTargets: readonly StageCode[],
  failures: readonly string[],
  measuredDurationS: number,
  band: TimingBandWindow,
): Promise<TimingStageResult> {
  await applyStageEvent(deps.pool, input.projectId, 'TC', 'fail');
  await applyVideoEvent(deps.pool, input.projectId, 'needs_attention');
  await markJobStatus(deps.pool, input.jobId, 'failed');
  return {
    status: 'review_required',
    review: {
      reason,
      review_targets: reviewTargets,
      failures,
      measured_duration_s: measuredDurationS,
      band,
      time_stretched: false,
    },
  };
}

/**
 * Run TC for one video: validate the take, then either record the recalculated
 * scene spans or return the video to review. Idempotent on a retry: the same
 * take produces the same timing document hash and the same spans.
 */
export async function runTimingStage(
  deps: TimingStageDeps,
  input: TimingStageInput,
): Promise<TimingStageResult> {
  assertTargetDuration(input.targetDurationS);

  const project = await findProjectState(deps.pool, input.projectId);
  if (project === null) throw new Error(`project ${input.projectId} does not exist`);

  const narrationAsset = await findAssetById(deps.pool, input.narrationAssetId);
  if (
    narrationAsset === null ||
    narrationAsset.stage !== 'NA' ||
    narrationAsset.kind !== 'audio' ||
    !(await assetBelongsToProject(deps.pool, narrationAsset.id, input.projectId))
  ) {
    throw new Error(
      `asset ${input.narrationAssetId} is not the narration audio of project ${input.projectId}`,
    );
  }
  const alignmentAsset = await findAssetById(deps.pool, input.alignmentAssetId);
  if (
    alignmentAsset === null ||
    alignmentAsset.stage !== 'NA' ||
    alignmentAsset.kind !== 'sidecar' ||
    !(await assetBelongsToProject(deps.pool, alignmentAsset.id, input.projectId))
  ) {
    throw new Error(
      `asset ${input.alignmentAssetId} is not the alignment sidecar of project ${input.projectId}`,
    );
  }

  const document = parseAlignmentDocument(await deps.blobs.get(alignmentAsset.object_key));

  await beginStage(deps.pool, input.projectId, 'TC', {
    seriesVersionId: input.seriesVersionId ?? null,
  });

  const timings = deriveWordTimings(
    document.alignment,
    document.text === '' ? {} : { script: document.text },
  );
  const validation = validateWordTimings(timings);
  const narrationDurationS = document.duration_s;
  const leadS = input.leadS ?? project.lead_s;
  const trailS = input.trailS ?? project.trail_s;
  const finalAudioDurationS = narrationDurationS + leadS + trailS;
  const base = timingBand(input.targetDurationS);
  const band: TimingBandWindow = {
    ...base,
    within_band: finalAudioDurationS >= base.min_s && finalAudioDurationS <= base.max_s,
  };

  if (!validation.ok) {
    return returnToReview(
      deps,
      input,
      'word_timings_invalid',
      ['SC', 'NA'],
      validation.failures,
      finalAudioDurationS,
      band,
    );
  }

  if (!band.within_band) {
    const percent = ((finalAudioDurationS - input.targetDurationS) / input.targetDurationS) * 100;
    return returnToReview(
      deps,
      input,
      'duration_out_of_band',
      ['SC', 'NA'],
      [
        `actual narration ${narrationDurationS.toFixed(2)} s + lead/trail ${(leadS + trailS).toFixed(2)} s ` +
          `= ${finalAudioDurationS.toFixed(2)} s vs target ${input.targetDurationS} s ` +
          `(${percent >= 0 ? '+' : ''}${percent.toFixed(1)}%), outside ${base.min_s}–${base.max_s} s ` +
          `(R-009-3: ±5 %, clamped ±1…±5 s). The video returned to script/voice review; ` +
          'the speech was not time-stretched (R-009-4).',
      ],
      finalAudioDurationS,
      band,
    );
  }

  const knownScenes = new Set(
    (await listSceneSpans(deps.pool, input.projectId)).map((row) => row.scene_no),
  );
  const missing = input.scenes
    .filter((scene) => !knownScenes.has(scene.scene_no))
    .map((scene) => scene.scene_no);
  if (missing.length > 0) {
    return returnToReview(
      deps,
      input,
      'scene_plan_invalid',
      ['SC'],
      [`timing plan names scenes that do not exist on the project: ${missing.join(', ')}`],
      finalAudioDurationS,
      band,
    );
  }

  let spans: TimingSceneSpan[];
  try {
    spans = sceneSpansFromWords(timings.words, input.scenes);
  } catch (error) {
    return returnToReview(
      deps,
      input,
      'scene_plan_invalid',
      ['SC'],
      [(error as Error).message],
      finalAudioDurationS,
      band,
    );
  }

  const now = input.now ?? new Date();
  const timingDocument: TimingDocument = {
    schema_version: TIMING_DOCUMENT_SCHEMA_VERSION,
    project_id: input.projectId,
    target_duration_s: input.targetDurationS,
    narration: {
      asset_id: input.narrationAssetId,
      alignment_asset_id: input.alignmentAssetId,
      duration_s: narrationDurationS,
      provider: narrationAsset.provider,
      model: narrationAsset.model,
      provider_request_id: narrationAsset.provider_request_id,
    },
    lead_s: leadS,
    trail_s: trailS,
    final_audio_duration_s: finalAudioDurationS,
    band,
    word_count: timings.words.length,
    words: timings.words,
    coverage: timings.coverage,
    monotonic: timings.monotonic,
    scenes: spans,
    derived_at: now.toISOString(),
  };
  const bytes = jsonBytes(timingDocument);
  const contentSha256 = sha256Hex(bytes);
  const keyCtx = await assetKeyContextFor(deps.pool, input.projectId);
  const objectKey = assetObjectKey({
    seriesSlug: keyCtx.seriesSlug,
    batchOrdinal: keyCtx.batchOrdinal,
    name: TIMING_OBJECT_NAME,
  });
  await deps.blobs.put(objectKey, bytes, 'application/json');

  // `asset.stage` admits no 'TC' (M-004 CHECK: IM/NA/RE/QC/EX/MUSIC/POSTER/DERIV/REF),
  // and TC is a local derivation of the narration, so the timing document is
  // stored as an NA sidecar and records the producing stage in its metadata.
  const timingAsset = await insertAsset(deps.pool, {
    projectId: input.projectId,
    stage: 'NA',
    kind: 'sidecar',
    contentSha256,
    objectKey,
    objectSizeBytes: bytes.byteLength,
    mimeType: 'application/json',
    seriesVersionId: input.seriesVersionId ?? null,
    provider: narrationAsset.provider,
    model: narrationAsset.model,
    providerRequestId: narrationAsset.provider_request_id,
    promptHash: narrationAsset.prompt_hash,
    rightsMetadata: {
      stage: 'TC',
      derived_from_asset_id: input.narrationAssetId,
      alignment_asset_id: input.alignmentAssetId,
    },
  });

  await writeSceneNarrationSpans(
    deps.pool,
    input.projectId,
    spans.map((span) => ({
      scene_no: span.scene_no,
      start_ms: span.start_ms,
      end_ms: span.end_ms,
    })),
  );
  await applyStageEvent(deps.pool, input.projectId, 'TC', 'succeed');
  await setProjectCurrentStage(deps.pool, input.projectId, 'RE');
  await markJobStatus(deps.pool, input.jobId, 'succeeded');

  return {
    status: 'timed',
    timing_asset_id: timingAsset.row.id,
    plan: {
      project_id: input.projectId,
      narration_asset_id: input.narrationAssetId,
      alignment_asset_id: input.alignmentAssetId,
      provider: narrationAsset.provider,
      model: narrationAsset.model,
      provider_request_id: narrationAsset.provider_request_id,
      narration_duration_s: narrationDurationS,
      final_audio_duration_s: finalAudioDurationS,
      lead_s: leadS,
      trail_s: trailS,
      band,
      word_count: timings.words.length,
      words: timings.words,
      coverage: timings.coverage,
      monotonic: timings.monotonic,
      scenes: spans,
    },
  };
}

/** The take's alignment duration, exposed for callers that only hold the document. */
export function alignmentDocumentDuration(document: ParsedAlignmentDocument): number {
  return alignmentDurationSeconds(document.alignment);
}
