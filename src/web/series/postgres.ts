/**
 * Postgres-backed `SeriesGateway` — S-03/S-04 read/write against `series`,
 * `series_version` and `batch`.
 *
 * Mirrors the in-memory gateway's contract exactly: `list` → `SeriesSummary[]`,
 * `get` → `SeriesDetail | null`, and `create`/`update` mint immutable versions.
 * `series_version.created_by` is left NULL — the page layer has no operator
 * context, and version authorship belongs to the API layer (S-05/S-06).
 *
 * The M-006 triggers keep the invariants structural: strictly-increasing
 * `version`, immutable rows, and `current_version_id` tracking the newest
 * version, so this module only ever INSERTs a version and never rewrites one.
 */
import type { Pool } from 'pg';

import { withTransaction, type Queryable } from '../../db/client.js';
import {
  SeriesDetailResponseSchema,
  SeriesProfileResponseSchema,
  SeriesSummaryResponseSchema,
  changedProfileFields,
  type SeriesProfile,
} from '../../domain/series.js';
import {
  SeriesArchivedError,
  SeriesConflictError,
  SeriesNotFoundError,
  SeriesSlugTakenError,
  type SeriesCreateInput,
  type SeriesDetail,
  type SeriesGateway,
  type SeriesSummary,
  type SeriesUpdateInput,
} from './gateway.js';

/**
 * One row per series, joined to its current version. The snapshot (not the
 * denormalised `series` columns) is the source of truth for `mode`,
 * `target_duration_s` and `default_aspect_ratio` — same rule as the domain
 * layer's `SERIES_SELECT`.
 */
const SERIES_SELECT = /* sql */ `
  SELECT s.id, s.name, s.slug, s.status, s.revision, s.created_at, s.updated_at,
         s.current_version_id,
         v.version AS current_version,
         v.snapshot,
         (SELECT count(*)::int FROM series_version sv WHERE sv.series_id = s.id) AS version_count,
         (SELECT count(*)::int FROM batch b WHERE b.series_id = s.id AND b.status = 'ACTIVE')
           AS in_flight_batches
    FROM series s
    JOIN series_version v ON v.id = s.current_version_id
`;

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
  readonly version_count: number;
  readonly in_flight_batches: number;
}

