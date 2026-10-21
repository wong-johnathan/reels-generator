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
  /** The readable object key the bytes are stored under (D-F), e.g.
   * `<series-slug>/batch-0001/scenes/S07.png`. Unique; the dedupe target. */
  readonly objectKey: string;
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

function insertParams(input: NewAssetProvenance): unknown[] {
  return [
    input.projectId,
    input.stage,
    input.sceneId ?? null,
    input.kind,
    input.contentSha256,
    input.objectKey,
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
 * Insert the asset row, or return the row that already owns this object key.
 * The key is supplied by the caller (readable path, D-F), never derived here:
 * the same path is the conflict target, so a re-render or re-store under the
 * same path resolves to the existing row.
 */
export async function insertOrReuseAsset(
  db: Queryable,
  input: NewAssetProvenance,
): Promise<AssetUpsertResult> {
  const inserted = await db.query<AssetRow>(
    'INSERT INTO asset (project_id, stage, scene_id, kind, content_sha256, object_key, ' +
      'object_size_bytes, mime_type, width, height, series_version_id, provider, model, seed, ' +
      'provider_request_id, prompt_hash, prompt_text, rights_metadata, generation_run_id, ' +
      'retention_eligible_at) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, ' +
      '$17, $18, $19, $20) ' +
      'ON CONFLICT (object_key) DO NOTHING ' +
      'RETURNING ' +
      ASSET_COLUMNS,
    insertParams(input),
  );
  const created = inserted.rows[0];
  if (created !== undefined) return { asset: created, created: true };

  // The conflict target is the object key, so the dedupe hit is looked up by
  // key — exact, not "newest by hash", because the hash is no longer unique.
  const existing = await db.query<AssetRow>(
    'SELECT ' + ASSET_COLUMNS + ' FROM asset WHERE object_key = $1',
    [input.objectKey],
  );
  const row = existing.rows[0];
  if (row === undefined) {
    throw new Error(
      'asset at object key ' +
        input.objectKey +
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
export interface NewAsset {
  readonly projectId: string | null;
  readonly stage: AssetStage;
  readonly sceneId?: string | null;
  readonly kind: AssetKind;
  readonly contentSha256: string;
  /** The readable object key the bytes are stored under (D-F). Unique. */
  readonly objectKey: string;
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

export async function insertAsset(db: Queryable, input: NewAsset): Promise<InsertedAsset> {
  if (!/^[0-9a-f]{64}$/.test(input.contentSha256)) {
    throw new RangeError('content_sha256 must be 64 lowercase hex characters (R-026)');
  }
  const inserted = await db.query<AssetRow>(
    `INSERT INTO asset
       (project_id, stage, scene_id, kind, content_sha256, object_key, object_size_bytes,
        mime_type, width, height, series_version_id, provider, model, seed, provider_request_id,
        prompt_hash, prompt_text, rights_metadata, generation_run_id, retention_eligible_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
             $15, $16, $17::jsonb, $18, $19)
     ON CONFLICT (object_key) DO NOTHING
     RETURNING ${ASSET_COLUMNS}`,
    [
      input.projectId,
      input.stage,
      input.sceneId ?? null,
      input.kind,
      input.contentSha256,
      input.objectKey,
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

  // The conflict target is the object key, so the dedupe hit is looked up by
  // key — exact, because the hash is no longer unique.
  const existing = await db.query<AssetRow>(
    `SELECT ${ASSET_COLUMNS} FROM asset WHERE object_key = $1`,
    [input.objectKey],
  );
  const row = existing.rows[0];
  if (row === undefined) {
    throw new Error(`asset at object key ${input.objectKey} was neither inserted nor found`);
  }
  return { row, created: false };
}

export async function findAssetById(db: Queryable, id: string): Promise<AssetRow | null> {
  const result = await db.query<AssetRow>(`SELECT ${ASSET_COLUMNS} FROM asset WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}

/**
 * The readable-path half of an asset key for one project: its series slug and
 * its batch's stored ordinal. Every asset writer resolves these once and passes
 * the derived object key into `insertAsset`/`insertOrReuseAsset` — the key is
 * never derived from the bytes, so the folder is stable even if the batch is
 * re-numbered elsewhere.
 */
export async function assetKeyContextFor(
  db: Queryable,
  projectId: string,
): Promise<{ readonly seriesSlug: string; readonly batchOrdinal: number }> {
  const result = await db.query<{ slug: string; ordinal: number }>(
    `SELECT s.slug, b.ordinal
       FROM project p
       JOIN series s ON s.id = p.series_id
       JOIN batch b ON b.id = p.batch_id
      WHERE p.id = $1`,
    [projectId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(
      `project ${projectId} has no series/batch, so its assets cannot be given a readable key`,
    );
  }
  return { seriesSlug: row.slug, batchOrdinal: Number(row.ordinal) };
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

// ─────────────────────────────────────────────────────────────────────────────
// B-15 — per-scene replace (US-020, RULINGS L-2). The one path that may move a
// scene's `asset_id` off an image that is already there.
// ─────────────────────────────────────────────────────────────────────────────

/** The image linked to the scene changed after the caller read it (concurrent replace). */
export class SceneAssetConflictError extends Error {
  constructor(
    readonly sceneId: string,
    readonly expectedAssetId: string | null,
    readonly actualAssetId: string | null,
  ) {
    super(
      'scene ' +
        sceneId +
        ' now shows asset ' +
        String(actualAssetId) +
        ', not the ' +
        String(expectedAssetId) +
        ' the replacement was generated against: refusing to overwrite a newer image',
    );
    this.name = 'SceneAssetConflictError';
  }
}

export interface SceneImageReplacement extends NewAssetProvenance {
  readonly sceneId: string;
  /** The image the call was generated against; a mismatch means a lost update. */
  readonly expectedAssetId: string | null;
}

export interface ReplacedScene {
  readonly id: string;
  readonly scene_no: string;
  readonly position: number;
  readonly asset_id: string;
  readonly image_prompt: string | null;
  readonly revision: number;
}

export interface SceneImageReplacementResult extends AssetUpsertResult {
  readonly previous_asset_id: string | null;
  readonly scene: ReplacedScene;
}

/**
 * Persist a replacement image, repoint the scene at it, and keep the old asset.
 *
 * One transaction: the scene row is locked FOR UPDATE (two replaces cannot both
 * "win"), the asset row is inserted or reused by content hash (R-026-1), the
 * scene is repointed, and `generation_run.asset_id` is linked — the reverse edge
 * of the circular FK. The superseded asset is deliberately **not** deleted: it
 * stays a content-addressed row (and object) and becomes discoverable as
 * orphaned through findOrphanedSceneImages()/`scene.asset_id <> asset.id`
 * (R-025 retention decides when it may go, which is Milestone B).
 */
export async function replaceSceneImage(
  pool: Pool,
  input: SceneImageReplacement,
): Promise<SceneImageReplacementResult> {
  return withTransaction(pool, async (client) => {
    const locked = await client.query<{
      id: string;
      scene_no: string;
      position: number;
      asset_id: string | null;
    }>('SELECT id, scene_no, position, asset_id FROM scene WHERE id = $1 FOR UPDATE', [
      input.sceneId,
    ]);
    const scene = locked.rows[0];
    if (scene === undefined) {
      throw new Error(
        'scene ' + input.sceneId + ' does not exist; an image cannot be replaced on it',
      );
    }
    if (scene.asset_id !== input.expectedAssetId) {
      throw new SceneAssetConflictError(input.sceneId, input.expectedAssetId, scene.asset_id);
    }

    const upsert = await insertOrReuseAsset(client, input);
    // `revision` is the prompt-edit lock (R-024) and was bumped by
    // lockSceneForReplace() when the operator supplied a new prompt; the image
    // swap itself is recorded by asset_id + the asset row's created_at.
    const updated = await client.query<ReplacedScene>(
      'UPDATE scene SET asset_id = $2 WHERE id = $1 ' +
        'RETURNING id, scene_no, position, asset_id, image_prompt, revision',
      [scene.id, upsert.asset.id],
    );
    const replaced = updated.rows[0];
    if (replaced === undefined) throw new Error('scene replace update returned no row');

    if (input.generationRunId !== undefined && input.generationRunId !== null) {
      await client.query(
        'UPDATE generation_run SET asset_id = COALESCE(asset_id, $2) WHERE id = $1',
        [input.generationRunId, upsert.asset.id],
      );
    }
    return { ...upsert, previous_asset_id: scene.asset_id, scene: replaced };
  });
}

export interface OrphanedSceneImage {
  readonly asset_id: string;
  readonly scene_id: string;
  readonly scene_no: string;
  readonly content_sha256: string;
  readonly object_key: string;
  readonly created_at: Date;
}

/**
 * Superseded scene images: IM assets whose scene now points at a different
 * image. This is the "orphaned but retained" set of a per-scene replace — the
 * rows and blobs still exist (R-026 dedupe keeps them addressable, R-025
 * retention decides later whether they may be cleaned up), they are simply no
 * longer the scene's current image. Derived from the scene↔asset invariant, so
 * there is no second flag that can drift from `scene.asset_id`.
 */
export async function findOrphanedSceneImages(
  db: Queryable,
  projectId: string,
): Promise<OrphanedSceneImage[]> {
  const result = await db.query<OrphanedSceneImage>(
    'SELECT a.id AS asset_id, a.scene_id, s.scene_no, a.content_sha256, a.object_key, a.created_at ' +
      'FROM asset a JOIN scene s ON s.id = a.scene_id ' +
      "WHERE a.project_id = $1 AND a.stage = 'IM' AND s.asset_id IS DISTINCT FROM a.id " +
      'ORDER BY a.created_at ASC, a.id ASC',
    [projectId],
  );
  return result.rows;
}
