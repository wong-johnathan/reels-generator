/**
 * Fixtures for the RE / QC / EX stage tests (B-12).
 *
 * `seedProject` builds the operator → series → series_version → project → job
 * chain; the stage workers additionally need the `video_stage` rows the state
 * machine guards, scenes that already carry an image asset, a narration asset
 * and a TC timing document. All raw SQL, for the same reason the existing
 */
import type { Pool } from 'pg';

import { withTransaction } from '../../src/db/client.js';
import {
  insertOrReuseAsset,
  linkAssetToProject,
  type AssetKind,
  type AssetStage,
} from '../../src/db/repositories/assets.js';
import { FakeFfmpegRunner } from '../../src/render/fake-ffmpeg.js';
import type { RenderManifest } from '../../src/render/render.js';
import {
  objectKeyFor,
  sha256Hex,
  type ContentAddressedStore,
} from '../../src/storage/object-store.js';
import { seedProject } from './fixtures.js';
import { insertScenes, insertStageJob, insertVideoStage } from './stage-fixtures.js';

export const RENDER_SCENES = ['S01', 'S02', 'S03'] as const;

/** Scene narration spans: 2.0 s, 2.5 s, 3.1 s — 7.6 s of narration. */
export const SPANS_MS: readonly (readonly [number, number])[] = [
  [0, 2000],
  [2000, 4500],
  [4500, 7600],
];

export const BAND = { target_s: 8.6, tolerance_s: 1, min_s: 7.6, max_s: 9.6, within_band: true };

export interface StoredAssetInput {
  readonly projectId: string;
  readonly stage: AssetStage;
  readonly kind: AssetKind;
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly role?: string;
  readonly seriesVersionId?: string | null;
  readonly width?: number;
  readonly height?: number;
  readonly rightsMetadata?: Record<string, unknown>;
}

export async function storeAsset(
  pool: Pool,
  blobs: ContentAddressedStore,
  input: StoredAssetInput,
): Promise<string> {
  const sha = sha256Hex(input.bytes);
  await blobs.put(objectKeyFor(sha), input.bytes, input.mimeType);
  const recorded = await withTransaction(pool, async (client) => {
    const inserted = await insertOrReuseAsset(client, {
      projectId: input.projectId,
      stage: input.stage,
      kind: input.kind,
      contentSha256: sha,
      objectSizeBytes: input.bytes.byteLength,
      mimeType: input.mimeType,
      width: input.width ?? null,
      height: input.height ?? null,
      seriesVersionId: input.seriesVersionId ?? null,
      rightsMetadata: input.rightsMetadata ?? { role: input.role ?? input.kind },
    });
    await linkAssetToProject(client, {
      assetId: inserted.asset.id,
      projectId: input.projectId,
      role: input.role ?? input.kind,
    });
    return inserted;
  });
  return recorded.asset.id;
}

