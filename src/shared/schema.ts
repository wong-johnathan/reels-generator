/**
 * Shared zod primitives and literal schemas.
 *
 * `contract/api.ts` composes these so that the API contract, the backend
 * validators and the fixtures cannot disagree about a literal set.
 */
import { z } from 'zod';

import { EDIT_KINDS } from './states.js';
import { STAGE_CODES, STAGE_STATES, type StageCode, type StageState } from './stages.js';
import {
  ASSET_STAGES,
  ASSET_VARIANTS,
  ATTEMPT_STATUSES,
  ATTENTION_KINDS,
  ATTENTION_REASONS,
  BATCH_STATES,
  CAMERA_MOVES,
  CHARGE_STATUSES,
  CLAIM_STATUSES,
  DEDUPE_STATUSES,
  ERROR_CLASSES,
  PROVIDER_NAMES,
  REVIEW_DECISIONS,
  REVIEW_STAGE_CODES,
  SCRIPT_STATUSES,
  SERIES_MODES,
  SERIES_STATUSES,
  VIDEO_STATES,
} from './states.js';

/** A server-generated primary key (uuid v4 in practice). */
export const UuidSchema = z.uuid();
/** ISO-8601 UTC timestamp with an explicit offset, as Postgres `timestamptz` serialises. */
export const TimestampSchema = z.iso.datetime({ offset: true });
/** Optimistic-lock token (R-024): a monotonically increasing document revision. */
export const RevisionSchema = z.int().min(1);

export const StageCodeSchema = z.enum(STAGE_CODES);
export const StageStateSchema = z.enum(STAGE_STATES);
export const EditKindSchema = z.enum(EDIT_KINDS);
export const VideoStateSchema = z.enum(VIDEO_STATES);
export const BatchStateSchema = z.enum(BATCH_STATES);
export const SeriesStatusSchema = z.enum(SERIES_STATUSES);
export const SeriesModeSchema = z.enum(SERIES_MODES);
export const AttentionKindSchema = z.enum(ATTENTION_KINDS);
export const AttentionReasonSchema = z.enum(ATTENTION_REASONS);
export const ProviderNameSchema = z.enum(PROVIDER_NAMES);
export const ChargeStatusSchema = z.enum(CHARGE_STATUSES);
export const AttemptStatusSchema = z.enum(ATTEMPT_STATUSES);
export const ErrorClassSchema = z.enum(ERROR_CLASSES);
export const ReviewDecisionSchema = z.enum(REVIEW_DECISIONS);
export const ReviewStageSchema = z.enum(REVIEW_STAGE_CODES);
export const ClaimStatusSchema = z.enum(CLAIM_STATUSES);
export const DedupeStatusSchema = z.enum(DEDUPE_STATUSES);
export const AssetVariantSchema = z.enum(ASSET_VARIANTS);
export const AssetStageSchema = z.enum(ASSET_STAGES);
export const CameraMoveSchema = z.enum(CAMERA_MOVES);
export const ScriptStatusSchema = z.enum(SCRIPT_STATUSES);

/** Narrow a StageCode/StageState without a schema instance (hot paths). */
export type { StageCode, StageState };
