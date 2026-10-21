/**
 * asset / asset_ref writes — the provenance write path (R-013-1, R-026; US-019).
 *
 * Every generated image goes through persistSceneImage(), one transaction that:
 *  1. inserts the content-addressed row (object_key is a pure function of the
 *     hash, enforced by the asset_object_key_matches_hash CHECK);
 *  2. reverts to the existing row on a duplicate hash (R-026-1: one row per
 *     unique content hash), so a shared image has one blob and two references;
 *  3. links scene.asset_id only while it is null or already this asset —
 *     replacing an existing image is B-15's path and must not be smuggled in by
 *     a stage retry;
 *  4. links generation_run.asset_id, the reverse edge of the circular FK.
 *
 * R-013-1 provenance is not optional: prompt text + hash, model, seed, provider
 * request id, series-version pin and rights metadata are all written here.
 */
import type { Pool } from 'pg';

import { objectKeyFor } from '../../storage/object-store.js';
import { withTransaction, type Queryable } from '../client.js';

export type AssetStage = 'IM' | 'NA' | 'RE' | 'QC' | 'EX' | 'MUSIC' | 'POSTER' | 'DERIV' | 'REF';
export type AssetKind = 'image' | 'audio' | 'video' | 'caption' | 'sidecar' | 'zip' | 'derivative';

export interface AssetRow {
  readonly id: string;
  readonly project_id: string | null;
  readonly stage: AssetStage;
  readonly scene_id: string | null;
  readonly kind: AssetKind;
  readonly content_sha256: string;
  readonly object_key: string;
  readonly object_size_bytes: string | null;
  readonly mime_type: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly series_version_id: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly seed: string | null;
  readonly provider_request_id: string | null;
  readonly prompt_hash: string | null;
  readonly prompt_text: string | null;
  readonly rights_metadata: unknown;
  readonly generation_run_id: string | null;
  readonly retention_eligible_at: Date | null;
  readonly created_at: Date;
}

export const ASSET_COLUMNS =
  'id, project_id, stage, scene_id, kind, content_sha256, object_key, object_size_bytes, ' +
  'mime_type, width, height, series_version_id, provider, model, seed, provider_request_id, ' +
  'prompt_hash, prompt_text, rights_metadata, generation_run_id, retention_eligible_at, created_at';

export interface NewAssetProvenance {
  readonly projectId: string;
  readonly stage: AssetStage;
  readonly sceneId?: string | null;
  readonly kind: AssetKind;
  readonly contentSha256: string;
  readonly objectSizeBytes?: number | null;
  readonly mimeType?: string | null;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly seriesVersionId?: string | null;
  readonly provider?: string | null;
  readonly model?: string | null;
  readonly seed?: string | null;
  readonly providerRequestId?: string | null;
  readonly promptHash?: string | null;
  readonly promptText?: string | null;
  readonly rightsMetadata?: Record<string, unknown> | null;
  readonly generationRunId?: string | null;
  readonly retentionEligibleAt?: Date | null;
}

export interface AssetUpsertResult {
  readonly asset: AssetRow;
  /** false when the content hash already had a row (R-026-1 dedupe hit). */
  readonly created: boolean;
}

function insertParams(input: NewAssetProvenance, objectKey: string): unknown[] {
  return [
    input.projectId,
    input.stage,
    input.sceneId ?? null,
    input.kind,
    input.contentSha256,
    objectKey,
    input.objectSizeBytes ?? null,
    input.mimeType ?? null,
    input.width ?? null,
    input.height ?? null,
    input.seriesVersionId ?? null,
    input.provider ?? null,
    input.model ?? null,
    input.seed ?? null,
    input.providerRequestId ?? null,
    input.promptHash ?? null,
    input.promptText ?? null,
    input.rightsMetadata === undefined || input.rightsMetadata === null
      ? null
      : JSON.stringify(input.rightsMetadata),
    input.generationRunId ?? null,
    input.retentionEligibleAt ?? null,
  ];
}

/**
 * Insert the asset row, or return the row that already owns this content hash.
 * The object key is derived, never supplied: R-026-2 is a pure function.
 */
