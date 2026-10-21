/**
 * Narration stage — US-021 (R-013-1/2, R-008-1), TECH_DESIGN §2 step 5, §4.7, §5.4.
 *
 * One TTS call, stored so the speech is *reusable and traceable*:
 *
 * - the call goes through `runProviderAttempt`, so `job_attempt` +
 *   `generation_run` are committed before the adapter can open a socket
 *   (R-012-1) and the 1 s/4 s/16 s retry policy, unknown-charge marking and the
 *   pending-run guard are B-08's, not re-implemented here;
 * - the audio bytes and the provider's character alignment are stored *before*
 *   the cost row closes billed (the `onResult` seam), content-addressed, so the
 *   same take can never be stored twice (R-026);
 * - `asset` carries the whole R-013-1 provenance set — provider, model,
 *   `provider_request_id`, `prompt_hash`/`prompt_text`, the series version in
 *   effect, the `generation_run` id — plus the voice/licence context the Signal
 *   line names;
 * - the alignment is a sidecar document rather than extra columns, because the
 *   character-level payload is exactly what the timing stage consumes and a
 *   content-addressed sidecar is the only timing record the frozen 22-table
 *   schema has room for (see the card comment and `timing-stage.ts`).
 *
 * Nothing here validates duration or coverage: that is TC's job (US-022), and a
 * take that later returns to review is still a paid, stored take (R-009-4).
 */
import type { Pool } from 'pg';

import {
  asProviderAdapter,
  ttsPromptHash,
  type TtsAdapter,
  type TtsConvertRequest,
  type TtsConvertResult,
} from '../adapters/tts.js';
import { withTransaction } from '../db/client.js';
import {
  assetKeyContextFor,
  insertAsset,
  linkAssetToProject,
  type AssetRow,
} from '../db/repositories/assets.js';
import { recordPendingRunProviderRequestId } from '../db/repositories/generation-runs.js';
import {
  applyStageEvent,
  beginStage,
  setProjectCurrentStage,
} from '../db/repositories/stage-state.js';
import {
  alignmentDurationSeconds,
  deriveWordTimings,
  type AlignmentCoverage,
  type CharacterAlignment,
  type WordTiming,
} from '../domain/word-timing.js';
import { runProviderAttempt, type AttemptOutcome, type AttemptResultRef } from './attempt.js';
import {
  assetObjectKey,
  NARRATION_ALIGNMENT_OBJECT_NAME,
  NARRATION_OBJECT_NAME,
} from '../storage/object-key.js';
import { jsonBytes, sha256Hex, type AssetBlobStore } from './asset-store.js';

/** The alignment sidecar's versioned schema (R-004's versioning rule, applied locally). */
export const NARRATION_ALIGNMENT_SCHEMA_VERSION = 'narration-alignment.v1';

/** R-013-1: the voice/licence context stored beside the audio. */
export interface NarrationVoiceConfig {
  readonly voice_id: string;
  readonly model_id: string;
  /** e.g. `elevenlabs-commercial`; stored, never guessed. */
  readonly licence_kind: string;
  readonly licence_note?: string;
}

export interface NarrationStageInput {
  readonly jobId: string;
  /** 1..3 — B-08's attempt position, `job.attemptsMade + 1` in the BullMQ path. */
  readonly attemptNo: number;
  readonly projectId: string;
  /** The approved spoken narration (hook + narration + ending). */
  readonly narration: string;
  readonly voice: NarrationVoiceConfig;
  readonly seriesVersionId?: string | null;
  readonly sceneId?: string | null;
  readonly workerId?: string | null;
}

export interface NarrationStageDeps {
  readonly pool: Pool;
  readonly tts: TtsAdapter;
  readonly blobs: AssetBlobStore;
}

/** The narration as persisted — what TC and S-14 read back (US-021's output). */
export interface StoredNarration {
  readonly project_id: string;
  readonly generation_run_id: string;
  readonly audio_asset_id: string;
  readonly alignment_asset_id: string;
  readonly content_sha256: string;
  readonly object_key: string;
  readonly duration_s: number;
  readonly provider: string;
  readonly model: string;
  readonly provider_request_id: string | null;
  readonly voice: NarrationVoiceConfig;
  readonly prompt_hash: string;
  readonly text: string;
  readonly word_count: number;
  readonly words: readonly WordTiming[];
  readonly coverage: AlignmentCoverage;
  readonly monotonic: boolean;
  readonly series_version_id: string | null;
  readonly created_at: string;
}

export type NarrationStageResult =
  | {
      readonly status: 'stored';
      readonly narration: StoredNarration;
      readonly attempt: AttemptOutcome;
    }
  | {
      readonly status: 'failed';
      readonly attempt: AttemptOutcome;
      readonly error_class: 'transient' | 'non_retryable';
      readonly message: string;
      /** True while B-08 will retry (transient, attempts remain) — the stage stays `running`. */
      readonly retried: boolean;
    };

