import type { Pool } from 'pg';
import { afterEach, expect, it, vi } from 'vitest';

import { createPostgresSceneGateway } from './postgres.js';

const id = '00000000-0000-4000-8000-000000000001';
afterEach(() => vi.unstubAllEnvs());

it.each(['https://minio.example/', undefined])(
  'scene reads select the stored key and expose public original with endpoint %s',
  async (endpoint) => {
    vi.stubEnv('MINIO_PUBLIC_ENDPOINT', endpoint);
    vi.stubEnv('MINIO_BUCKET', 'configured-images');
    const query = vi.fn(async (sql: string) => {
      if (!sql.startsWith('SELECT')) return { rows: [] };
      expect(sql).toContain('a.object_key AS asset_object_key');
      return {
        rows: [
          {
            id,
            scene_no: 'S01',
            position: 1,
            narration_start_ms: null,
            narration_end_ms: null,
            image_prompt: 'fixture',
            camera_move: 'static',
            caption_emphasis: null,
            fallback_text: null,
            uses_protagonist: false,
            revision: 1,
            asset_id: id,
            asset_object_key: 'images/scene one.png',
            asset_stage: 'IM',
            asset_kind: 'image',
            asset_width: 1024,
            asset_height: 1024,
            asset_size_bytes: '123',
            asset_sha256: 'a'.repeat(64),
            asset_provider: null,
            asset_model: null,
            asset_prompt_hash: null,
            asset_prompt_text: null,
            asset_seed: null,
            asset_series_version_id: null,
            asset_series_version: null,
            asset_created_at: new Date('2026-01-01T00:00:00Z'),
          },
        ],
      };
    });
    const client = { query, release: vi.fn() };
    const pool = { connect: async () => client } as unknown as Pool;
    const scene = await createPostgresSceneGateway(pool).scene(id, id);
    expect(scene?.asset?.public_url).toBe(
      endpoint ? 'https://minio.example/configured-images/images/scene%20one.png' : null,
    );
    expect(scene?.asset?.urls).toEqual({
      thumb: `/asset/${id}/thumb`,
      detail: `/asset/${id}/detail`,
      full: `/asset/${id}/full`,
    });
  },
);
