/**
 * Postgres-backed `ExportGateway`.
 *
 * An export "package" is the set of EX sidecar assets (metadata.json,
 * sources.json, package-manifest.json) plus the render's content-addressed
 * video/caption assets they package (R-026 reuses the same rows). `get` always
 * returns a view: `status` is the EX stage state, `files` is empty until the
 * package-manifest sidecar exists, and `pins` is the per-stage
 * `video_stage.series_version_id` snapshot (R-002-4).
 *
 * `build` is a write that needs a queue and a blob store to actually run the
 * export; this factory holds only a `pg` Pool, so it refuses with an honest
 * reason. The refusal still enforces the real gate ordering — final approval
 * first, a render second — so a hand-rolled POST is refused for the same
 * reasons the worker would refuse it.
 */
import type { Pool } from 'pg';

import { STAGE_ORDER, type StageCode } from '../../shared/stages.js';
import { ExportRefusedError, type ExportGateway, type ExportView } from './gateway.js';

interface ReAssetRow {
  readonly id: string;
  readonly role: string;
  readonly size_bytes: string | number | null;
  readonly sha256: string;
}

interface ExSidecarRow {
  readonly id: string;
  readonly size_bytes: string | number | null;
  readonly sha256: string;
  readonly created_at: Date;
  readonly name: string | null;
  readonly package_stem: string | null;
}

interface PinRow {
  readonly stage: string;
  readonly series_version_id: string | null;
  readonly series_version: number | null;
}

function sizeBytes(value: string | number | null): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function fullUrl(id: string): string {
  return '/asset/' + id + '/full';
}