/** The provider payload of TECH_DESIGN §5.4, built from the approved text + voice. */
export function narrationRequest(input: {
  readonly narration: string;
  readonly voice: NarrationVoiceConfig;
}): TtsConvertRequest {
  return {
    text: input.narration.trim(),
    voice_id: input.voice.voice_id,
    model_id: input.voice.model_id,
  };
}

export interface NarrationAlignmentDocument {
  readonly schema_version: typeof NARRATION_ALIGNMENT_SCHEMA_VERSION;
  readonly provider: string;
  readonly model: string;
  readonly provider_request_id: string | null;
  readonly voice: { readonly voice_id: string; readonly model_id: string };
  readonly text: string;
  readonly duration_s: number;
  readonly alignment: CharacterAlignment;
  readonly word_count: number;
  readonly coverage: AlignmentCoverage;
  readonly monotonic: boolean;
}

/**
 * Build the sidecar document TC parses; exported so the shape is testable.
 *
 * Deliberately carries no derivation timestamp: the document must be a pure
 * function of the provider payload, so re-storing an identical take is a
 * content-hash no-op (R-026) instead of a second row. The `asset` row already
 * records `created_at`.
 */
export function buildAlignmentDocument(input: {
  readonly request: TtsConvertRequest;
  readonly converted: TtsConvertResult;
  readonly provider: string;
  readonly model: string;
}): NarrationAlignmentDocument {
  const timings = deriveWordTimings(input.converted.alignment, { script: input.request.text });
  return {
    schema_version: NARRATION_ALIGNMENT_SCHEMA_VERSION,
    provider: input.provider,
    model: input.model,
    provider_request_id: input.converted.provider_request_id,
    voice: { voice_id: input.request.voice_id, model_id: input.request.model_id },
    text: input.request.text,
    duration_s: input.converted.duration_s,
    alignment: {
      characters: [...input.converted.alignment.characters],
      character_start_times_seconds: [...input.converted.alignment.character_start_times_seconds],
      character_end_times_seconds: [...input.converted.alignment.character_end_times_seconds],
    },
    word_count: timings.words.length,
    coverage: timings.coverage,
    monotonic: timings.monotonic,
  };
}

function asConvertResult(value: unknown): TtsConvertResult {
  const record =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const alignment = record.alignment as CharacterAlignment | undefined;
  const audio = record.audio;
  const duration = record.duration_s;
  const ok =
    audio instanceof Uint8Array &&
    alignment !== undefined &&
    Array.isArray(alignment.characters) &&
    Array.isArray(alignment.character_start_times_seconds) &&
    Array.isArray(alignment.character_end_times_seconds) &&
    typeof duration === 'number' &&
    Number.isFinite(duration);
  if (!ok) {
    throw new Error('the TTS adapter returned a result that is not the §5.4 convert shape');
  }
  const requestId = record.provider_request_id;
  return {
    audio,
    alignment,
    duration_s: duration,
    provider_request_id: typeof requestId === 'string' ? requestId : null,
  };
}

function rightsMetadata(voice: NarrationVoiceConfig, stage: string): Record<string, unknown> {
  return {
    stage,
    voice: {
      voice_id: voice.voice_id,
      model_id: voice.model_id,
      licence_kind: voice.licence_kind,
      licence_note: voice.licence_note ?? null,
    },
  };
}

