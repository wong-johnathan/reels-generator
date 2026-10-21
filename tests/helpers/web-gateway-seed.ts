/**
 * Shared seeding for the page-gateway Postgres tests.
 *
 * Each gateway test provisions its own throwaway database (via
 * `createTestDatabase`) and needs the same foundation — a series, one
 * `series_version`, a project and its eleven minted `video_stage` rows — before
 * it can lay down the stage/asset/decision rows its gateway reads. This helper
 * keeps that boilerplate in one place so the four test files only express what
 * they are actually asserting.
 */
import { createHash } from 'node:crypto';

import type { Pool } from 'pg';

export interface SeededProject {
  readonly seriesId: string;
  readonly seriesVersionId: string;
  readonly projectId: string;
}

export const STAGES = ['T', 'RS', 'SC', 'SB', 'IM', 'NA', 'TC', 'RE', 'QC', 'FA', 'EX'] as const;

/** A valid, deterministic 64-hex `content_sha256` (and its R-026 object key). */
export function sha256For(tag: string): string {
  return createHash('sha256').update(tag).digest('hex');
}

export async function seedProject(
  pool: Pool,
  options: { readonly slug?: string; readonly targetDurationS?: number } = {},
): Promise<SeededProject> {
  const slug = options.slug ?? 'test-series';
  const target = options.targetDurationS ?? 75;

  const series = await pool.query<{ id: string }>(
    `INSERT INTO series (name, slug, niche, mode, target_duration_s)
     VALUES ($1, $2, '{}'::jsonb, 'creative', $3)
     RETURNING id`,
    [slug, slug, target],
  );
  const seriesId = series.rows[0]!.id;

  const version = await pool.query<{ id: string }>(
    `INSERT INTO series_version (series_id, version, snapshot, mode, target_duration_s)
     VALUES ($1, 1, '{}'::jsonb, 'creative', $2)
     RETURNING id`,
    [seriesId, target],
  );
  const seriesVersionId = version.rows[0]!.id;

  const project = await pool.query<{ id: string }>(
    `INSERT INTO project (series_id, position_in_batch, target_duration_s)
     VALUES ($1, 1, $2)
     RETURNING id`,
    [seriesId, target],
  );
  const projectId = project.rows[0]!.id;

  for (const stage of STAGES) {
    await pool.query('INSERT INTO video_stage (project_id, stage) VALUES ($1, $2)', [
      projectId,
      stage,
    ]);
  }

  return { seriesId, seriesVersionId, projectId };
}

export async function setStageState(
  pool: Pool,
  projectId: string,
  stage: string,
  state: string,
  options: { readonly seriesVersionId?: string | null; readonly lastEventAt?: Date | null } = {},
): Promise<void> {
  await pool.query(
    `UPDATE video_stage
        SET state = $3,
            series_version_id = COALESCE($4, series_version_id),
            last_event_at = COALESCE($5, last_event_at),
            updated_at = now()
      WHERE project_id = $1 AND stage = $2`,
    [projectId, stage, state, options.seriesVersionId ?? null, options.lastEventAt ?? null],
  );
}

export interface SeedAssetInput {
  readonly projectId: string;
  readonly stage: string;
  readonly kind: string;
  readonly contentSha256: string;
  readonly role?: string;
  readonly sizeBytes?: number;
  readonly mimeType?: string;
  readonly width?: number;
  readonly height?: number;
  readonly seriesVersionId?: string | null;
  readonly provider?: string | null;
  readonly model?: string | null;
  readonly providerRequestId?: string | null;
  readonly promptHash?: string | null;
  readonly promptText?: string | null;
  readonly seed?: string | null;
  readonly rightsMetadata?: unknown;
  readonly createdAt?: Date;
}

/** Insert an asset row (and, when `role` is set, its `asset_ref` link). */
export async function insertAsset(pool: Pool, input: SeedAssetInput): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO asset
       (project_id, stage, kind, content_sha256, object_key, object_size_bytes, mime_type,
        width, height, series_version_id, provider, model, provider_request_id,
        prompt_hash, prompt_text, seed, rights_metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18)
     RETURNING id`,
    [
      input.projectId,
      input.stage,
      input.kind,
      input.contentSha256,
      'sha256:' + input.contentSha256,
      input.sizeBytes ?? 0,
      input.mimeType ?? null,
      input.width ?? null,
      input.height ?? null,
      input.seriesVersionId ?? null,
      input.provider ?? null,
      input.model ?? null,
      input.providerRequestId ?? null,
      input.promptHash ?? null,
      input.promptText ?? null,
      input.seed ?? null,
      input.rightsMetadata == null ? null : JSON.stringify(input.rightsMetadata),
      input.createdAt ?? null,
    ],
  );
  const id = result.rows[0]!.id;
  if (input.role !== undefined) {
    await pool.query(
      'INSERT INTO asset_ref (asset_id, project_id, role, created_at) VALUES ($1, $2, $3, $4)',
      [id, input.projectId, input.role, input.createdAt ?? null],
    );
  }
  return id;
}