export function createPostgresExportGateway(pool: Pool): ExportGateway {
  async function stageState(videoId: string, stage: string): Promise<string | null> {
    const result = await pool.query<{ state: string }>(
      'SELECT state FROM video_stage WHERE project_id = $1 AND stage = $2',
      [videoId, stage],
    );
    return result.rows[0]?.state ?? null;
  }

  async function reAssets(videoId: string): Promise<Map<string, ReAssetRow>> {
    const result = await pool.query<ReAssetRow>(
      `SELECT a.id, r.role, a.object_size_bytes AS size_bytes, a.content_sha256 AS sha256
         FROM asset a
         JOIN asset_ref r ON r.asset_id = a.id
        WHERE r.project_id = $1 AND a.stage = 'RE' AND r.role IN ('video', 'srt', 'vtt')
        ORDER BY r.created_at DESC, a.id DESC`,
      [videoId],
    );
    const byRole = new Map<string, ReAssetRow>();
    for (const row of result.rows) if (!byRole.has(row.role)) byRole.set(row.role, row);
    return byRole;
  }

  async function exSidecars(videoId: string): Promise<ExSidecarRow[]> {
    const result = await pool.query<{
      id: string;
      size_bytes: string | null;
      sha256: string;
      created_at: Date;
      rights_metadata: unknown;
    }>(
      `SELECT a.id, a.object_size_bytes AS size_bytes, a.content_sha256 AS sha256,
              a.created_at, a.rights_metadata
         FROM asset a
         JOIN asset_ref r ON r.asset_id = a.id
        WHERE r.project_id = $1 AND a.stage = 'EX' AND a.kind = 'sidecar'
        ORDER BY r.created_at ASC, a.id ASC`,
      [videoId],
    );
    return result.rows.map((row) => {
      const meta = (row.rights_metadata ?? {}) as {
        name?: unknown;
        package_stem?: unknown;
      };
      return {
        id: row.id,
        size_bytes: row.size_bytes,
        sha256: row.sha256,
        created_at: row.created_at,
        name: typeof meta.name === 'string' ? meta.name : null,
        package_stem: typeof meta.package_stem === 'string' ? meta.package_stem : null,
      };
    });
  }

  async function pins(videoId: string): Promise<PinRow[]> {
    const result = await pool.query<PinRow>(
      `SELECT vs.stage, vs.series_version_id, sv.version AS series_version
         FROM video_stage vs
         LEFT JOIN series_version sv ON sv.id = vs.series_version_id
        WHERE vs.project_id = $1 AND vs.series_version_id IS NOT NULL`,
      [videoId],
    );
    return result.rows.sort(
      (left, right) =>
        (STAGE_ORDER[left.stage as StageCode] ?? 99) -
        (STAGE_ORDER[right.stage as StageCode] ?? 99),
    );
  }

  async function loadView(videoId: string): Promise<ExportView> {
    const [state, renderAssets, sidecars, stagePins] = await Promise.all([
      stageState(videoId, 'EX'),
      reAssets(videoId),
      exSidecars(videoId),
      pins(videoId),
    ]);

    const manifest = sidecars.find((sidecar) => sidecar.name === 'package-manifest.json');
    const stem = sidecars.find((sidecar) => sidecar.package_stem !== null)?.package_stem ?? null;

    const files: ExportView['files'] = [];
    if (manifest !== undefined && stem !== null) {
      const video = renderAssets.get('video');
      const srt = renderAssets.get('srt');
      const vtt = renderAssets.get('vtt');
      if (video !== undefined) {
        files.push({
          name: stem + '.mp4',
          kind: 'video',
          size_bytes: sizeBytes(video.size_bytes),
          sha256: video.sha256,
          url: fullUrl(video.id),
        });
      }
      if (srt !== undefined) {
        files.push({
          name: stem + '.srt',
          kind: 'srt',
          size_bytes: sizeBytes(srt.size_bytes),
          sha256: srt.sha256,
          url: fullUrl(srt.id),
        });
      }
      if (vtt !== undefined) {
        files.push({
          name: stem + '.vtt',
          kind: 'vtt',
          size_bytes: sizeBytes(vtt.size_bytes),
          sha256: vtt.sha256,
          url: fullUrl(vtt.id),
        });
      }
      for (const sidecar of sidecars) {
        if (sidecar.name === 'metadata.json') {
          files.push({
            name: 'metadata.json',
            kind: 'sidecar',
            size_bytes: sizeBytes(sidecar.size_bytes),
            sha256: sidecar.sha256,
            url: fullUrl(sidecar.id),
          });
        } else if (sidecar.name === 'sources.json') {
          files.push({
            name: 'sources.json',
            kind: 'manifest',
            size_bytes: sizeBytes(sidecar.size_bytes),
            sha256: sidecar.sha256,
            url: fullUrl(sidecar.id),
          });
        }
      }
    }

    return {
      status: (state ?? 'not_run') as ExportView['status'],
      package_built_at: manifest?.created_at.toISOString() ?? null,
      files,
      total_bytes: files.reduce((total, file) => total + file.size_bytes, 0),
      pins: stagePins.map((pin) => ({
        stage: pin.stage as StageCode,
        series_version: pin.series_version,
        series_version_id: pin.series_version_id,
      })),
      manifest: null,
    };
  }

  return {
    async get(videoId: string): Promise<ExportView | null> {
      return loadView(videoId);
    },

    async build(videoId: string): Promise<ExportView> {
      const approval = await pool.query(
        `SELECT 1 FROM review_decision
          WHERE project_id = $1 AND stage = 'FA' AND decision = 'approve'
          LIMIT 1`,
        [videoId],
      );
      if ((approval.rowCount ?? 0) === 0) {
        throw new ExportRefusedError(
          'Export is blocked: final approval is required first. Nothing was built.',
        );
      }

      const video = await pool.query(
        `SELECT 1 FROM asset a
           JOIN asset_ref r ON r.asset_id = a.id
          WHERE r.project_id = $1 AND a.stage = 'RE' AND a.kind = 'video' AND r.role = 'video'
          LIMIT 1`,
        [videoId],
      );
      if ((video.rowCount ?? 0) === 0) {
        throw new ExportRefusedError(
          'No render has run for this video, so there is nothing to package. Nothing was built.',
        );
      }

      throw new ExportRefusedError(
        'Building the package is not wired in this deployment: the page gateway has no ' +
          'queue or blob store to run the export, so nothing was built.',
      );
    },
  };
}