export interface RenderFixture {
  readonly operatorId: string;
  readonly seriesId: string;
  readonly seriesVersionId: string;
  readonly projectId: string;
  readonly reJobId: string;
  readonly qcJobId: string;
  readonly exJobId: string;
  readonly sceneIds: Record<string, string>;
  readonly narrationAssetId: string;
  readonly timingAssetId: string;
  readonly imageAssetIds: readonly string[];
}
/** A project sitting at `current_stage = 'RE'` with everything the render needs. */
export async function seedRenderReadyProject(
  pool: Pool,
  blobs: ContentAddressedStore,
): Promise<RenderFixture> {
  const seeded = await seedProject(pool);
  await insertVideoStage(pool, seeded.projectId, 'RE');
  await insertVideoStage(pool, seeded.projectId, 'QC');
  await insertVideoStage(pool, seeded.projectId, 'EX');
  await insertVideoStage(pool, seeded.projectId, 'FA');

  const reJobId = await insertStageJob(pool, seeded.projectId, 'RE', 'running');
  const qcJobId = await insertStageJob(pool, seeded.projectId, 'QC');
  const exJobId = await insertStageJob(pool, seeded.projectId, 'EX');

  const sceneIds = await insertScenes(pool, seeded.projectId, RENDER_SCENES);
  const imageAssetIds: string[] = [];
  for (const sceneNo of RENDER_SCENES) {
    const assetId = await storeAsset(pool, blobs, {
      projectId: seeded.projectId,
      stage: 'IM',
      kind: 'image',
      bytes: new TextEncoder().encode('image-bytes-' + seeded.projectId + '-' + sceneNo),
      mimeType: 'image/png',
      seriesVersionId: seeded.seriesVersionId,
      width: 768,
      height: 1376,
    });
    await pool.query('UPDATE scene SET asset_id = $1 WHERE id = $2', [assetId, sceneIds[sceneNo]]);
    imageAssetIds.push(assetId);
  }

  const narrationAssetId = await storeAsset(pool, blobs, {
    projectId: seeded.projectId,
    stage: 'NA',
    kind: 'audio',
    bytes: new TextEncoder().encode('narration-bytes-' + seeded.projectId),
    mimeType: 'audio/mp4',
    seriesVersionId: seeded.seriesVersionId,
  });

  const words = [
    { word: 'the', start_ms: 0, end_ms: 140 },
    { word: 'quiet', start_ms: 160, end_ms: 380 },
    { word: 'machine', start_ms: 380, end_ms: 700 },
    { word: 'counts', start_ms: 2100, end_ms: 2400 },
    { word: 'every', start_ms: 2400, end_ms: 2700 },
    { word: 'minute', start_ms: 2700, end_ms: 3100 },
    { word: 'you', start_ms: 4600, end_ms: 4800 },
    { word: 'spend', start_ms: 4800, end_ms: 5100 },
    { word: 'looking', start_ms: 5100, end_ms: 5500 },
  ];
  const timingDocument = {
    schema_version: 'timing.v1',
    project_id: seeded.projectId,
    target_duration_s: 8.6,
    narration: {
      asset_id: narrationAssetId,
      alignment_asset_id: narrationAssetId,
      duration_s: 7.6,
      provider: 'fake',
      model: 'fake-alignment',
      provider_request_id: null,
    },
    lead_s: 0.5,
    trail_s: 0.5,
    final_audio_duration_s: 8.6,
    band: BAND,
    word_count: words.length,
    words,
    scenes: RENDER_SCENES.map((sceneNo, index) => ({
      scene_no: sceneNo,
      position: index + 1,
      start_ms: SPANS_MS[index]![0],
      end_ms: SPANS_MS[index]![1],
      duration_s: (SPANS_MS[index]![1] - SPANS_MS[index]![0]) / 1000,
    })),
  };
  const timingAssetId = await storeAsset(pool, blobs, {
    projectId: seeded.projectId,
    stage: 'NA',
    kind: 'sidecar',
    bytes: new TextEncoder().encode(JSON.stringify(timingDocument)),
    mimeType: 'application/json',
    seriesVersionId: seeded.seriesVersionId,
    rightsMetadata: { stage: 'TC', role: 'timing-document' },
  });

  await pool.query(`UPDATE project SET current_stage = 'RE' WHERE id = $1`, [seeded.projectId]);

  return {
    ...seeded,
    reJobId,
    qcJobId,
    exJobId,
    sceneIds,
    narrationAssetId,
    timingAssetId,
    imageAssetIds,
  };
}

/**
 * A fake runner that satisfies RE (writes a stand-in MP4) and then a QC pass
 * driven by the manifest the render actually produced.
 */
export function fakeForManifest(
  manifest: RenderManifest,
  overrides: {
    readonly luminance?: number[];
    readonly captionRegions?: { outside: number; inside: number };
    readonly probe?: ReturnType<typeof fakeProbeForManifest>;
  } = {},
): FakeFfmpegRunner {
  return new FakeFfmpegRunner({
    outputFile: 'output.mp4',
    outputBytes: new TextEncoder().encode('fake-mp4-bytes'),
    probe: overrides.probe ?? fakeProbeForManifest(manifest),
    luminance: overrides.luminance ?? Array.from({ length: manifest.total_frames }, () => 120),
    captionRegions: overrides.captionRegions ?? { outside: 0, inside: 255 },
  });
}

export function fakeProbeForManifest(manifest: RenderManifest) {
  const duration = (manifest.duration_ms / 1000).toFixed(3);
  return {
    streams: [
      {
        index: 0,
        codec_type: 'video',
        codec_name: 'h264',
        width: manifest.width,
        height: manifest.height,
        r_frame_rate: `${manifest.fps}/1`,
        avg_frame_rate: `${manifest.fps}/1`,
        duration,
        sample_rate: null,
        nb_frames: null,
        channels: null,
      },
      {
        index: 1,
        codec_type: 'audio',
        codec_name: 'aac',
        width: null,
        height: null,
        r_frame_rate: null,
        avg_frame_rate: null,
        duration,
        sample_rate: '48000',
        nb_frames: null,
        channels: 2,
      },
    ],
    chapters: manifest.scenes.map((scene, index) => ({
      id: index,
      start_time: (scene.start_ms / 1000).toFixed(3),
      end_time: (scene.end_ms / 1000).toFixed(3),
      tags: { title: scene.scene_no },
    })),
    format: { duration, size: '1024', format_name: 'mov,mp4,m4a' },
  };
}
