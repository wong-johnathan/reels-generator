/**
 * Postgres-backed `NarrationGateway`.
 *
 * Reads a narration "take" as the latest NA audio asset linked to the project
 * (`asset_ref.role = 'narration'`). Everything the contract asks for that
 * lives inside the alignment sidecar blob (duration, per-word timings) has no
 * column, so it is reported as the documented empty rather than invented:
 * `duration_s` is null, `word_count` is 0 and `words` is `[]`. The audio's own
 * provenance columns (provider, model, request id) still surface the take's
 * provenance in `alignment`.
 *
 * `rerun` is a write that needs a queue (BullMQ) to enqueue a TTS job; the
 * factory only holds a `pg` Pool, so it refuses with an honest reason instead
 * of pretending to have re-run anything.
 */
import type { Pool } from 'pg';

import { timingBand } from '../../workers/timing-stage.js';
import { ASSET_VIEW_FIELDS, assetView, type AssetViewRow } from '../gateways/asset-view.js';
import { NarrationRefusedError, type NarrationGateway, type NarrationView } from './gateway.js';

export function createPostgresNarrationGateway(pool: Pool): NarrationGateway {
  async function stageState(videoId: string, stage: string): Promise<string | null> {
    const result = await pool.query<{ state: string }>(
      'SELECT state FROM video_stage WHERE project_id = $1 AND stage = $2',
      [videoId, stage],
    );
    return result.rows[0]?.state ?? null;
  }

  async function narrationAudio(videoId: string): Promise<AssetViewRow | null> {
    const result = await pool.query<AssetViewRow>(
      `SELECT ${ASSET_VIEW_FIELDS}
         FROM asset a
         JOIN asset_ref r ON r.asset_id = a.id AND r.role = 'narration'
         LEFT JOIN series_version sv ON sv.id = a.series_version_id
        WHERE r.project_id = $1 AND a.stage = 'NA' AND a.kind = 'audio'
        ORDER BY r.created_at DESC, a.id DESC
        LIMIT 1`,
      [videoId],
    );
    return result.rows[0] ?? null;
  }

  async function targetDuration(videoId: string): Promise<number> {
    const result = await pool.query<{ target: number | null }>(
      `SELECT COALESCE(p.target_duration_s, s.target_duration_s) AS target
         FROM project p
         JOIN series s ON s.id = p.series_id
        WHERE p.id = $1`,
      [videoId],
    );
    return result.rows[0]?.target ?? 75;
  }

  return {
    async get(videoId: string): Promise<NarrationView | null> {
      const [audio, target, state] = await Promise.all([
        narrationAudio(videoId),
        targetDuration(videoId),
        stageState(videoId, 'NA'),
      ]);
      if (audio === null) return null;

      const band = timingBand(target);
      const alignment =
        audio.provider !== null && audio.model !== null
          ? { provider: audio.provider, model: audio.model, request_id: audio.provider_request_id }
          : null;

      return {
        status: (state ?? 'done') as NarrationView['status'],
        asset: assetView(audio),
        duration_s: null,
        target_duration_s: target,
        band: { min_s: band.min_s, max_s: band.max_s, within_band: false },
        word_count: 0,
        words: [],
        alignment,
        accepted_at: null,
      };
    },

    async rerun(videoId: string): Promise<{ queued: boolean }> {
      const [audio, state] = await Promise.all([
        narrationAudio(videoId),
        stageState(videoId, 'NA'),
      ]);
      if (audio === null) {
        throw new NarrationRefusedError('No narration has run for this video.');
      }
      if (state === 'running') {
        throw new NarrationRefusedError('Narration is already running.');
      }
      throw new NarrationRefusedError(
        'Re-running narration is not wired in this deployment: the page gateway has no ' +
          'queue to enqueue a TTS job, so nothing was re-run.',
      );
    },
  };
}