async function persistTake(
  deps: NarrationStageDeps,
  input: NarrationStageInput,
  request: TtsConvertRequest,
  promptHash: string,
  converted: TtsConvertResult,
  ref: AttemptResultRef,
): Promise<StoredNarration> {
  const document = buildAlignmentDocument({
    request,
    converted,
    provider: deps.tts.provider,
    model: deps.tts.modelId,
  });
  const timings = deriveWordTimings(converted.alignment, { script: request.text });

  const keyCtx = await assetKeyContextFor(deps.pool, input.projectId);
  const audioSha = sha256Hex(converted.audio);
  const audioKey = assetObjectKey({
    seriesSlug: keyCtx.seriesSlug,
    batchOrdinal: keyCtx.batchOrdinal,
    name: NARRATION_OBJECT_NAME,
  });
  const alignmentSha = sha256Hex(jsonBytes(document));
  const alignmentKey = assetObjectKey({
    seriesSlug: keyCtx.seriesSlug,
    batchOrdinal: keyCtx.batchOrdinal,
    name: NARRATION_ALIGNMENT_OBJECT_NAME,
  });

  // Object first, row second: a crash between them leaves an unreferenced
  // object (the §3.4 reconciliation reports it), never a row whose bytes are
  // missing.
  await deps.blobs.put(audioKey, converted.audio, 'audio/wav');
  await deps.blobs.put(alignmentKey, jsonBytes(document), 'application/json');

  return withTransaction(deps.pool, async (client) => {
    const audio: AssetRow = (
      await insertAsset(client, {
        projectId: input.projectId,
        stage: 'NA',
        sceneId: input.sceneId ?? null,
        kind: 'audio',
        contentSha256: audioSha,
        objectKey: audioKey,
        objectSizeBytes: converted.audio.byteLength,
        mimeType: 'audio/wav',
        seriesVersionId: input.seriesVersionId ?? null,
        provider: deps.tts.provider,
        model: deps.tts.modelId,
        providerRequestId: converted.provider_request_id,
        promptHash,
        promptText: request.text,
        rightsMetadata: rightsMetadata(input.voice, 'NA'),
        generationRunId: ref.runId,
      })
    ).row;
    const alignment = await insertAsset(client, {
      projectId: input.projectId,
      stage: 'NA',
      sceneId: input.sceneId ?? null,
      kind: 'sidecar',
      contentSha256: alignmentSha,
      objectKey: alignmentKey,
      objectSizeBytes: jsonBytes(document).byteLength,
      mimeType: 'application/json',
      seriesVersionId: input.seriesVersionId ?? null,
      provider: deps.tts.provider,
      model: deps.tts.modelId,
      providerRequestId: converted.provider_request_id,
      promptHash,
      rightsMetadata: rightsMetadata(input.voice, 'NA'),
      generationRunId: ref.runId,
    });

    await recordPendingRunProviderRequestId(client, ref.runId, converted.provider_request_id);
    // R-026: an identical take from another project reuses this blob and is linked
    // through asset_ref rather than duplicated.
    await linkAssetToProject(client, {
      assetId: audio.id,
      projectId: input.projectId,
      role: 'narration',
    });
    await linkAssetToProject(client, {
      assetId: alignment.row.id,
      projectId: input.projectId,
      role: 'narration_alignment',
    });

    return {
      project_id: input.projectId,
      generation_run_id: ref.runId,
      audio_asset_id: audio.id,
      alignment_asset_id: alignment.row.id,
      content_sha256: audio.content_sha256,
      object_key: audio.object_key,
      duration_s: converted.duration_s,
      provider: deps.tts.provider,
      model: deps.tts.modelId,
      provider_request_id: converted.provider_request_id,
      voice: input.voice,
      prompt_hash: promptHash,
      text: request.text,
      word_count: timings.words.length,
      words: timings.words,
      coverage: timings.coverage,
      monotonic: timings.monotonic,
      series_version_id: input.seriesVersionId ?? null,
      created_at: audio.created_at.toISOString(),
    };
  });
}

/**
 * Run one narration attempt end to end.
 *
 * The stage is moved to `running` before the call; a terminal failure moves it
 * to `failed`, while a retryable failure leaves it `running` because B-08 will
 * pick the job up again. Success stores the take and points the video at TC.
 */
export async function runNarrationStage(
  deps: NarrationStageDeps,
  input: NarrationStageInput,
): Promise<NarrationStageResult> {
  const request = narrationRequest(input);
  if (request.text === '') {
    throw new RangeError('narration stage needs the approved spoken narration (R-005-2)');
  }
  const promptHash = ttsPromptHash(request);

  await beginStage(deps.pool, input.projectId, 'NA', {
    seriesVersionId: input.seriesVersionId ?? null,
  });

  const captured: { narration: StoredNarration | null } = { narration: null };
  const outcome = await runProviderAttempt(
    {
      pool: deps.pool,
      adapter: asProviderAdapter(deps.tts, request),
      onResult: async (result, ref) => {
        captured.narration = await persistTake(
          deps,
          input,
          request,
          promptHash,
          asConvertResult(result),
          ref,
        );
      },
    },
    {
      jobId: input.jobId,
      attemptNo: input.attemptNo,
      projectId: input.projectId,
      stage: 'NA',
      sceneId: input.sceneId ?? null,
      provider: deps.tts.provider,
      model: deps.tts.modelId,
      promptHash,
      seriesVersionId: input.seriesVersionId ?? null,
      workerId: input.workerId ?? null,
    },
  );

  if (outcome.status === 'succeeded') {
    const stored = captured.narration;
    if (stored === null) {
      // The call succeeded but the take was not persisted: structurally a bug,
      // never something to report as a stored narration.
      throw new Error('the narration attempt succeeded without persisting the take');
    }
    await applyStageEvent(deps.pool, input.projectId, 'NA', 'succeed');
    await setProjectCurrentStage(deps.pool, input.projectId, 'TC');
    return { status: 'stored', narration: stored, attempt: outcome };
  }

  const retried = outcome.retry.requeue;
  if (!retried) await applyStageEvent(deps.pool, input.projectId, 'NA', 'fail');

  const failure = outcome.failure;
  return {
    status: 'failed',
    attempt: outcome,
    error_class: failure?.errorClass ?? 'non_retryable',
    message: failure?.message ?? 'narration attempt failed without a classified failure',
    retried,
  };
}

/** Duration of a stored alignment document, as TC measures it (B-07 §5.4). */
export function documentDurationSeconds(document: NarrationAlignmentDocument): number {
  return alignmentDurationSeconds(document.alignment);
}