export async function insertOrReuseAsset(
  db: Queryable,
  input: NewAssetProvenance,
): Promise<AssetUpsertResult> {
  const objectKey = objectKeyFor(input.contentSha256);
  const inserted = await db.query<AssetRow>(
    'INSERT INTO asset (project_id, stage, scene_id, kind, content_sha256, object_key, ' +
      'object_size_bytes, mime_type, width, height, series_version_id, provider, model, seed, ' +
      'provider_request_id, prompt_hash, prompt_text, rights_metadata, generation_run_id, ' +
      'retention_eligible_at) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, ' +
      '$17, $18, $19, $20) ' +
      'ON CONFLICT (content_sha256) DO NOTHING ' +
      'RETURNING ' +
      ASSET_COLUMNS,
    insertParams(input, objectKey),
  );
  const created = inserted.rows[0];
  if (created !== undefined) return { asset: created, created: true };

  const existing = await db.query<AssetRow>(
    'SELECT ' + ASSET_COLUMNS + ' FROM asset WHERE content_sha256 = $1',
    [input.contentSha256],
  );
  const row = existing.rows[0];
  if (row === undefined) {
    throw new Error(
      'asset ' +
        input.contentSha256 +
        ' conflicted but no row is visible: the transaction isolation level hides it',
    );
  }
  return { asset: row, created: false };
}

export interface SceneImagePersistence extends NewAssetProvenance {
  readonly sceneId: string;
}

export interface SceneImageResult extends AssetUpsertResult {
  /** false when the scene already showed a different image (a replace, not a first image). */
  readonly linked: boolean;
}

/**
 * Persist one generated scene image with full provenance, atomically with the
 * scene and run links. This is the only image write path in the stage.
 */
export async function persistSceneImage(
  pool: Pool,
  input: SceneImagePersistence,
): Promise<SceneImageResult> {
  return withTransaction(pool, async (client) => {
    const upsert = await insertOrReuseAsset(client, input);
    const linked = await client.query<{ id: string }>(
      'UPDATE scene SET asset_id = $2 ' +
        'WHERE id = $1 AND (asset_id IS NULL OR asset_id = $2) RETURNING id',
      [input.sceneId, upsert.asset.id],
    );
    if ((linked.rowCount ?? 0) === 0) {
      const scene = await client.query<{ id: string; asset_id: string | null }>(
        'SELECT id, asset_id FROM scene WHERE id = $1',
        [input.sceneId],
      );
      if (scene.rows[0] === undefined) {
        throw new Error(
          'scene ' + input.sceneId + ' does not exist; an image cannot be attached to it',
        );
      }
      return { ...upsert, linked: false };
    }
    if (input.generationRunId !== undefined && input.generationRunId !== null) {
      await client.query(
        'UPDATE generation_run SET asset_id = COALESCE(asset_id, $2) WHERE id = $1',
        [input.generationRunId, upsert.asset.id],
      );
    }
    return { ...upsert, linked: true };
  });
}

export interface ReferenceAssetRow {
  readonly asset_id: string;
  readonly object_key: string;
  readonly content_sha256: string;
  readonly mime_type: string | null;
  readonly rights_metadata: unknown;
  readonly created_at: Date;
}

/**
 * The approved reference set for a project: REF assets linked through
 * asset_ref (never duplicated per project, R-026). Roles do not matter to the
 * image stage; the order is the order they were approved in, which is the order
 * the adapter forwards as inlineData.
 */
export async function findProjectReferenceAssets(
  db: Queryable,
  projectId: string,
): Promise<ReferenceAssetRow[]> {
  const result = await db.query<ReferenceAssetRow>(
    'SELECT a.id AS asset_id, a.object_key, a.content_sha256, a.mime_type, a.rights_metadata, ' +
      'a.created_at ' +
      'FROM asset a JOIN asset_ref r ON r.asset_id = a.id ' +
      "WHERE r.project_id = $1 AND a.stage = 'REF' " +
      'ORDER BY a.created_at ASC, a.id ASC',
    [projectId],
  );
  const seen = new Set<string>();
  const unique: ReferenceAssetRow[] = [];
  for (const row of result.rows) {
    if (seen.has(row.asset_id)) continue;
    seen.add(row.asset_id);
    unique.push(row);
  }
  return unique;
}

/**
 * The creation time of the newest image attached to scenes 1..3 — the anchor a
 * first-three approval must postdate. A script edit that regenerates the
 * checkpoint scenes therefore re-arms the gate (PRD 10), while a duplicate-hash
 * reuse of an older, visually identical asset does not move the anchor back.
 */
export async function latestCheckpointSceneAssetAt(
  db: Queryable,
  projectId: string,
  withinPositions: number,
): Promise<Date | null> {
  const result = await db.query<{ latest: Date | null }>(
    'SELECT max(a.created_at) AS latest ' +
      'FROM scene s JOIN asset a ON a.id = s.asset_id ' +
      'WHERE s.project_id = $1 AND s.position <= $2',
    [projectId, withinPositions],
  );
  return result.rows[0]?.latest ?? null;
}
