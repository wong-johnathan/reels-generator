/**
 * `asset` writes — content-addressed provenance (R-013-1, R-026).
 *
 * `object_key` is written as `'sha256:' || content_sha256` in SQL so the value
 * can only ever be the one the CHECK constraint allows; no JavaScript string is
 * trusted to agree with the hash column. Insertion is `ON CONFLICT
 * (content_sha256) DO NOTHING` followed by a read, which is R-026's dedupe: one
 * row per unique blob, whatever stage produced it.
 */
import type { Queryable } from '../client.js';

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

export interface NewAsset {
  readonly projectId: string | null;
  readonly stage: AssetStage;
  readonly sceneId?: string | null;
  readonly kind: AssetKind;
  readonly contentSha256: string;
  readonly objectSizeBytes: number;
  readonly mimeType: string;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly seriesVersionId?: string | null;
  readonly provider?: string | null;
  readonly model?: string | null;
  readonly seed?: string | null;
  readonly providerRequestId?: string | null;
  readonly promptHash?: string | null;
  readonly promptText?: string | null;
  readonly rightsMetadata?: unknown;
  readonly generationRunId?: string | null;
  readonly retentionEligibleAt?: Date | null;
}

export interface InsertedAsset {
  readonly row: AssetRow;
  /** False when the blob was already stored (R-026 dedupe hit). */
  readonly created: boolean;
}

const COLUMNS = /* sql */ `
  id, project_id, stage, scene_id, kind, content_sha256, object_key, object_size_bytes,
  mime_type, width, height, series_version_id, provider, model, seed, provider_request_id,
  prompt_hash, prompt_text, rights_metadata, generation_run_id, retention_eligible_at, created_at
`;

export async function insertAsset(db: Queryable, input: NewAsset): Promise<InsertedAsset> {
  if (!/^[0-9a-f]{64}$/.test(input.contentSha256)) {
    throw new RangeError('content_sha256 must be 64 lowercase hex characters (R-026)');
  }
  const inserted = await db.query<AssetRow>(
    `INSERT INTO asset
       (project_id, stage, scene_id, kind, content_sha256, object_key, object_size_bytes,
        mime_type, width, height, series_version_id, provider, model, seed, provider_request_id,
        prompt_hash, prompt_text, rights_metadata, generation_run_id, retention_eligible_at)
     VALUES ($1, $2, $3, $4, $5, 'sha256:' || $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
             $15, $16, $17::jsonb, $18, $19)
     ON CONFLICT (content_sha256) DO NOTHING
     RETURNING ${COLUMNS}`,
    [
      input.projectId,
      input.stage,
      input.sceneId ?? null,
      input.kind,
      input.contentSha256,
      input.objectSizeBytes,
      input.mimeType,
      input.width ?? null,
      input.height ?? null,
      input.seriesVersionId ?? null,
      input.provider ?? null,
      input.model ?? null,
      input.seed ?? null,
      input.providerRequestId ?? null,
      input.promptHash ?? null,
      input.promptText ?? null,
      input.rightsMetadata === undefined ? null : JSON.stringify(input.rightsMetadata),
      input.generationRunId ?? null,
      input.retentionEligibleAt ?? null,
    ],
  );
  const created = inserted.rows[0];
  if (created !== undefined) return { row: created, created: true };

  const existing = await db.query<AssetRow>(
    `SELECT ${COLUMNS} FROM asset WHERE content_sha256 = $1`,
    [input.contentSha256],
  );
  const row = existing.rows[0];
  if (row === undefined) {
    throw new Error(`asset ${input.contentSha256} was neither inserted nor found (R-026 dedupe)`);
  }
  return { row, created: false };
}

export async function findAssetById(db: Queryable, id: string): Promise<AssetRow | null> {
  const result = await db.query<AssetRow>(`SELECT ${COLUMNS} FROM asset WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}

/**
 * R-026's sharing model: a blob is stored once, and every project that reuses it
 * gets an `asset_ref` row instead of a duplicate blob. The dedupe hit keeps the
 * first row's provenance (`asset.project_id`, `generation_run_id`), which is
 * correct — the provenance describes the blob — while `asset_ref` answers "which
 * projects may use it".
 */
export async function linkAssetToProject(
  db: Queryable,
  input: { readonly assetId: string; readonly projectId: string; readonly role: string },
): Promise<void> {
  await db.query(
    `INSERT INTO asset_ref (asset_id, project_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (asset_id, project_id, role) DO NOTHING`,
    [input.assetId, input.projectId, input.role],
  );
}

/** True when the asset belongs to the project directly or through an `asset_ref`. */
export async function assetBelongsToProject(
  db: Queryable,
  assetId: string,
  projectId: string,
): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM asset WHERE id = $1 AND project_id = $2
     UNION ALL
     SELECT 1 FROM asset_ref WHERE asset_id = $1 AND project_id = $2
     LIMIT 1`,
    [assetId, projectId],
  );
  return (result.rowCount ?? 0) > 0;
}
