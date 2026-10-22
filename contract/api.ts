/**
 * API contract — LEAD_PLAN §6.
 *
 * This file is the single source of truth that lets the frontend start before
 * the backend lands. Both developers import it:
 *   - the backend validates requests and builds responses with these schemas;
 *   - the frontend renders against `contract/mock/server.ts`, which serves a
 *     fixture for every route below.
 * No endpoint or shape may be invented outside this file (LEAD_PLAN §6).
 *
 * Ownership note: LEAD_PLAN §1 assigns `contract/**` to the tech lead, and
 * LEAD_PLAN §4/B-01 makes this stub B-01's first deliverable. B-01 wrote the
 * first revision; changes after freeze require a plan change.
 */
import { z } from 'zod';

import {
  ASSET_STAGES,
  ASSET_VARIANTS,
  ATTEMPT_STATUSES,
  ATTENTION_KINDS,
  BATCH_STATES,
  CAMERA_MOVES,
  CHARGE_STATUSES,
  CLAIM_STATUSES,
  DEDUPE_STATUSES,
  EDIT_KINDS,
  ERROR_CLASSES,
  PROVIDER_NAMES,
  REVIEW_DECISIONS,
  SCRIPT_STATUSES,
  SERIES_MODES,
  SERIES_STATUSES,
  STAGE_CODES,
  STAGE_STATES,
  VIDEO_STATES,
} from '../src/shared/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Primitives
// ─────────────────────────────────────────────────────────────────────────────

export const UuidSchema = z.uuid();
export const TimestampSchema = z.iso.datetime({ offset: true });
export const RevisionSchema = z.int().min(1);
export const JsonObjectSchema = z.record(z.string(), z.unknown());
export const AspectRatioSchema = z
  .string()
  .regex(/^\d{1,2}:\d{1,2}$/, 'aspect ratio must look like 9:16');
export const SceneNoSchema = z.string().regex(/^S\d{2}$/, 'scene_no is S01…S17');

export const StageCodeSchema = z.enum(STAGE_CODES);
export const StageStateSchema = z.enum(STAGE_STATES);
export const VideoStateSchema = z.enum(VIDEO_STATES);
export const BatchStateSchema = z.enum(BATCH_STATES);
export const SeriesModeSchema = z.enum(SERIES_MODES);
export const SeriesStatusSchema = z.enum(SERIES_STATUSES);
export const EditKindSchema = z.enum(EDIT_KINDS);
export const AttentionKindSchema = z.enum(ATTENTION_KINDS);
export const ProviderNameSchema = z.enum(PROVIDER_NAMES);
export const ChargeStatusSchema = z.enum(CHARGE_STATUSES);
export const AttemptStatusSchema = z.enum(ATTEMPT_STATUSES);
export const ErrorClassSchema = z.enum(ERROR_CLASSES);
export const ClaimStatusSchema = z.enum(CLAIM_STATUSES);
export const DedupeStatusSchema = z.enum(DEDUPE_STATUSES);
export const ScriptStatusSchema = z.enum(SCRIPT_STATUSES);
export const CameraMoveSchema = z.enum(CAMERA_MOVES);
export const AssetVariantSchema = z.enum(ASSET_VARIANTS);
export const AssetStageSchema = z.enum(ASSET_STAGES);
export const ReviewDecisionSchema = z.enum(REVIEW_DECISIONS);

// ─────────────────────────────────────────────────────────────────────────────
// Errors and envelopes
// ─────────────────────────────────────────────────────────────────────────────

export const ERROR_CODES = [
  'unauthorized',
  'not_found',
  'method_not_allowed',
  'validation_failed',
  'conflict',
  'not_ready',
  'rate_limited',
  'internal',
] as const;
export const ErrorCodeSchema = z.enum(ERROR_CODES);

export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    /** Field-level problems for `validation_failed`; keyed by dotted field path. */
    fields: z.record(z.string(), z.string()).optional(),
  }),
});

