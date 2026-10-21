/**
 * Postgres-backed `VideoDownloadGateway`.
 *
 * The final video is the newest RE `video` asset linked to the project through
 * `asset_ref.role = 'video'` — the same resolution the render gateway and the
 * export stage use, so the download cannot disagree with either about which MP4
 * is "the" render. The filename is derived from the series slug and the video's
 * 1-indexed `position_in_batch` (NULL for the Milestone-A single-video slice,
 * which downloads as position 1).
 */
import type { Pool } from 'pg';

import type { ContentAddressedStore } from '../../storage/object-store.js';
import type { VideoDownloadFile, VideoDownloadGateway } from './gateway.js';

/**
 * A safe `Content-Disposition` filename: lower-case, no whitespace or quoting,
 * and a sensible fallback rather than an empty stem. The series slug is already
 * a validated slug in the database; this is defence-in-depth so a header value
 * can never carry a CR/LF or quote.
 */
export function downloadFilename(slug: string, position: number): string {
  const safe =
    slug
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'series';
  return safe + '-' + position + '.mp4';
}

export function createPostgresDownloadGateway(
  pool: Pool,
  blobs: ContentAddressedStore,
): VideoDownloadGateway {
  return {
    async download(videoId: string): Promise<VideoDownloadFile | null> {
      const result = await pool.query<{
        object_key: string;
        mime_type: string | null;
        slug: string;
        position_in_batch: number | null;
      }>(
        `SELECT a.object_key, a.mime_type, s.slug, p.position_in_batch
           FROM asset a
           JOIN asset_ref r ON r.asset_id = a.id AND r.role = 'video'
           JOIN project p ON p.id = r.project_id
           JOIN series s ON s.id = p.series_id
          WHERE r.project_id = $1 AND a.stage = 'RE' AND a.kind = 'video'
          ORDER BY r.created_at DESC, a.id DESC
          LIMIT 1`,
        [videoId],
      );
      const row = result.rows[0];
      if (row === undefined) return null;

      const stored = await blobs.get(row.object_key);
      if (stored === null) return null;

      return {
        bytes: stored.bytes,
        mimeType: row.mime_type ?? stored.mimeType,
        filename: downloadFilename(row.slug, row.position_in_batch ?? 1),
      };
    },
  };
}
