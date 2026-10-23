import type { Queryable } from '../../db/client.js';
import { sha256Hex, type ContentAddressedStore } from '../../storage/object-store.js';

export const ASSET_VARIANTS = ['thumb', 'detail', 'full'] as const;
export type AssetVariant = (typeof ASSET_VARIANTS)[number];

export interface AssetProxyFile {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly etag: string;
}

export interface AssetProxyGateway {
  /** The current variants address the same persisted object; resizing is a later concern. */
  get(assetId: string, variant: AssetVariant): Promise<AssetProxyFile | null>;
}

interface AssetProxyRow {
  readonly object_key: string;
  readonly mime_type: string | null;
  readonly content_sha256: string | null;
}

/** Resolve the asset id through Postgres, then stream the persisted MinIO object. */
export function createPostgresAssetProxyGateway(
  db: Queryable,
  blobs: ContentAddressedStore,
): AssetProxyGateway {
  return {
    async get(assetId: string, _variant: AssetVariant): Promise<AssetProxyFile | null> {
      const result = await db.query<AssetProxyRow>(
        `SELECT object_key, mime_type, content_sha256
           FROM asset
          WHERE id = $1
          LIMIT 1`,
        [assetId],
      );
      const row = result.rows[0];
      if (row === undefined) return null;

      const stored = await blobs.get(row.object_key);
      if (stored === null) return null;

      const digest = row.content_sha256 ?? sha256Hex(stored.bytes);
      return {
        bytes: stored.bytes,
        mimeType: row.mime_type ?? stored.mimeType,
        etag: '"' + digest + '"',
      };
    },
  };
}
