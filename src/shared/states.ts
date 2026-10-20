/**
 * Non-stage workflow vocabulary — TECH_DESIGN §4.3–4.6, §3, UX_SPEC §0.2.
 *
 * Every literal that appears both in the database CHECK constraints and in the
 * API contract lives here so the two cannot drift.
 */

/** `project.status` — 5 video-level states (TECH_DESIGN §4.5). */
export const VIDEO_STATES = [
  'NOT_STARTED',
  'RUNNING',
  'NEEDS_ATTENTION',
  'COMPLETE',
  'CANCELLED',
] as const;
export type VideoState = (typeof VIDEO_STATES)[number];

/** `batch.status` — 3 batch states (TECH_DESIGN §4.6). */
export const BATCH_STATES = ['ACTIVE', 'COMPLETE', 'CANCELLED'] as const;
export type BatchState = (typeof BATCH_STATES)[number];

/** `series.status` (R-001-3). */
export const SERIES_STATUSES = ['active', 'archived'] as const;
export type SeriesStatus = (typeof SERIES_STATUSES)[number];

/** `series.mode` (R-027-1). */
export const SERIES_MODES = ['factual', 'creative'] as const;
export type SeriesMode = (typeof SERIES_MODES)[number];

/** The 8 edit kinds — the invalidation matrix keyed as data (TECH_DESIGN §4.3, D12). */
export const EDIT_KINDS = [
  'script_wording',
  'duration',
  'aspect_ratio',
  'image_replace',
  'captions_music',
  'voice_speed',
  'topic_after_research',
  'reorder',
] as const;
export type EditKind = (typeof EDIT_KINDS)[number];

/** Human labels for `edit_kind` (used by the IP-01 invalidation preview). */
export const EDIT_KIND_LABELS: Readonly<Record<EditKind, string>> = {
  script_wording: 'Script wording',
  duration: 'Duration',
  aspect_ratio: 'Aspect ratio',
  image_replace: 'Replace one scene image',
  captions_music: 'Captions / music',
  voice_speed: 'Voice speed',
  topic_after_research: 'Topic (after research)',
  reorder: 'Reorder scenes',
};

/** Attention reasons shown in the batch grid (TECH_DESIGN §4.5, UX IP-05). */
export const ATTENTION_REASONS = [
  'script approval',
  'image review',
  'final approval',
  'failed: T',
  'failed: RS',
  'failed: SC',
  'failed: SB',
  'failed: IM',
  'failed: NA',
  'failed: TC',
  'failed: RE',
  'failed: QC',
  'blocked: unsourced claims',
  'blocked: duplicate topic',
  'waiting: render slot',
  'waiting: rate limit',
  'resumed after restart',
] as const;
export type AttentionReason = (typeof ATTENTION_REASONS)[number];

/** The three external providers (TECH_DESIGN §5). */
export const PROVIDER_NAMES = ['deepseek', 'gemini', 'elevenlabs'] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

/** `generation_run.charge_status` (R-012-4: a timeout that may have billed is `unknown`, never `unbilled`). */
export const CHARGE_STATUSES = ['pending', 'billed', 'unbilled', 'unknown'] as const;
export type ChargeStatus = (typeof CHARGE_STATUSES)[number];

/** `generation_run.status` / `job_attempt.status` overlap (TECH_DESIGN §3). */
export const ATTEMPT_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'timed_out',
  'unknown_charge',
  'cancelled',
] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

/** `error_class` — transient / non_retryable (R-011-2). */
export const ERROR_CLASSES = ['transient', 'non_retryable'] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

/** `review_decision.decision` (TECH_DESIGN §3.1). */
export const REVIEW_DECISIONS = [
  'approve',
  'reject',
  'accept_staleness',
  'acknowledge_unsourced',
] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

/** `review_decision.stage` — the gates plus the staleness ledger. */
export const REVIEW_STAGE_CODES = ['SC', 'SB', 'IM', 'FA', 'STALE'] as const;
export type ReviewStageCode = (typeof REVIEW_STAGE_CODES)[number];

/** `claim.status` (R-027). */
export const CLAIM_STATUSES = [
  'sourced',
  'url_unreachable',
  'unsourced',
  'acknowledged_unsourced',
  'non_factual',
] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

/** `topic.dedupe_status` (R-020). */
export const DEDUPE_STATUSES = ['none', 'rejected', 'overridden'] as const;
export type DedupeStatus = (typeof DEDUPE_STATUSES)[number];

/** Image variants served by `/asset/:id/:variant` (UI: thumb 168×298, detail 360×640, full 1080×1920). */
export const ASSET_VARIANTS = ['thumb', 'detail', 'full'] as const;
export type AssetVariant = (typeof ASSET_VARIANTS)[number];

/** Ken Burns presets (TECH_DESIGN §6.2). */
export const CAMERA_MOVES = ['zoom_in', 'zoom_out', 'pan_l', 'pan_r', 'static'] as const;
export type CameraMove = (typeof CAMERA_MOVES)[number];

/** `asset.stage` — asset provenance buckets (TECH_DESIGN §3.1). */
export const ASSET_STAGES = [
  'IM',
  'NA',
  'RE',
  'QC',
  'EX',
  'MUSIC',
  'POSTER',
  'DERIV',
  'REF',
] as const;
export type AssetStage = (typeof ASSET_STAGES)[number];

/** `script_revision.status`. */
export const SCRIPT_STATUSES = ['draft', 'approved', 'rejected'] as const;
export type ScriptStatus = (typeof SCRIPT_STATUSES)[number];

/** Coarse attention classification for the batch grid (TECH_DESIGN §4.5). */
export const ATTENTION_KINDS = [
  'none',
  'approval',
  'failed',
  'blocked',
  'waiting',
  'resumed',
] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];