/** HTTP 409 body — R-024 / IP-09. Never a lost update. */
export const ConflictEnvelopeSchema = z.object({
  error: z.object({
    code: z.literal('conflict'),
    message: z.string(),
  }),
  document: z.enum(['series', 'topic', 'script', 'scene', 'storyboard']),
  current_revision: RevisionSchema,
  your_revision: RevisionSchema,
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth (R-015)
// ─────────────────────────────────────────────────────────────────────────────

export const SessionInfoSchema = z.object({
  authenticated: z.boolean(),
  username: z.string().nullable(),
  /** Synchroniser token for state-changing routes (double-submit cookie). */
  csrf_token: z.string(),
  expires_at: TimestampSchema.nullable(),
});

export const LoginRequestSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

// ─────────────────────────────────────────────────────────────────────────────
// Series and versions (R-001, R-002)
// ─────────────────────────────────────────────────────────────────────────────

export const SeriesProfileSchema = z.object({
  niche: JsonObjectSchema,
  script_style: JsonObjectSchema.nullable(),
  voice_config: JsonObjectSchema.nullable(),
  art_style: JsonObjectSchema.nullable(),
  default_aspect_ratio: AspectRatioSchema,
  target_duration_s: z.int().min(15).max(300),
  /**
   * How many videos one batch produces. Optional so profiles written before this
   * existed stay valid; consumers read `?? 1`.
   */
  videos_per_batch: z.int().min(1).max(30).optional(),
  narration_language: z.string(),
  captions_preset: JsonObjectSchema.nullable(),
  music_config: JsonObjectSchema.nullable(),
  image_resolution: z.enum(['1K', '2K']),
  mode: SeriesModeSchema,
});

export const SeriesProfileInputSchema = SeriesProfileSchema.partial();

export const SeriesSummarySchema = z.object({
  id: UuidSchema,
  name: z.string(),
  slug: z.string(),
  mode: SeriesModeSchema,
  status: SeriesStatusSchema,
  current_version: z.int().min(1),
  current_version_id: UuidSchema,
  target_duration_s: z.int(),
  default_aspect_ratio: AspectRatioSchema,
  revision: RevisionSchema,
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
});

export const SeriesDetailSchema = SeriesSummarySchema.extend({
  profile: SeriesProfileSchema,
  version_count: z.int().min(1),
  /** Batches still ACTIVE — an archived series with in-flight batches is called out (R-001-3). */
  in_flight_batches: z.int().min(0),
});

export const SeriesVersionSummarySchema = z.object({
  id: UuidSchema,
  series_id: UuidSchema,
  version: z.int().min(1),
  mode: SeriesModeSchema,
  target_duration_s: z.int(),
  changed_fields: z.array(z.string()),
  created_at: TimestampSchema,
  created_by: z.string(),
});

export const SeriesVersionDetailSchema = SeriesVersionSummarySchema.extend({
  snapshot: SeriesProfileSchema,
  /** Which projects still pin this version, per stage (R-002-4). */
  pinned_by: z.array(z.object({ project_id: UuidSchema, stages: z.array(StageCodeSchema) })),
});

export const SeriesCreateRequestSchema = z.object({
  name: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  profile: SeriesProfileInputSchema.optional(),
});

/** Editing a series mints a new immutable version; it never mutates a project (R-002-3). */
export const SeriesUpdateRequestSchema = z.object({
  revision: RevisionSchema,
  name: z.string().min(1).optional(),
  profile: SeriesProfileInputSchema.optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Stages, pins, invalidation (R-006, R-002-2/4, C-3)
// ─────────────────────────────────────────────────────────────────────────────

export const StageProgressSchema = z.object({
  current: z.int().min(0),
  total: z.int().min(0),
});

export const StageAttemptStatsSchema = z.object({
  count: z.int().min(0),
  max_attempts: z.int().min(1),
  last_error_class: ErrorClassSchema.nullable(),
});

export const StageViewSchema = z.object({
  stage: StageCodeSchema,
  label: z.string(),
  state: StageStateSchema,
  /** The pin in effect when the stage last started (X-8). */
  series_version_id: UuidSchema.nullable(),
  series_version: z.int().nullable(),
  stale: z.boolean(),
  stale_cause: z.string().nullable(),
  stale_at: TimestampSchema.nullable(),
  last_event: z.string().nullable(),
  last_event_at: TimestampSchema.nullable(),
  progress: StageProgressSchema,
  attempts: StageAttemptStatsSchema,
  /** Named precondition when `state === 'blocked'` (TECH_DESIGN §4.2). */
  blocked_reason: z.string().nullable(),
});

/** Pin summary rendered exactly per RULINGS C-3 (`v13 ×5 · v14 ×3`, bare `v13` when equal). */
export const PinSummarySchema = z.object({
  text: z.string(),
  uniform: z.boolean(),
  versions: z.array(
    z.object({
      version: z.int().min(1),
      count: z.int().min(1),
      stages: z.array(StageCodeSchema),
    }),
  ),
});

export const InvalidationPreviewRequestSchema = z.object({
  revision: RevisionSchema,
  edits: z
    .array(
      z.object({
        edit_kind: EditKindSchema,
        /** The scene an `image_replace` targets. */
        scene_id: UuidSchema.optional(),
        /** Only for `aspect_ratio`; triggers the local reframe check. */
        aspect_ratio: AspectRatioSchema.optional(),
      }),
    )
    .min(1),
  /** Optional dry run of a pending document save that has not been committed yet. */
  script_content: JsonObjectSchema.optional(),
});

export const InvalidationPreviewSchema = z.object({
  revision: RevisionSchema,
  ok: z.boolean(),
  edits: z.array(EditKindSchema),
  invalidated: z.array(
    z.object({
      stage: StageCodeSchema,
      state_after: StageStateSchema,
      quantity: z.int().min(0),
      note: z.string(),
    }),
  ),
  survives: z.array(z.object({ label: z.string(), detail: z.string() })),
  calls: z.object({
    image: z.int().min(0),
    tts: z.int().min(0),
    text: z.int().min(0),
    render_passes: z.int().min(0),
  }),
  conditional: z
    .object({
      check: z.literal('reframe'),
      status: z.enum(['pending', 'reframable', 'not_reframable']),
      image_calls_if_not_reframable: z.int().min(0),
    })
    .nullable(),
  /** Reasons the preview could not be computed — both apply buttons stay disabled (C-07). */
  blockers: z.array(z.string()),
});

// ─────────────────────────────────────────────────────────────────────────────
// Video workspace (R-002, R-005, R-007, R-009, R-010)
// ─────────────────────────────────────────────────────────────────────────────

export const VideoSummarySchema = z.object({
  id: UuidSchema,
  batch_id: UuidSchema.nullable(),
  series_id: UuidSchema,
  series_name: z.string(),
  position_in_batch: z.int().min(0),
  status: VideoStateSchema,
  current_stage: StageCodeSchema,
  stage_state: StageStateSchema,
  attention_kind: AttentionKindSchema,
  attention_reason: z.string().nullable(),
  pins: PinSummarySchema,
  updated_at: TimestampSchema,
});

export const VideoLinksSchema = z.object({
  topic: z.string(),
  script: z.string(),
  storyboard: z.string(),
  scenes: z.string(),
  audio: z.string(),
  render: z.string(),
  export: z.string(),
});

export const VideoDetailSchema = VideoSummarySchema.extend({
  topic_id: UuidSchema.nullable(),
  script_revision: z.int().nullable(),
  scene_count: z.int().min(0),
  target_duration_s: z.int(),
  created_at: TimestampSchema,
  stages: z.array(StageViewSchema),
  links: VideoLinksSchema,
});

export const TopicViewSchema = z.object({
  id: UuidSchema,
  project_id: UuidSchema,
  title: z.string(),
  description: z.string(),
  rationale: z.string().nullable(),
  source_links: z.array(z.object({ url: z.string(), title: z.string().nullable() })),
  dedupe_status: DedupeStatusSchema,
  dedupe_match: z
    .object({ topic_id: UuidSchema, title: z.string(), cosine: z.number().min(0).max(1) })
    .nullable(),
  status: z.enum(['proposed', 'approved', 'rejected']),
  revision: RevisionSchema,
  created_at: TimestampSchema,
});

export const TopicSaveRequestSchema = z.object({
  revision: RevisionSchema,
  title: z.string().min(1),
  description: z.string().min(1),
  rationale: z.string().nullable().optional(),
  source_links: z.array(z.object({ url: z.string(), title: z.string().nullable() })).optional(),
});

export const ClaimViewSchema = z.object({
  id: UuidSchema,
  script_revision_id: UuidSchema,
  text: z.string(),
  is_factual: z.boolean(),
  status: ClaimStatusSchema,
  source: z
    .object({
      id: UuidSchema,
      url: z.string(),
      title: z.string().nullable(),
      domain: z.string(),
      rerank_score: z.number(),
    })
    .nullable(),
  url_status: z.int().nullable(),
  url_reachable_at: TimestampSchema.nullable(),
});

export const ScriptContentSchema = z.object({
  script: z.string(),
  title: z.string(),
  description: z.string(),
  hashtags: z.array(z.string()),
});

export const WordBudgetSchema = z.object({
  target_words: z.int().min(1),
  min_words: z.int().min(1),
  max_words: z.int().min(1),
  within_band: z.boolean(),
});

export const ScriptViewSchema = z.object({
  id: UuidSchema,
  project_id: UuidSchema,
  revision: RevisionSchema,
  schema_version: z.string(),
  status: ScriptStatusSchema,
  content: ScriptContentSchema,
  word_count: z.int().min(0),
  estimated_runtime_s: z.number().min(0),
  budget: WordBudgetSchema,
  eight_gram: z.object({
    pass: z.boolean(),
    violations: z.array(z.string()),
  }),
  claims: z.array(ClaimViewSchema),
  approved_at: TimestampSchema.nullable(),
});

export const ScriptSaveRequestSchema = z.object({
  revision: RevisionSchema,
  content: ScriptContentSchema,
});

export const ApprovalRequestSchema = z.object({
  revision: RevisionSchema,
  note: z.string().max(2000).optional(),
});

/** R-005-4: a reject names its target stage; it fires no downstream call by itself. */
export const RejectRequestSchema = z.object({
  revision: RevisionSchema,
  target_stage: StageCodeSchema,
  reason: z.string().min(1),
});

export const AssetViewSchema = z.object({
  id: UuidSchema,
  stage: AssetStageSchema,
  kind: z.enum(['image', 'audio', 'video', 'caption', 'sidecar', 'zip', 'derivative', 'poster']),
  width: z.int().nullable(),
  height: z.int().nullable(),
  size_bytes: z.int().min(0),
  content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Served by `web` at `/asset/:id/:variant`, proxying a presigned MinIO URL. */
  urls: z.object({
    thumb: z.string(),
    detail: z.string(),
    full: z.string(),
  }),
  provenance: z.object({
    provider: z.string().nullable(),
    model: z.string().nullable(),
    prompt_hash: z.string().nullable(),
    prompt_text: z.string().nullable(),
    seed: z.string().nullable(),
    series_version_id: UuidSchema.nullable(),
    series_version: z.int().nullable(),
    created_at: TimestampSchema,
  }),
});

export const SceneViewSchema = z.object({
  id: UuidSchema,
  scene_no: SceneNoSchema,
  position: z.int().min(1),
  image_prompt: z.string(),
  camera_move: CameraMoveSchema,
  caption_emphasis: z.string().nullable(),
  fallback_text: z.string().nullable(),
  uses_protagonist: z.boolean(),
  narration: z.object({ start_ms: z.int().min(0), end_ms: z.int().min(0) }).nullable(),
  asset: AssetViewSchema.nullable(),
  state: StageStateSchema,
  revision: RevisionSchema,
});

export const StoryboardViewSchema = z.object({
  project_id: UuidSchema,
  revision: RevisionSchema,
  scene_count: z.int().min(0),
  target_scene_count: z.int().min(0),
  approved: z.boolean(),
  approved_at: TimestampSchema.nullable(),
  /** The first-three checkpoint stop (PRD §10) is open until three scenes are reviewed. */
  first_three_reviewed: z.boolean(),
  scenes: z.array(SceneViewSchema),
});

export const WordTimingSchema = z.object({
  word: z.string(),
  start_ms: z.int().min(0),
  end_ms: z.int().min(0),
});

export const NarrationViewSchema = z.object({
  status: StageStateSchema,
  asset: AssetViewSchema.nullable(),
  duration_s: z.number().min(0).nullable(),
  target_duration_s: z.int(),
  band: z.object({ min_s: z.number(), max_s: z.number(), within_band: z.boolean() }),
  word_count: z.int().min(0),
  words: z.array(WordTimingSchema),
  alignment: z
    .object({ provider: z.string(), model: z.string(), request_id: z.string().nullable() })
    .nullable(),
  accepted_at: TimestampSchema.nullable(),
});

export const QCCheckSchema = z.object({
  id: z.string(),
  label: z.string(),
  pass: z.boolean(),
  measured: z.string(),
  expected: z.string(),
  requirement: z.string(),
});

export const RenderViewSchema = z.object({
  status: StageStateSchema,
  video: AssetViewSchema.nullable(),
  poster: AssetViewSchema.nullable(),
  captions: z.object({ srt: AssetViewSchema.nullable(), vtt: AssetViewSchema.nullable() }),
  render_passes: z.int().min(0),
  wall_time_s: z.number().min(0).nullable(),
  peak_ram_mb: z.int().nullable(),
  qc: z.object({
    status: z.enum(['not_run', 'pass', 'fail']),
    checks: z.array(QCCheckSchema),
    checked_at: TimestampSchema.nullable(),
  }),
  approved: z.boolean(),
  approved_at: TimestampSchema.nullable(),
});

export const ExportFileSchema = z.object({
  name: z.string(),
  kind: z.enum(['video', 'srt', 'vtt', 'sidecar', 'manifest', 'poster']),
  size_bytes: z.int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  url: z.string(),
});

export const ExportViewSchema = z.object({
  status: StageStateSchema,
  package_built_at: TimestampSchema.nullable(),
  files: z.array(ExportFileSchema),
  total_bytes: z.int().min(0),
  /** Per-stage pins at export time (R-002-4, R-013-1). */
  pins: z.array(
    z.object({
      stage: StageCodeSchema,
      series_version: z.int().nullable(),
      series_version_id: UuidSchema.nullable(),
    }),
  ),
  manifest: JsonObjectSchema.nullable(),
});

export const AttemptRowSchema = z.object({
  id: UuidSchema,
  stage: StageCodeSchema,
  provider: z.string(),
  model: z.string(),
  provider_request_id: z.string().nullable(),
  prompt_hash: z.string(),
  /** R-012-2: every current provider reports no honoured idempotency key. */
  idempotency_protected: z.boolean(),
  charge_status: ChargeStatusSchema,
  status: AttemptStatusSchema,
  error_class: ErrorClassSchema.nullable(),
  http_status: z.int().nullable(),
  attempt_no: z.int().min(1),
  max_attempts: z.int().min(1),
  backoff_s: z.int().nullable(),
  created_at: TimestampSchema,
  started_at: TimestampSchema.nullable(),
  ended_at: TimestampSchema.nullable(),
});

export const AttemptsQuerySchema = z.object({
  stage: StageCodeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
});

export const RetryScopeSchema = z.object({
  stage: StageCodeSchema,
  will_run: z.array(
    z.object({
      stage: StageCodeSchema,
      calls: z.object({
        image: z.int().min(0),
        tts: z.int().min(0),
        text: z.int().min(0),
        render_passes: z.int().min(0),
      }),
      detail: z.string(),
    }),
  ),
  will_not_run: z.array(z.object({ label: z.string(), detail: z.string() })),
  /** A pending/running attempt was found: it may have been billed (R-012-4). */
  unknown_charge: z.boolean(),
  idempotency_protected: z.boolean(),
  blockers: z.array(z.string()),
});

export const QueueResponseSchema = z.object({
  queued: z.boolean(),
  stage: StageCodeSchema,
  scope: RetryScopeSchema,
  enqueued_at: TimestampSchema,
});

// ─────────────────────────────────────────────────────────────────────────────
// Overview, health, settings (R-018, R-022-1, R-008-3, R-015-5)
// ─────────────────────────────────────────────────────────────────────────────

export const BatchSummarySchema = z.object({
  id: UuidSchema,
  series_id: UuidSchema,
  series_name: z.string(),
  status: BatchStateSchema,
  target_count: z.int().min(1).max(30),
  completed_count: z.int().min(0),
  needs_attention_count: z.int().min(0),
  failed_count: z.int().min(0),
  created_at: TimestampSchema,
});

export const AttentionItemSchema = z.object({
  video_id: UuidSchema,
  series_name: z.string(),
  video_label: z.string(),
  batch_id: UuidSchema.nullable(),
  batch_position: z.int().nullable(),
  status: VideoStateSchema,
  current_stage: StageCodeSchema,
  stage_state: StageStateSchema,
  attention_kind: AttentionKindSchema,
  attention_reason: z.string().nullable(),
  updated_at: TimestampSchema,
});

export const OverviewSchema = z.object({
  attention: z.array(AttentionItemSchema),
  batches: z.array(BatchSummarySchema),
  counts: z.object({
    needs_attention: z.int().min(0),
    running: z.int().min(0),
    complete: z.int().min(0),
  }),
  degraded: z.array(z.string()),
});

export const HealthComponentSchema = z.object({
  name: z.enum(['postgres', 'redis', 'minio', 'migration', 'queue', 'disk']),
  status: z.enum(['ok', 'degraded', 'down', 'unknown']),
  detail: z.string(),
});

export const ProviderHealthSchema = z.object({
  provider: ProviderNameSchema,
  /** Presence only. A key value is never read back (R-015-5). */
  key_present: z.boolean(),
  qualified: z.boolean(),
  qualified_at: TimestampSchema.nullable(),
  idempotency_protected: z.boolean(),
  note: z.string().nullable(),
});

export const HealthReportSchema = z.object({
  ready: z.boolean(),
  service: z.enum(['web', 'worker', 'ops', 'migrate']),
  checked_at: TimestampSchema,
  migration: z.object({
    status: z.enum(['up_to_date', 'pending', 'failed', 'unknown']),
    version: z.string().nullable(),
  }),
  components: z.array(HealthComponentSchema),
  providers: z.array(ProviderHealthSchema),
  queue: z
    .object({ waiting: z.int().min(0), active: z.int().min(0), failed: z.int().min(0) })
    .nullable(),
  disk: z
    .object({
      free_bytes: z.int().min(0),
      total_bytes: z.int().min(0),
      headroom_ok: z.boolean(),
    })
    .nullable(),
  degraded_reasons: z.array(z.string()),
});

/** `/readyz` — the readiness probe only needs the verdict (R-018-1/2). */
export const ReadinessSchema = z.object({
  ready: z.boolean(),
  degraded_reasons: z.array(z.string()),
});

export const ProviderSettingsViewSchema = z.object({
  read_only: z.literal(true),
  /** No key values, ever: presence and qualification only (R-015-5, UX DI-08). */
  key_values_exposed: z.literal(false),
  providers: z.array(ProviderHealthSchema),
});

// ─────────────────────────────────────────────────────────────────────────────
// SSE feed (UX: ≤2 s freshness, Redis pub/sub fan-out)
// ─────────────────────────────────────────────────────────────────────────────

export const SseEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('stage.updated'),
    video_id: UuidSchema,
    stage: StageCodeSchema,
    state: StageStateSchema,
    stale: z.boolean(),
    occurred_at: TimestampSchema,
  }),
  z.object({
    type: z.literal('video.updated'),
    video_id: UuidSchema,
    status: VideoStateSchema,
    current_stage: StageCodeSchema,
    attention_kind: AttentionKindSchema,
    attention_reason: z.string().nullable(),
    occurred_at: TimestampSchema,
  }),
  z.object({
    type: z.literal('batch.progress'),
    batch_id: UuidSchema,
    completed_count: z.int().min(0),
    target_count: z.int().min(1),
    status: BatchStateSchema,
    occurred_at: TimestampSchema,
  }),
  z.object({
    type: z.literal('health.changed'),
    ready: z.boolean(),
    degraded_reasons: z.array(z.string()),
    occurred_at: TimestampSchema,
  }),
  z.object({ type: z.literal('ping'), occurred_at: TimestampSchema }),
]);

