import { afterEach, describe, expect, it, vi } from 'vitest';

import { AssetViewSchema } from '../../../contract/api.js';
import { validateEnv } from '../../config/env.js';
import { ASSET_VIEW_FIELDS, assetView, type AssetViewRow } from './asset-view.js';

const row = {
  id: '00000000-0000-4000-8000-000000000001',
  object_key: 'images/scene one/a+b?#%.png',
  stage: 'IM',
  kind: 'image',
  width: 1024,
  height: 1024,
  object_size_bytes: '123',
  content_sha256: 'a'.repeat(64),
  provider: null,
  model: null,
  provider_request_id: null,
  prompt_hash: null,
  prompt_text: null,
  seed: null,
  series_version_id: null,
  rights_metadata: null,
  created_at: new Date('2026-01-01T00:00:00Z'),
  series_version: null,
} satisfies AssetViewRow;

const proxyUrls = {
  thumb: `/asset/${row.id}/thumb`,
  detail: `/asset/${row.id}/detail`,
  full: `/asset/${row.id}/full`,
};

afterEach(() => vi.unstubAllEnvs());

describe('asset public URLs', () => {
  it('selects the persisted key in shared asset reads', () => {
    expect(ASSET_VIEW_FIELDS).toContain('a.object_key');
  });

  it.each(['https://minio.johnathanwwh.com', 'https://minio.johnathanwwh.com/'])(
    'joins %s with the configured bucket and escaped object-key segments',
    (endpoint) => {
      vi.stubEnv('MINIO_PUBLIC_ENDPOINT', endpoint);
      vi.stubEnv('MINIO_BUCKET', 'configured-bucket');
      const view = assetView(row);
      expect(view.public_url).toBe(
        'https://minio.johnathanwwh.com/configured-bucket/images/scene%20one/a%2Bb%3F%23%25.png',
      );
      expect(view.urls).toEqual(proxyUrls);
      expect(AssetViewSchema.parse(view)).toEqual(view);
    },
  );

  it.each([undefined, '', '   '])('keeps proxy fallback when endpoint is %s', (endpoint) => {
    vi.stubEnv('MINIO_PUBLIC_ENDPOINT', endpoint);
    expect(assetView(row).public_url).toBeNull();
    expect(assetView(row).urls).toEqual(proxyUrls);
    expect(
      validateEnv({ MINIO_PUBLIC_ENDPOINT: endpoint }, 'web').values.MINIO_PUBLIC_ENDPOINT,
    ).toBeUndefined();
  });

  it('normalizes joining slashes and escapes bucket segments without leaking credentials', () => {
    vi.stubEnv(
      'MINIO_PUBLIC_ENDPOINT',
      'https://user:secret@minio.example/base///?token=secret#secret',
    );
    vi.stubEnv('MINIO_BUCKET', 'bucket name');
    expect(assetView({ ...row, object_key: '/images//scene one.png' }).public_url).toBe(
      'https://minio.example/base/bucket%20name/images/scene%20one.png',
    );
  });
});
