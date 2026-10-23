import { describe, expect, it } from 'vitest';

import { createPostgresAssetProxyGateway } from './proxy.js';

const ASSET_ID = '2abdea3d-3188-4f02-b584-bf14fb4e025a';

function queryable(rows: readonly unknown[]) {
  return {
    query: async () => ({ rows }),
  } as never;
}

describe('asset proxy gateway', () => {
  it('resolves an asset row and serves the stored bytes with its MIME type', async () => {
    const bytes = Uint8Array.from([0x00, 0x01, 0x02]);
    const gateway = createPostgresAssetProxyGateway(
      queryable([
        {
          object_key: 'series/batch-0001/scenes/S01.png',
          mime_type: 'image/png',
          content_sha256: 'a'.repeat(64),
        },
      ]),
      {
        get: async (key: string) =>
          key === 'series/batch-0001/scenes/S01.png'
            ? { bytes, mimeType: 'application/octet-stream' }
            : null,
      } as never,
    );

    await expect(gateway.get(ASSET_ID, 'thumb')).resolves.toEqual({
      bytes,
      mimeType: 'image/png',
      etag: '"' + 'a'.repeat(64) + '"',
    });
  });

  it('returns null when the database row or object is missing', async () => {
    const missingRow = createPostgresAssetProxyGateway(queryable([]), {
      get: async () => null,
    } as never);
    await expect(missingRow.get(ASSET_ID, 'full')).resolves.toBeNull();

    const missingObject = createPostgresAssetProxyGateway(
      queryable([
        {
          object_key: 'missing.mp4',
          mime_type: 'video/mp4',
          content_sha256: 'b'.repeat(64),
        },
      ]),
      { get: async () => null } as never,
    );
    await expect(missingObject.get(ASSET_ID, 'full')).resolves.toBeNull();
  });
});