// ─────────────────────────────────────────────────────────────────────────────
// Route table — the frozen endpoint list for Milestone A
// ─────────────────────────────────────────────────────────────────────────────

export interface RouteDef {
  readonly id: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  /** Session required (R-015-4: everything except `/login`). */
  readonly auth: boolean;
  readonly summary: string;
  readonly request?: z.ZodType;
  readonly response: z.ZodType;
  readonly status?: number;
  readonly contentType?: 'application/json' | 'text/event-stream';
  /** Milestone the endpoint belongs to; A endpoints must all exist in A. */
  readonly milestone: 'A' | 'B';
}

export const ROUTES = [
  // ── probes: no session, used by compose healthchecks ──
  {
    id: 'health.live',
    method: 'GET',
    path: '/healthz',
    auth: false,
    summary: 'Liveness probe',
    response: z.object({ status: z.literal('ok') }),
    milestone: 'A',
  },
  {
    id: 'health.ready',
    method: 'GET',
    path: '/readyz',
    auth: false,
    summary: 'Readiness probe (503 while a dependency is down — R-018)',
    response: ReadinessSchema,
    milestone: 'A',
  },

  // ── auth ──
  {
    id: 'auth.session',
    method: 'GET',
    path: '/api/session',
    auth: false,
    summary: 'Current session, or authenticated=false',
    response: SessionInfoSchema,
    milestone: 'A',
  },
  {
    id: 'auth.login',
    method: 'POST',
    path: '/api/login',
    auth: false,
    summary: 'Log in the single seeded operator (sets an httpOnly cookie)',
    request: LoginRequestSchema,
    response: SessionInfoSchema,
    milestone: 'A',
  },
  {
    id: 'auth.logout',
    method: 'POST',
    path: '/api/logout',
    auth: true,
    summary: 'Destroy the session',
    response: z.object({ ok: z.literal(true) }),
    milestone: 'A',
  },

  // ── overview ──
  {
    id: 'overview.get',
    method: 'GET',
    path: '/api/overview',
    auth: true,
    summary: 'Attention queue, batch progress and degraded banner for S-02',
    response: OverviewSchema,
    milestone: 'A',
  },

  // ── series ──
  {
    id: 'series.list',
    method: 'GET',
    path: '/api/series',
    auth: true,
    summary: 'List series (S-03)',
    response: z.object({ series: z.array(SeriesSummarySchema) }),
    milestone: 'A',
  },
  {
    id: 'series.create',
    method: 'POST',
    path: '/api/series',
    auth: true,
    summary: 'Create a series and mint version 1',
    request: SeriesCreateRequestSchema,
    response: SeriesDetailSchema,
    status: 201,
    milestone: 'A',
  },
  {
    id: 'series.get',
    method: 'GET',
    path: '/api/series/:seriesId',
    auth: true,
    summary: 'Series detail (S-04)',
    response: SeriesDetailSchema,
    milestone: 'A',
  },
  {
    id: 'series.update',
    method: 'PATCH',
    path: '/api/series/:seriesId',
    auth: true,
    summary:
      'Edit the profile; commits a new immutable version (R-002-3); 409 on revision conflict',
    request: SeriesUpdateRequestSchema,
    response: SeriesDetailSchema,
    milestone: 'A',
  },
  {
    id: 'series.versions.list',
    method: 'GET',
    path: '/api/series/:seriesId/versions',
    auth: true,
    summary: 'Version history (S-05)',
    response: z.object({ versions: z.array(SeriesVersionSummarySchema) }),
    milestone: 'A',
  },
  {
    id: 'series.versions.get',
    method: 'GET',
    path: '/api/series/:seriesId/versions/:versionId',
    auth: true,
    summary: 'Immutable version snapshot + which projects pin it (S-06)',
    response: SeriesVersionDetailSchema,
    milestone: 'A',
  },
  {
    id: 'series.versions.mint',
    method: 'POST',
    path: '/api/series/:seriesId/versions',
    auth: true,
    summary: 'Mint a version explicitly (profile edits are not invalidations — IP-02)',
    request: SeriesUpdateRequestSchema,
    response: SeriesVersionDetailSchema,
    status: 201,
    milestone: 'A',
  },

  // ── video creation and workspace ──
  {
    id: 'video.create',
    method: 'POST',
    path: '/api/series/:seriesId/videos',
    auth: true,
    summary:
      'Milestone A single-video slice: one project from the series current version (batch create is B, US-032)',
    request: z.object({ target_duration_s: z.int().min(15).max(300).optional() }),
    response: VideoDetailSchema,
    status: 201,
    milestone: 'A',
  },
  {
    id: 'video.get',
    method: 'GET',
    path: '/api/videos/:videoId',
    auth: true,
    summary: 'Video workspace shell: status, all 11 stages, pins (S-09…S-16 shell)',
    response: VideoDetailSchema,
    milestone: 'A',
  },
  {
    id: 'video.invalidation_preview',
    method: 'POST',
    path: '/api/videos/:videoId/invalidation-preview',
    auth: true,
    summary: 'IP-01 preview: stale set, surviving work and call counts — no provider call',
    request: InvalidationPreviewRequestSchema,
    response: InvalidationPreviewSchema,
    milestone: 'A',
  },

  // ── topic (manual topic in A) ──
  {
    id: 'topic.get',
    method: 'GET',
    path: '/api/videos/:videoId/topic',
    auth: true,
    summary: 'Topic for S-09 (manual topic in Milestone A)',
    response: TopicViewSchema,
    milestone: 'A',
  },
  {
    id: 'topic.save',
    method: 'PUT',
    path: '/api/videos/:videoId/topic',
    auth: true,
    summary: 'Save the manually supplied topic; 409 on revision conflict',
    request: TopicSaveRequestSchema,
    response: TopicViewSchema,
    milestone: 'A',
  },
  {
    id: 'topic.approve',
    method: 'POST',
    path: '/api/videos/:videoId/topic/approve',
    auth: true,
    summary: 'Approve the topic (unlocks script generation)',
    request: ApprovalRequestSchema,
    response: TopicViewSchema,
    milestone: 'A',
  },

  // ── script ──
  {
    id: 'script.get',
    method: 'GET',
    path: '/api/videos/:videoId/script',
    auth: true,
    summary: 'Latest script revision, word budget, 8-gram scan and claims (S-10)',
    response: ScriptViewSchema,
    milestone: 'A',
  },
  {
    id: 'script.save',
    method: 'PUT',
    path: '/api/videos/:videoId/script',
    auth: true,
    summary: 'Save a script revision (optimistic lock; 409 on conflict — R-024)',
    request: ScriptSaveRequestSchema,
    response: ScriptViewSchema,
    milestone: 'A',
  },
  {
    id: 'script.approve',
    method: 'POST',
    path: '/api/videos/:videoId/script/approve',
    auth: true,
    summary: 'Approve the script — the mandatory gate before any billable IM/NA call (R-005-2)',
    request: ApprovalRequestSchema,
    response: ScriptViewSchema,
    milestone: 'A',
  },
  {
    id: 'script.reject',
    method: 'POST',
    path: '/api/videos/:videoId/script/reject',
    auth: true,
    summary: 'Reject with a named target stage; fires no downstream call (R-005-4)',
    request: RejectRequestSchema,
    response: ScriptViewSchema,
    milestone: 'A',
  },

  // ── storyboard and scenes ──
  {
    id: 'storyboard.get',
    method: 'GET',
    path: '/api/videos/:videoId/storyboard',
    auth: true,
    summary: 'Scene split, prompts, protagonist use (S-11)',
    response: StoryboardViewSchema,
    milestone: 'A',
  },
  {
    id: 'storyboard.approve',
    method: 'POST',
    path: '/api/videos/:videoId/storyboard/approve',
    auth: true,
    summary: 'Optional storyboard gate',
    request: ApprovalRequestSchema,
    response: StoryboardViewSchema,
    milestone: 'A',
  },
  {
    id: 'scenes.list',
    method: 'GET',
    path: '/api/videos/:videoId/scenes',
    auth: true,
    summary: 'Scene grid with per-scene image state (S-12)',
    response: z.object({ scenes: z.array(SceneViewSchema) }),
    milestone: 'A',
  },
  {
    id: 'scenes.get',
    method: 'GET',
    path: '/api/videos/:videoId/scenes/:sceneId',
    auth: true,
    summary: 'Scene detail with asset provenance (S-13)',
    response: SceneViewSchema,
    milestone: 'A',
  },
  {
    id: 'scenes.replace_image',
    method: 'POST',
    path: '/api/videos/:videoId/scenes/:sceneId/replace-image',
    auth: true,
    summary: 'Replace one scene image — exactly 1 image call (RULINGS L-2, US-020)',
    request: z.object({ revision: RevisionSchema, image_prompt: z.string().min(1).optional() }),
    response: QueueResponseSchema,
    milestone: 'A',
  },

  // ── narration / timing ──
  {
    id: 'audio.get',
    method: 'GET',
    path: '/api/videos/:videoId/audio',
    auth: true,
    summary: 'Narration asset, derived word timings, ±5 % duration band (S-14)',
    response: NarrationViewSchema,
    milestone: 'A',
  },
  {
    id: 'audio.rerun',
    method: 'POST',
    path: '/api/videos/:videoId/audio/rerun',
    auth: true,
    summary: 'Re-run narration — 1 TTS call, previewed (R-009-3)',
    request: z.object({ reason: z.string().max(500).optional() }),
    response: QueueResponseSchema,
    milestone: 'A',
  },
  {
    id: 'audio.accept',
    method: 'POST',
    path: '/api/videos/:videoId/audio/accept',
    auth: true,
    summary: 'Accept the derived timing',
    request: z.object({ alignment_id: UuidSchema }),
    response: NarrationViewSchema,
    milestone: 'A',
  },

  // ── render / QC / final approval ──
  {
    id: 'render.get',
    method: 'GET',
    path: '/api/videos/:videoId/render',
    auth: true,
    summary: 'Render output, QC checks with numbers, approval state (S-15)',
    response: RenderViewSchema,
    milestone: 'A',
  },
  {
    id: 'render.approve',
    method: 'POST',
    path: '/api/videos/:videoId/render/approve',
    auth: true,
    summary: 'Final approval — the mandatory gate before export (R-005-3)',
    request: ApprovalRequestSchema,
    response: RenderViewSchema,
    milestone: 'A',
  },

  // ── export ──
  {
    id: 'export.get',
    method: 'GET',
    path: '/api/videos/:videoId/export',
    auth: true,
    summary: 'Package contents and per-stage pins (S-16)',
    response: ExportViewSchema,
    milestone: 'A',
  },
  {
    id: 'export.build',
    method: 'POST',
    path: '/api/videos/:videoId/export',
    auth: true,
    summary: 'Build the per-video package (MP4, .srt, .vtt, sidecar, manifest) — R-014-1',
    response: ExportViewSchema,
    status: 201,
    milestone: 'A',
  },

  // ── failures, attempts, retry ──
  {
    id: 'attempts.list',
    method: 'GET',
    path: '/api/videos/:videoId/attempts',
    auth: true,
    summary: 'Attempt rows, newest first, last 50 (S-19)',
    response: z.object({ attempts: z.array(AttemptRowSchema) }),
    milestone: 'A',
  },
  {
    id: 'retry.scope',
    method: 'GET',
    path: '/api/videos/:videoId/retry-scope',
    auth: true,
    summary: 'IP-06: what a retry would re-run and what stays stored (R-022-2)',
    response: RetryScopeSchema,
    milestone: 'A',
  },
  {
    id: 'retry.run',
    method: 'POST',
    path: '/api/videos/:videoId/stages/:stage/retry',
    auth: true,
    summary: 'Retry a failed/stale stage with its computed scope',
    request: z.object({ confirm_scope: z.literal(true) }),
    response: QueueResponseSchema,
    milestone: 'A',
  },

  // ── health and settings ──
  {
    id: 'health.report',
    method: 'GET',
    path: '/api/health',
    auth: true,
    summary: 'Provider/queue/disk/migration health for S-19',
    response: HealthReportSchema,
    milestone: 'A',
  },
  {
    id: 'settings.providers',
    method: 'GET',
    path: '/api/settings/providers',
    auth: true,
    summary: 'Key presence and qualification only — values are never read back (R-015-5)',
    response: ProviderSettingsViewSchema,
    milestone: 'A',
  },

  // ── SSE ──
  {
    id: 'events.stream',
    method: 'GET',
    path: '/api/events',
    auth: true,
    summary: 'SSE progress feed (Redis pub/sub fan-out)',
    response: SseEventSchema,
    contentType: 'text/event-stream',
    milestone: 'A',
  },
] as const satisfies readonly RouteDef[];

export type Route = (typeof ROUTES)[number];
export type RouteId = Route['id'];

/** The frozen list of JSON endpoints (everything except the SSE stream). */
export const JSON_ROUTES: readonly RouteDef[] = ROUTES.filter(
  (route: RouteDef) => route.contentType !== 'text/event-stream',
);
