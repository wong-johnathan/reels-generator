/**
 * Series profiles and immutable versioning — R-001-4, R-002-1…4, R-009-1.
 *
 * The version model (PRD §5, TECH_DESIGN §3.1, RULINGS B3/D1):
 *   - creating a series mints version 1;
 *   - every edit mints a new version with a strictly increasing integer, and
 *     never rewrites an earlier one (M-006 makes that structural);
 *   - `series.current_version_id` always points at the highest version;
 *   - a not-yet-executed stage adopts the newest version *when it starts*
 *     (`seriesVersionForStageStart` + `pinStageAtStart`), while every row that
 *     already recorded a pin — `video_stage.series_version_id`, and later
 *     `asset.series_version_id` — keeps it (R-002-3).
 *
 * This module never touches `project`, `video_stage.state` or `asset`: an edit
 * only reads them, so editing a series cannot mutate an existing project
 * (R-001-4). Stage state stays `src/domain/state-machine.ts`'s business; the
 * only `video_stage` column written here is the per-stage pin.
 *
 * Target duration is per series and overridable per video (R-009-1): 10–180 s,
 * default 75 s, recommended ceiling 90 s. The hard bounds are enforced here and
 * by the two DB CHECKs; 90 s is a UI hint, not a validation bound.
 */
import type { Pool } from 'pg';
import { z } from 'zod';

import {
  SeriesDetailSchema,
  SeriesProfileSchema,
  SeriesSummarySchema,
  SeriesVersionDetailSchema,
  SeriesVersionSummarySchema,
} from '../../contract/api.js';
import { withTransaction, type Queryable } from '../db/client.js';
import { STAGE_CODES, type StageCode } from '../shared/stages.js';

// ─────────────────────────────────────────────────────────────────────────────
// Target duration (R-009-1 / US-023)
// ─────────────────────────────────────────────────────────────────────────────

/** Hard floor: PRD R-009-1 "range 10–180 s". */
export const MIN_TARGET_DURATION_S = 10;
/** Hard cap: PRD R-009-1 / D10 "180 s hard cap". */
export const MAX_TARGET_DURATION_S = 180;
/** Default target: PRD R-009-1 "default target 75 s" (also M-001's column default). */
export const DEFAULT_TARGET_DURATION_S = 75;
/** Recommended ceiling (D10) — a UI hint, never a validation bound. */
export const RECOMMENDED_MAX_TARGET_DURATION_S = 90;

/** The optimistically-locked integer every series edit must present (R-024). */
export type TargetDuration = number;

export class TargetDurationError extends Error {
  constructor(readonly value: unknown) {
    super(
      `target_duration_s must be an integer between ${MIN_TARGET_DURATION_S} and ` +
        `${MAX_TARGET_DURATION_S} seconds (R-009-1), got ${String(value)}`,
    );
    this.name = 'TargetDurationError';
  }
}

/** Validate one duration value; returns it so call sites can chain. */
export function assertTargetDuration(value: number): TargetDuration {
  if (!Number.isInteger(value) || value < MIN_TARGET_DURATION_S || value > MAX_TARGET_DURATION_S) {
    throw new TargetDurationError(value);
  }
  return value;
}

/**
 * The target a video actually renders to: the per-video override when set,
 * otherwise the series value (R-009-1 "per-series, editable per-video").
 */
