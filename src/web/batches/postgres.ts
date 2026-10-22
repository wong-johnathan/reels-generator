/**
 * The Batches page (nav key `batches`).
 *
 * The navigation has linked to `/batches` since the shell was written, but no
 * route existed: the link fell through to the authenticated 404. This is the
 * read model behind it — every batch, newest first, with its videos and whether
 * each one has a rendered MP4 to download.
 */
import type { Queryable } from '../../db/client.js';

export interface BatchVideo {
  readonly projectId: string;
  readonly position: number;
  readonly status: string;
  readonly currentStage: string | null;
  readonly videoAssetId: string | null;
}

export interface BatchSummary {
  readonly id: string;
  readonly ordinal: number;
  readonly status: string;
  readonly targetCount: number;
  readonly createdAt: string;
  readonly seriesId: string;
  readonly seriesName: string;
  readonly seriesSlug: string;
  readonly videos: readonly BatchVideo[];
}

export const EMPTY_BATCHES: readonly BatchSummary[] = [];

/** Newest batch first; videos in their position order. */
export async function loadBatches(db: Queryable): Promise<readonly BatchSummary[]> {
  const batches = await db.query<{
    id: string;
    ordinal: number;
    status: string;
    target_count: number;
    created_at: Date | string;
    series_id: string;
    series_name: string;
    series_slug: string;
  }>(/* sql */ `
    SELECT b.id, b.ordinal, b.status, b.target_count, b.created_at,
           s.id AS series_id, s.name AS series_name, s.slug AS series_slug
      FROM batch b
      JOIN series s ON s.id = b.series_id
     ORDER BY b.created_at DESC, b.ordinal DESC`);

  if (batches.rows.length === 0) return EMPTY_BATCHES;

  const videos = await db.query<{
    batch_id: string;
    id: string;
    position_in_batch: number;
    status: string;
    current_stage: string | null;
    video_asset_id: string | null;
  }>(/* sql */ `
    SELECT p.batch_id, p.id, p.position_in_batch, p.status, p.current_stage,
           (SELECT a.id
              FROM asset a
              JOIN asset_ref r ON r.asset_id = a.id
             WHERE r.project_id = p.id AND r.role = 'video' AND a.stage = 'RE'
             ORDER BY a.created_at DESC
             LIMIT 1) AS video_asset_id
      FROM project p
     ORDER BY p.position_in_batch ASC`);

  const byBatch = new Map<string, BatchVideo[]>();
  for (const row of videos.rows) {
    const list = byBatch.get(row.batch_id) ?? [];
    list.push({
      projectId: row.id,
      position: row.position_in_batch,
      status: row.status,
      currentStage: row.current_stage,
      videoAssetId: row.video_asset_id,
    });
    byBatch.set(row.batch_id, list);
  }

  return batches.rows.map((row) => ({
    id: row.id,
    ordinal: row.ordinal,
    status: row.status,
    targetCount: row.target_count,
    createdAt: new Date(row.created_at).toISOString(),
    seriesId: row.series_id,
    seriesName: row.series_name,
    seriesSlug: row.series_slug,
    videos: byBatch.get(row.id) ?? [],
  }));
}