function profileOf(snapshot: unknown): SeriesProfile {
  return SeriesProfileResponseSchema.parse(snapshot);
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

function toDetail(row: SeriesRow): SeriesDetail {
  const profile = profileOf(row.snapshot);
  return SeriesDetailResponseSchema.parse({
    ...toSummary(row),
    profile,
    version_count: row.version_count,
    in_flight_batches: row.in_flight_batches,
  });
}

async function readDetail(db: Queryable, seriesId: string): Promise<SeriesDetail | null> {
  const result = await db.query<SeriesRow>(`${SERIES_SELECT} WHERE s.id = $1`, [seriesId]);
  const row = result.rows[0];
  return row === undefined ? null : toDetail(row);
}

async function requireDetail(db: Queryable, seriesId: string): Promise<SeriesDetail> {
  const detail = await readDetail(db, seriesId);
  if (detail === null) throw new SeriesNotFoundError(seriesId);
  return detail;
}

function jsonOrNull(value: Record<string, unknown> | null): string | null {
  return value === null ? null : JSON.stringify(value);
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === '23505' && candidate.constraint === constraint;
}

/**
 * `series` editable-column UPDATE, shared by `create`/`update`. The value list
 * is one-to-one with the column order and never includes `current_version_id`
 * (the M-006 trigger owns that pointer).
 */
const SERIES_WRITE_COLUMNS = /* sql */ `
  name = $2, niche = $3::jsonb, script_style = $4::jsonb, voice_config = $5::jsonb,
  art_style = $6::jsonb, default_aspect_ratio = $7, target_duration_s = $8,
  narration_language = $9, captions_preset = $10::jsonb, music_config = $11::jsonb,
  image_resolution = $12, mode = $13
`;

function seriesWriteValues(profile: SeriesProfile): unknown[] {
  return [
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
  ];
}

/**
 * The count of videos still mid-pipeline for a series. `NOT_STARTED` is
 * excluded — such a project adopts the newest version when it starts
 * (R-002-3), so it is not a reason to warn that an edit leaves work behind.
 * `COMPLETE`/`CANCELLED` are finished and also excluded.
 */
async function countInFlightVideos(db: Queryable, seriesId: string): Promise<number> {
  const result = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM project
      WHERE series_id = $1 AND status IN ('RUNNING', 'NEEDS_ATTENTION')`,
    [seriesId],
  );
  return result.rows[0]?.count ?? 0;
}

export function createSeriesGateway(pool: Pool): SeriesGateway {
  return {
    async list(): Promise<readonly SeriesSummary[]> {
      const result = await pool.query<SeriesRow>(
        `${SERIES_SELECT} ORDER BY lower(s.name), s.created_at`,
      );
      return result.rows.map(toSummary);
    },

    async get(seriesId: string): Promise<SeriesDetail | null> {
      return readDetail(pool, seriesId);
    },

    async create(input: SeriesCreateInput): Promise<SeriesDetail> {
      const profile = profileOf(input.profile);

      try {
        return await withTransaction(pool, async (client) => {
          const inserted = await client.query<{ id: string }>(
            `INSERT INTO series
               (name, slug, niche, script_style, voice_config, art_style, default_aspect_ratio,
                target_duration_s, narration_language, captions_preset, music_config, image_resolution, mode)
             VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13)
             RETURNING id`,
            [input.name, input.slug, ...seriesWriteValues(profile)],
          );
          const seriesId = inserted.rows[0]?.id;
          if (seriesId === undefined) throw new Error('INSERT INTO series returned no id');

          await client.query(
            `INSERT INTO series_version (series_id, version, snapshot, mode, target_duration_s)
             VALUES ($1, 1, $2::jsonb, $3, $4)`,
            [seriesId, JSON.stringify(profile), profile.mode, profile.target_duration_s],
          );

          return requireDetail(client, seriesId);
        });
      } catch (error) {
        if (isUniqueViolation(error, 'series_slug_key')) {
          throw new SeriesSlugTakenError(input.slug);
        }
        throw error;
      }
    },

    async update(seriesId: string, input: SeriesUpdateInput): Promise<SeriesDetail> {
      return withTransaction(pool, async (client) => {
        const locked = await client.query<{
          id: string;
          name: string;
          status: string;
          revision: number;
          updated_at: Date;
          current_version_id: string | null;
        }>(
          `SELECT id, name, status, revision, updated_at, current_version_id
             FROM series WHERE id = $1 FOR UPDATE`,
          [seriesId],
        );
        const row = locked.rows[0];
        if (row === undefined) throw new SeriesNotFoundError(seriesId);
        if (row.status === 'archived') throw new SeriesArchivedError();

        const current = await client.query<{ version: number; snapshot: unknown }>(
          `SELECT version, snapshot FROM series_version WHERE id = $1`,
          [row.current_version_id],
        );
        const currentVersion = current.rows[0];
        if (currentVersion === undefined) throw new SeriesNotFoundError(seriesId);

        // R-024/IP-09: the caller edits the revision it last read.
        if (row.revision !== input.revision) {
          throw new SeriesConflictError(
            row.revision,
            currentVersion.version,
            row.updated_at.toISOString(),
          );
        }

        const before = profileOf(currentVersion.snapshot);
        const nextName = input.name ?? row.name;
        const nextProfile = input.profile === undefined ? before : profileOf(input.profile);

        // R-002-1: an edit that changes nothing is not an edit.
        const changed = [
          ...(nextName === row.name ? [] : ['name']),
          ...changedProfileFields(before, nextProfile),
        ];
        if (changed.length === 0) return requireDetail(client, seriesId);

        const version = currentVersion.version + 1;
        await client.query(
          `INSERT INTO series_version (series_id, version, snapshot, mode, target_duration_s)
           VALUES ($1, $2, $3::jsonb, $4, $5)`,
          [
            seriesId,
            version,
            JSON.stringify(nextProfile),
            nextProfile.mode,
            nextProfile.target_duration_s,
          ],
        );

        // The M-006 trigger has already advanced current_version_id.
        await client.query(
          `UPDATE series SET ${SERIES_WRITE_COLUMNS}, revision = revision + 1, updated_at = now()
            WHERE id = $1`,
          [seriesId, nextName, ...seriesWriteValues(nextProfile)],
        );

        return requireDetail(client, seriesId);
      });
    },

    async inFlightVideos(seriesId: string): Promise<number | null> {
      return countInFlightVideos(pool, seriesId);
    },
  };
}