export function effectiveTargetDuration(
  seriesTargetS: number,
  projectTargetS: number | null,
): TargetDuration {
  assertTargetDuration(seriesTargetS);
  return projectTargetS === null ? seriesTargetS : assertTargetDuration(projectTargetS);
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The frozen contract keeps `target_duration_s` at 15–300 in
 * `SeriesProfileSchema`; PRD R-009-1 and this task say 10–180. The PRD wins for
 * validation (see evidence/t_972d5a76.md, contradiction C-B14-1: the contract
 * needs a tech-lead revision). Responses are therefore validated against the
 * contract schema with that one bound corrected — never loosened elsewhere.
 */
export const SeriesProfileResponseSchema = SeriesProfileSchema.extend({
  target_duration_s: z.int().min(MIN_TARGET_DURATION_S).max(MAX_TARGET_DURATION_S),
});

export const SeriesSummaryResponseSchema = SeriesSummarySchema.extend({
  target_duration_s: z.int().min(MIN_TARGET_DURATION_S).max(MAX_TARGET_DURATION_S),
});

export const SeriesDetailResponseSchema = SeriesDetailSchema.extend({
  target_duration_s: z.int().min(MIN_TARGET_DURATION_S).max(MAX_TARGET_DURATION_S),
  profile: SeriesProfileResponseSchema,
});

export const SeriesVersionSummaryResponseSchema = SeriesVersionSummarySchema.extend({
  target_duration_s: z.int().min(MIN_TARGET_DURATION_S).max(MAX_TARGET_DURATION_S),
});

export const SeriesVersionDetailResponseSchema = SeriesVersionDetailSchema.extend({
  target_duration_s: z.int().min(MIN_TARGET_DURATION_S).max(MAX_TARGET_DURATION_S),
  snapshot: SeriesProfileResponseSchema,
});

export type SeriesProfile = z.infer<typeof SeriesProfileResponseSchema>;
export type SeriesMode = SeriesProfile['mode'];
export type SeriesProfilePatch = Partial<SeriesProfile>;
export type SeriesSummary = z.infer<typeof SeriesSummaryResponseSchema>;
export type SeriesDetail = z.infer<typeof SeriesDetailResponseSchema>;
export type SeriesVersionSummary = z.infer<typeof SeriesVersionSummaryResponseSchema>;
export type SeriesVersionDetail = z.infer<typeof SeriesVersionDetailResponseSchema>;

/** Every profile field, in the contract's order. */
export const PROFILE_KEYS = [
  'niche',
  'script_style',
  'voice_config',
  'art_style',
  'default_aspect_ratio',
  'target_duration_s',
  'narration_language',
  'captions_preset',
  'music_config',
  'image_resolution',
  'mode',
] as const satisfies readonly (keyof SeriesProfile)[];

/**
 * What a new series starts from before the operator's input is applied.
 * `mode` is required by the schema; Milestone A runs the creative channel, so
 * that is the default (PRD §2, BACKLOG §4).
 */
export function defaultProfile(input: SeriesProfilePatch = {}): SeriesProfile {
  const base = SeriesProfileResponseSchema.parse({
    niche: {},
    script_style: null,
    voice_config: null,
    art_style: null,
    default_aspect_ratio: '9:16',
    target_duration_s: DEFAULT_TARGET_DURATION_S,
    narration_language: 'en',
    captions_preset: null,
    music_config: null,
    image_resolution: '1K',
    mode: 'creative',
  });
  return mergeProfile(base, input);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Apply a partial profile to a full one.
 *
 * Top-level fields replace; the JSON-object fields merge one level, so a patch
 * of `{ voice_config: { speed: 0.92 } }` keeps the configured `voice_id`
 * instead of silently clearing it. An explicit `null` still clears a nullable
 * field — that is how "no music" is expressed (Q2 default).
 */
function mergeNullableObject(
  current: Record<string, unknown> | null,
  patch: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (patch === null) return null;
  return { ...(current ?? {}), ...patch };
}

export function mergeProfile(current: SeriesProfile, patch: SeriesProfilePatch): SeriesProfile {
  const merged: SeriesProfile = { ...current };

  if (patch.niche !== undefined) merged.niche = { ...current.niche, ...patch.niche };
  if (patch.script_style !== undefined) {
    merged.script_style = mergeNullableObject(current.script_style, patch.script_style);
  }
  if (patch.voice_config !== undefined) {
    merged.voice_config = mergeNullableObject(current.voice_config, patch.voice_config);
  }
  if (patch.art_style !== undefined) {
    merged.art_style = mergeNullableObject(current.art_style, patch.art_style);
  }
  if (patch.captions_preset !== undefined) {
    merged.captions_preset = mergeNullableObject(current.captions_preset, patch.captions_preset);
  }
  if (patch.music_config !== undefined) {
    merged.music_config = mergeNullableObject(current.music_config, patch.music_config);
  }
  if (patch.default_aspect_ratio !== undefined) {
    merged.default_aspect_ratio = patch.default_aspect_ratio;
  }
  if (patch.target_duration_s !== undefined) {
    merged.target_duration_s = assertTargetDuration(patch.target_duration_s);
  }
  if (patch.narration_language !== undefined) {
    merged.narration_language = patch.narration_language;
  }
  if (patch.image_resolution !== undefined) merged.image_resolution = patch.image_resolution;
  if (patch.mode !== undefined) merged.mode = patch.mode;

  return SeriesProfileResponseSchema.parse(merged);
}

/**
 * Dotted paths of the fields that differ between two snapshots, e.g.
 * `voice_config.speed` or `target_duration_s`. The version history's
 * `changed_fields` is derived from this, not stored (M-006 keeps the snapshot
 * table append-only).
 */
export function changedProfileFields(before: SeriesProfile | null, after: SeriesProfile): string[] {
  if (before === null) return [];
  const changed: string[] = [];

  for (const key of PROFILE_KEYS) {
    const previous = before[key];
    const next = after[key];
    if (isPlainObject(previous) && isPlainObject(next)) {
      const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
      for (const nested of [...keys].sort()) {
        if (JSON.stringify(previous[nested]) !== JSON.stringify(next[nested])) {
          changed.push(`${key}.${nested}`);
        }
      }
      continue;
    }
    if (JSON.stringify(previous) !== JSON.stringify(next)) changed.push(key);
  }

  return changed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors (mapped to the contract's error envelope by src/api/series-routes.ts)
// ─────────────────────────────────────────────────────────────────────────────

export class SeriesNotFoundError extends Error {
  constructor(readonly seriesId: string) {
    super(`series ${seriesId} does not exist`);
    this.name = 'SeriesNotFoundError';
  }
}

export class SeriesVersionNotFoundError extends Error {
  constructor(
    readonly seriesId: string,
    readonly versionId: string,
  ) {
    super(`series ${seriesId} has no version ${versionId}`);
    this.name = 'SeriesVersionNotFoundError';
  }
}

export class ProjectNotFoundError extends Error {
  constructor(readonly projectId: string) {
    super(`project ${projectId} does not exist`);
    this.name = 'ProjectNotFoundError';
  }
}

export class StageNotFoundError extends Error {
  constructor(
    readonly projectId: string,
    readonly stage: string,
  ) {
    super(`project ${projectId} has no ${stage} stage row`);
    this.name = 'StageNotFoundError';
  }
}

/** R-024: the caller edited a stale document. Never a lost update. */
export class RevisionConflictError extends Error {
  constructor(
    readonly currentRevision: number,
    readonly yourRevision: number,
  ) {
    super(`series revision ${yourRevision} is stale; the current revision is ${currentRevision}`);
    this.name = 'RevisionConflictError';
  }
}

/** A PATCH that changes nothing is refused rather than minting a no-op version. */
export class SeriesNoChangeError extends Error {
  constructor(readonly seriesId: string) {
    super('the profile edit does not change any field; nothing was minted');
    this.name = 'SeriesNoChangeError';
  }
}

export class DuplicateSlugError extends Error {
  constructor(readonly slug: string) {
    super(`a series with slug "${slug}" already exists`);
    this.name = 'DuplicateSlugError';
  }
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === '23505' && candidate.constraint === constraint;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rows
// ─────────────────────────────────────────────────────────────────────────────

interface SeriesRow {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: string;
  readonly revision: number;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly current_version_id: string | null;
  readonly current_version: number;
  readonly snapshot: unknown;
}

interface SeriesListRow extends SeriesRow {
  readonly version_count: number;
  readonly in_flight_batches: number;
}

interface VersionRow {
  readonly id: string;
  readonly series_id: string;
  readonly version: number;
  readonly mode: string;
  readonly target_duration_s: number;
  readonly snapshot: unknown;
  readonly previous_snapshot: unknown;
  readonly created_at: Date;
  readonly created_by: string;
}

interface PinRow {
  readonly project_id: string;
  readonly stage: string;
}

const STAGE_INDEX = new Map<string, number>(STAGE_CODES.map((code, index) => [code, index]));

function byStageOrder(left: string, right: string): number {
  return (
    (STAGE_INDEX.get(left) ?? STAGE_CODES.length) - (STAGE_INDEX.get(right) ?? STAGE_CODES.length)
  );
}

function groupPins(rows: readonly PinRow[]): Array<{ project_id: string; stages: StageCode[] }> {
  const byProject = new Map<string, string[]>();
  for (const row of rows) {
    const stages = byProject.get(row.project_id) ?? [];
    stages.push(row.stage);
    byProject.set(row.project_id, stages);
  }
  return [...byProject.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([project_id, stages]) => ({
      project_id,
      stages: [...stages].sort(byStageOrder) as StageCode[],
    }));
}

function profileOf(snapshot: unknown): SeriesProfile {
  return SeriesProfileResponseSchema.parse(snapshot);
}

function stringField(source: Record<string, unknown> | null, key: string): string | null {
  const value = source?.[key];
  return typeof value === 'string' ? value : null;
}

function toSummary(row: SeriesRow): SeriesSummary {
  const profile = profileOf(row.snapshot);
  return SeriesSummaryResponseSchema.parse({
    id: row.id,
    name: row.name,
    slug: row.slug,
    mode: profile.mode,
    status: row.status,
    current_version: row.current_version,
    current_version_id: row.current_version_id ?? '',
    target_duration_s: profile.target_duration_s,
    default_aspect_ratio: profile.default_aspect_ratio,
    revision: row.revision,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  });
}

function toDetail(row: SeriesListRow): SeriesDetail {
  return SeriesDetailResponseSchema.parse({
    ...toSummary(row),
    profile: profileOf(row.snapshot),
    version_count: row.version_count,
    in_flight_batches: row.in_flight_batches,
  });
}

const SERIES_SELECT = /* sql */ `
  SELECT s.id, s.name, s.slug, s.status, s.revision, s.created_at, s.updated_at,
         s.current_version_id, v.version AS current_version, v.snapshot,
         (SELECT count(*)::int FROM series_version sv WHERE sv.series_id = s.id) AS version_count,
         (SELECT count(*)::int FROM batch b WHERE b.series_id = s.id AND b.status = 'ACTIVE')
           AS in_flight_batches
    FROM series s
    JOIN series_version v ON v.id = s.current_version_id
`;

/** History: the previous snapshot comes from the window function. */
const VERSION_LIST_SELECT = /* sql */ `
  SELECT v.id, v.series_id, v.version, v.mode, v.target_duration_s, v.snapshot,
         v.created_at,
         COALESCE(o.username, 'system') AS created_by,
         lag(v.snapshot) OVER (PARTITION BY v.series_id ORDER BY v.version) AS previous_snapshot
    FROM series_version v
    LEFT JOIN operator o ON o.id = v.created_by
`;

/**
 * One version. `lag()` cannot be used here: WHERE filters the row before the
 * window is evaluated, so the previous snapshot is read explicitly.
 */
const VERSION_DETAIL_SELECT = /* sql */ `
  SELECT v.id, v.series_id, v.version, v.mode, v.target_duration_s, v.snapshot,
         v.created_at,
         COALESCE(o.username, 'system') AS created_by,
         (SELECT pv.snapshot FROM series_version pv
           WHERE pv.series_id = v.series_id AND pv.version = v.version - 1) AS previous_snapshot
    FROM series_version v
    LEFT JOIN operator o ON o.id = v.created_by
`;

function toVersionSummary(row: VersionRow): SeriesVersionSummary {
  return SeriesVersionSummaryResponseSchema.parse({
    id: row.id,
    series_id: row.series_id,
    version: row.version,
    mode: row.mode,
    target_duration_s: row.target_duration_s,
    changed_fields: changedProfileFields(
      row.previous_snapshot === null || row.previous_snapshot === undefined
        ? null
        : profileOf(row.previous_snapshot),
      profileOf(row.snapshot),
    ),
    created_at: row.created_at.toISOString(),
    created_by: row.created_by,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

/** S-03 list: every series (archived included), by name. */
export async function listSeries(db: Queryable): Promise<SeriesSummary[]> {
  const result = await db.query<SeriesListRow>(
    `${SERIES_SELECT} ORDER BY lower(s.name), s.created_at`,
  );
  return result.rows.map(toSummary);
}

/** S-04 detail: current snapshot, version count, in-flight batches (R-001-3). */
export async function getSeries(db: Queryable, seriesId: string): Promise<SeriesDetail> {
  return readDetail(db, seriesId);
}

async function readDetail(db: Queryable, seriesId: string): Promise<SeriesDetail> {
  const result = await db.query<SeriesListRow>(`${SERIES_SELECT} WHERE s.id = $1`, [seriesId]);
  const row = result.rows[0];
  if (!row) throw new SeriesNotFoundError(seriesId);
  return toDetail(row);
}

/** S-05 version history, newest first. */
export async function listSeriesVersions(
  db: Queryable,
  seriesId: string,
): Promise<SeriesVersionSummary[]> {
  await assertSeriesExists(db, seriesId);
  const result = await db.query<VersionRow>(
    `${VERSION_LIST_SELECT} WHERE v.series_id = $1 ORDER BY v.version DESC`,
    [seriesId],
  );
  return result.rows.map(toVersionSummary);
}

/** S-06 an immutable version snapshot plus the per-stage pins it still holds. */
export async function getSeriesVersion(
  db: Queryable,
  seriesId: string,
  versionId: string,
): Promise<SeriesVersionDetail> {
  return readVersionDetail(db, seriesId, versionId);
}

async function readVersionDetail(
  db: Queryable,
  seriesId: string,
  versionId: string,
): Promise<SeriesVersionDetail> {
  const result = await db.query<VersionRow>(
    `${VERSION_DETAIL_SELECT} WHERE v.series_id = $1 AND v.id = $2`,
    [seriesId, versionId],
  );
  const row = result.rows[0];
  if (!row) throw new SeriesVersionNotFoundError(seriesId, versionId);

  const pins = await db.query<PinRow>(
    `SELECT project_id, stage FROM video_stage WHERE series_version_id = $1`,
    [versionId],
  );

  return SeriesVersionDetailResponseSchema.parse({
    ...toVersionSummary(row),
    snapshot: profileOf(row.snapshot),
    pinned_by: groupPins(pins.rows),
  });
}

async function assertSeriesExists(db: Queryable, seriesId: string): Promise<void> {
  const result = await db.query<{ id: string }>(`SELECT id FROM series WHERE id = $1`, [seriesId]);
  if (result.rows.length === 0) throw new SeriesNotFoundError(seriesId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateSeriesInput {
  readonly name: string;
  readonly slug: string;
  readonly profile?: SeriesProfilePatch;
  /** The authenticated operator — recorded on version 1 (`series_version.created_by`). */
  readonly operatorId: string;
}

/** Create a series and mint version 1 in one transaction (R-001-1, R-002-1). */
export async function createSeries(pool: Pool, input: CreateSeriesInput): Promise<SeriesDetail> {
  const profile = mergeProfile(defaultProfile(), input.profile ?? {});

  try {
    return await withTransaction(pool, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO series
           (name, slug, niche, script_style, voice_config, art_style, default_aspect_ratio,
            target_duration_s, narration_language, captions_preset, music_config, image_resolution, mode)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13)
         RETURNING id`,
        [
          input.name,
          input.slug,
          JSON.stringify(profile.niche),
          jsonOrNull(profile.script_style),
          jsonOrNull(profile.voice_config),
          jsonOrNull(profile.art_style),
          profile.default_aspect_ratio,
          profile.target_duration_s,
          profile.narration_language,
          jsonOrNull(profile.captions_preset),
          jsonOrNull(profile.music_config),
          profile.image_resolution,
          profile.mode,
        ],
      );
      const seriesId = inserted.rows[0]?.id;
      if (seriesId === undefined) throw new Error('INSERT INTO series returned no id');

      await insertVersion(client, {
        seriesId,
        version: 1,
        profile,
        operatorId: input.operatorId,
      });

      return readDetail(client, seriesId);
    });
  } catch (error) {
    if (isUniqueViolation(error, 'series_slug_key')) throw new DuplicateSlugError(input.slug);
    throw error;
  }
}

export interface UpdateSeriesInput {
  readonly seriesId: string;
  /** The revision the operator edited (R-024 optimistic lock). */
  readonly revision: number;
  readonly name?: string;
  readonly profile?: SeriesProfilePatch;
  readonly operatorId: string;
}

/**
 * S-04 "save as new version": edit the profile and mint the next immutable
 * version. Never writes `project`, `video_stage.state` or `asset` (R-001-4).
 */
export async function updateSeries(pool: Pool, input: UpdateSeriesInput): Promise<SeriesDetail> {
  const minted = await mintVersion(pool, { ...input, allowIdentical: false });
  return readDetail(pool, minted.seriesId);
}

/**
 * `POST /api/series/:id/versions` — an explicit version, not an edit
 * (IP-02: profile edits are not invalidations). May mint an identical snapshot,
 * which is how a checkpoint is taken before a risky change.
 */
export async function mintSeriesVersion(
  pool: Pool,
  input: UpdateSeriesInput,
): Promise<SeriesVersionDetail> {
  const minted = await mintVersion(pool, { ...input, allowIdentical: true });
  return readVersionDetail(pool, minted.seriesId, minted.versionId);
}

interface MintVersionInput extends UpdateSeriesInput {
  readonly allowIdentical: boolean;
}

interface MintedVersion {
  readonly seriesId: string;
  readonly versionId: string;
  readonly version: number;
}

async function mintVersion(pool: Pool, input: MintVersionInput): Promise<MintedVersion> {
  return withTransaction(pool, async (client) => {
    // Per-series lock: the mint is the only writer of the version sequence and
    // of the editable document, so the lock is also the optimistic-lock point
    // (TECH_DESIGN §3.1 "service holds a per-series lock").
    //
    // The current snapshot is read *after* the lock, in a second statement, on
    // purpose: a SELECT that joins `series_version` and takes FOR UPDATE on
    // `series` can lose the row when the join key itself was just updated by
    // the transaction that held the lock (EvalPlanQual re-checks the join
    // against the new row version). Locking the single row first makes the
    // conflict deterministic: the loser sees the committed revision and gets a
    // RevisionConflictError instead of a phantom "not found".
    const locked = await client.query<SeriesRow>(
      `SELECT s.id, s.name, s.slug, s.status, s.revision, s.created_at, s.updated_at,
              s.current_version_id
         FROM series s
        WHERE s.id = $1
          FOR UPDATE`,
      [input.seriesId],
    );
    const lockedRow = locked.rows[0];
    if (!lockedRow || lockedRow.current_version_id === null) {
      throw new SeriesNotFoundError(input.seriesId);
    }

    const currentVersion = await client.query<{ version: number; snapshot: unknown }>(
      `SELECT version, snapshot FROM series_version WHERE id = $1`,
      [lockedRow.current_version_id],
    );
    const currentVersionRow = currentVersion.rows[0];
    if (!currentVersionRow) throw new SeriesNotFoundError(input.seriesId);

    const row: SeriesRow = {
      ...lockedRow,
      current_version: currentVersionRow.version,
      snapshot: currentVersionRow.snapshot,
    };

    if (row.revision !== input.revision) {
      throw new RevisionConflictError(row.revision, input.revision);
    }

    const before = profileOf(row.snapshot);
    const after = mergeProfile(before, input.profile ?? {});
    const changed = changedProfileFields(before, after);
    const name = input.name ?? row.name;

    if (!input.allowIdentical && changed.length === 0 && name === row.name) {
      throw new SeriesNoChangeError(row.id);
    }

    const version = row.current_version + 1;
    const inserted = await insertVersion(client, {
      seriesId: row.id,
      version,
      profile: after,
      operatorId: input.operatorId,
    });

    // M-006's AFTER INSERT trigger has already advanced current_version_id.
    // This UPDATE rewrites the editable columns and bumps the revision; it
    // cannot touch current_version_id (not in the SET list).
    await client.query(
      `UPDATE series
          SET name = $2, niche = $3::jsonb, script_style = $4::jsonb, voice_config = $5::jsonb,
              art_style = $6::jsonb, default_aspect_ratio = $7, target_duration_s = $8,
              narration_language = $9, captions_preset = $10::jsonb, music_config = $11::jsonb,
              image_resolution = $12, mode = $13, revision = revision + 1, updated_at = now()
        WHERE id = $1`,
      [
        row.id,
        name,
        JSON.stringify(after.niche),
        jsonOrNull(after.script_style),
        jsonOrNull(after.voice_config),
        jsonOrNull(after.art_style),
        after.default_aspect_ratio,
        after.target_duration_s,
        after.narration_language,
        jsonOrNull(after.captions_preset),
        jsonOrNull(after.music_config),
        after.image_resolution,
        after.mode,
      ],
    );

    return { seriesId: row.id, versionId: inserted.id, version };
  });
}

function jsonOrNull(value: Record<string, unknown> | null): string | null {
  return value === null ? null : JSON.stringify(value);
}

interface InsertVersionInput {
  readonly seriesId: string;
  readonly version: number;
  readonly profile: SeriesProfile;
  readonly operatorId: string;
}

async function insertVersion(db: Queryable, input: InsertVersionInput): Promise<{ id: string }> {
  // Denormalised columns (TECH_DESIGN §3.1): mode and duration are filtered on
  // cheaply, voice_id/art_preset for the provider-facing inspections.
  const voiceId = isPlainObject(input.profile.voice_config)
    ? stringField(input.profile.voice_config, 'voice_id')
    : null;
  const artPreset = isPlainObject(input.profile.art_style)
    ? stringField(input.profile.art_style, 'preset')
    : null;

  const result = await db.query<{ id: string }>(
    `INSERT INTO series_version
       (series_id, version, snapshot, mode, target_duration_s, voice_id, art_preset, created_by)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      input.seriesId,
      input.version,
      JSON.stringify(input.profile),
      input.profile.mode,
      input.profile.target_duration_s,
      voiceId,
      artPreset,
      input.operatorId,
    ],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('INSERT INTO series_version returned no id');
  return { id };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pins: later stages adopt the newest version, earlier output keeps its own
// ─────────────────────────────────────────────────────────────────────────────

export interface StagePinVersion {
  /** `series_version.id` the stage is pinned to. */
  readonly id: string;
  readonly version: number;
  readonly snapshot: SeriesProfile;
}

/**
 * The version a stage must use when it starts (X-8/OQ-6, R-002-3).
 *
 * Read inside the caller's transaction, next to the stage's first write, so a
 * series edit that commits before the stage starts is adopted and one that
 * commits after is not. Callers must not cache the result across a stage run.
 */
export async function seriesVersionForStageStart(
  db: Queryable,
  seriesId: string,
): Promise<StagePinVersion> {
  const result = await db.query<{ id: string; version: number; snapshot: unknown }>(
    `SELECT v.id, v.version, v.snapshot
       FROM series s JOIN series_version v ON v.id = s.current_version_id
      WHERE s.id = $1`,
    [seriesId],
  );
  const row = result.rows[0];
  if (!row) throw new SeriesNotFoundError(seriesId);
  return { id: row.id, version: row.version, snapshot: profileOf(row.snapshot) };
}

/**
 * Pin a stage to the current series version as it starts.
 *
 * Writes only `video_stage.series_version_id` (and `updated_at`); the stage's
 * `state` remains `src/domain/state-machine.ts`'s single writer. Call this in
 * the same transaction as the claim transition.
 */
export async function pinStageAtStart(
  db: Queryable,
  projectId: string,
  stage: StageCode,
): Promise<StagePinVersion & { stage: StageCode }> {
  const project = await db.query<{ series_id: string }>(
    `SELECT series_id FROM project WHERE id = $1`,
    [projectId],
  );
  const projectRow = project.rows[0];
  if (!projectRow) throw new ProjectNotFoundError(projectId);

  const pinned = await seriesVersionForStageStart(db, projectRow.series_id);
  const updated = await db.query(
    `UPDATE video_stage
        SET series_version_id = $2, updated_at = now()
      WHERE project_id = $1 AND stage = $3`,
    [projectId, pinned.id, stage],
  );
  if (updated.rowCount === 0) throw new StageNotFoundError(projectId, stage);

  return { ...pinned, stage };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-video target duration (R-009-1)
// ─────────────────────────────────────────────────────────────────────────────

export interface ProjectTargetDuration {
  readonly seriesTargetS: number;
  /** The per-video override, or null when the video inherits the series value. */
  readonly projectTargetS: number | null;
  /** What the video renders to. */
  readonly effectiveTargetS: number;
}

/** Resolve a video's target: override if set, otherwise the series value. */
export async function resolveProjectTargetDuration(
  db: Queryable,
  projectId: string,
): Promise<ProjectTargetDuration> {
  const result = await db.query<{
    series_target_s: number;
    project_target_s: number | null;
  }>(
    `SELECT s.target_duration_s AS series_target_s, p.target_duration_s AS project_target_s
       FROM project p JOIN series s ON s.id = p.series_id
      WHERE p.id = $1`,
    [projectId],
  );
  const row = result.rows[0];
  if (!row) throw new ProjectNotFoundError(projectId);

  return {
    seriesTargetS: row.series_target_s,
    projectTargetS: row.project_target_s,
    effectiveTargetS: effectiveTargetDuration(row.series_target_s, row.project_target_s),
  };
}

/**
 * Set or clear a video's duration override. `null` restores inheritance
 * (R-009-1 "null = inherit series" in TECH_DESIGN §3.1's `project` row).
 */
export async function setProjectTargetDuration(
  db: Queryable,
  projectId: string,
  targetS: number | null,
): Promise<ProjectTargetDuration> {
  if (targetS !== null) assertTargetDuration(targetS);
  const updated = await db.query(
    `UPDATE project SET target_duration_s = $2, updated_at = now() WHERE id = $1`,
    [projectId, targetS],
  );
  if (updated.rowCount === 0) throw new ProjectNotFoundError(projectId);
  return resolveProjectTargetDuration(db, projectId);
}
