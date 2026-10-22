/**
 * Postgres-backed `RenderGateway`.
 *
 * A render "output" is the RE video asset linked to the project
 * (`asset_ref.role = 'video'`); `get` returns null until one exists, and the
 * page falls back to the video-detail stage rows for the running/failed/empty
 * states. QC status is read straight from the QC stage row; the per-check list
 * lives inside the QC report blob, so it is reported empty rather than invented.
 *
 * `approve` is the one real write in this layer: it records the FA approval and
 * moves the FA stage `awaiting_approval → done` atomically, under a `FOR UPDATE`
 * lock, with the transition derived through `transitionStage` (the same guard
 * the workers use). The optimistic-lock `revision` is the number of renders —
 * one `asset_ref` row per render pass — so a re-render between page load and
 * approve is refused as stale. The note is kept in review_decision.reason,
 * including the auto_approve_all marker used by automatic confirmation.
 */
import type { Pool } from 'pg';

import { withTransaction, type Queryable } from '../../db/client.js';
import { recordReviewDecision } from '../../db/repositories/review-decisions.js';
import { insertQueuedJob } from '../../db/repositories/jobs.js';
import { setProjectCurrentStage } from '../../db/repositories/stage-state.js';
import { transitionStage } from '../../domain/state-machine.js';
import type { StageState } from '../../shared/index.js';
import { ASSET_VIEW_FIELDS, assetView, type AssetViewRow } from '../gateways/asset-view.js';
import {
  RenderNotFoundError,
  RenderRefusedError,
  type RenderGateway,
  type RenderView,
} from './gateway.js';

interface StageRow {
  readonly stage: string;
  readonly state: string;
  readonly last_event_at: Date | null;
}

export function createPostgresRenderGateway(pool: Pool): RenderGateway {
  async function stages(db: Queryable, videoId: string): Promise<Map<string, StageRow>> {
    const result = await db.query<StageRow>(
      `SELECT stage, state, last_event_at
         FROM video_stage
        WHERE project_id = $1 AND stage = ANY($2::text[])`,
      [videoId, ['RE', 'QC', 'FA']],
    );
    return new Map(result.rows.map((row) => [row.stage, row]));
  }

  async function latestAsset(
    db: Queryable,
    videoId: string,
    role: string,
  ): Promise<AssetViewRow | null> {
    const result = await db.query<AssetViewRow>(
      `SELECT ${ASSET_VIEW_FIELDS}
         FROM asset a
         JOIN asset_ref r ON r.asset_id = a.id AND r.role = $2
         LEFT JOIN series_version sv ON sv.id = a.series_version_id
        WHERE r.project_id = $1 AND a.stage = 'RE'
        ORDER BY r.created_at DESC, a.id DESC
        LIMIT 1`,
      [videoId, role],
    );
    return result.rows[0] ?? null;
  }

  async function latestApproval(
    db: Queryable,
    videoId: string,
  ): Promise<{ decided_at: Date } | null> {
    const result = await db.query<{ decided_at: Date }>(
      `SELECT decided_at
         FROM review_decision
        WHERE project_id = $1 AND stage = 'FA' AND decision = 'approve'
        ORDER BY decided_at DESC, id DESC
        LIMIT 1`,
      [videoId],
    );
    return result.rows[0] ?? null;
  }

  /** One `asset_ref` row per render pass (the render stage links on every run). */
  async function renderPassCount(db: Queryable, videoId: string): Promise<number> {
    const result = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM asset_ref
        WHERE project_id = $1 AND role = 'video'`,
      [videoId],
    );
    return result.rows[0]?.count ?? 0;
  }

  function renderStatus(state: string | null, approved: boolean): RenderView['status'] {
    if (approved) return 'done';
    switch (state) {
      case 'not_run':
        return 'not_run';
      case 'running':
        return 'running';
      case 'failed':
        return 'failed';
      case 'blocked':
        return 'blocked';
      case 'stale':
        return 'stale';
      case 'cancelled':
        return 'cancelled';
      case 'awaiting_approval':
      case 'done':
      default:
        return 'awaiting_approval';
    }
  }

  async function loadView(db: Queryable, videoId: string): Promise<RenderView | null> {
    const [stageRows, video, srt, vtt, approval] = await Promise.all([
      stages(db, videoId),
      latestAsset(db, videoId, 'video'),
      latestAsset(db, videoId, 'srt'),
      latestAsset(db, videoId, 'vtt'),
      latestApproval(db, videoId),
    ]);
    if (video === null) return null;

    const qc = stageRows.get('QC');
    const approved = approval !== null;
    const meta = video.rights_metadata as
      { wall_time_ms?: unknown; peak_ram_mb?: unknown } | null | undefined;

    return {
      status: renderStatus(stageRows.get('RE')?.state ?? null, approved),
      video: assetView(video),
      poster: null,
      captions: {
        srt: srt === null ? null : assetView(srt),
        vtt: vtt === null ? null : assetView(vtt),
      },
      render_passes: 1,
      wall_time_s: typeof meta?.wall_time_ms === 'number' ? meta.wall_time_ms / 1000 : null,
      peak_ram_mb: typeof meta?.peak_ram_mb === 'number' ? Math.round(meta.peak_ram_mb) : null,
      qc: {
        status: qc?.state === 'done' ? 'pass' : qc?.state === 'failed' ? 'fail' : 'not_run',
        checks: [],
        checked_at: qc?.last_event_at?.toISOString() ?? null,
      },
      approved,
      approved_at: approval?.decided_at.toISOString() ?? null,
    };
  }

  return {
    async get(videoId: string): Promise<RenderView | null> {
      return loadView(pool, videoId);
    },

    async revision(videoId: string): Promise<number | null> {
      const count = await renderPassCount(pool, videoId);
      return count === 0 ? null : count;
    },

    async approve(videoId: string, input): Promise<RenderView> {
      await withTransaction(pool, async (client) => {
        // Match the editor's project lock before inspecting revisions/stages.
        await client.query('SELECT id FROM project WHERE id = $1 FOR UPDATE', [videoId]);
        const fa = await client.query<{ id: string; state: string }>(
          `SELECT id, state
             FROM video_stage
            WHERE project_id = $1 AND stage = 'FA'
            FOR UPDATE`,
          [videoId],
        );
        const faRow = fa.rows[0];
        if (faRow === undefined) throw new RenderNotFoundError(videoId);

        if (faRow.state !== 'awaiting_approval') {
          throw new RenderRefusedError(
            'Final approval is not waiting: the final-approval stage is ' +
              faRow.state +
              '. Nothing was approved.',
          );
        }

        const passes = await renderPassCount(client, videoId);
        if (passes === 0) throw new RenderRefusedError('No render has run for this video.');
        if (passes !== input.revision) {
          throw new RenderRefusedError(
            'This page is out of date: the render revision is now ' +
              passes +
              '. Reload and re-read the QC results before approving. Nothing was approved.',
          );
        }

        const existing = await latestApproval(client, videoId);
        if (existing !== null) throw new RenderRefusedError('This render is already approved.');

        const qc = await client.query<{ state: string }>(
          `SELECT state FROM video_stage WHERE project_id = $1 AND stage = 'QC'`,
          [videoId],
        );
        if (qc.rows[0]?.state !== 'done') {
          throw new RenderRefusedError(
            'Final approval is blocked while QC fails. Nothing was approved.',
          );
        }

        const prerequisites = await client.query<{ stage: string; state: string }>(
          `SELECT stage, state FROM video_stage
            WHERE project_id = $1 AND stage NOT IN ('FA', 'EX') FOR UPDATE`,
          [videoId],
        );
        if (
          prerequisites.rows.find((row) => row.stage === 'RE')?.state !== 'done' ||
          prerequisites.rows.some((row) => row.state !== 'done' && row.state !== 'not_run')
        ) {
          throw new RenderRefusedError(
            'Final approval is blocked by an unfinished or stale stage.',
          );
        }
        // Validate deliverables BEFORE either the stage flip or the ledger write.
        for (const role of ['video', 'srt', 'vtt']) {
          if ((await latestAsset(client, videoId, role)) === null) {
            throw new RenderRefusedError('Final approval is blocked: missing ' + role + ' asset.');
          }
        }

        const next = transitionStage(faRow.state as StageState, 'approve');
        await client.query(
          `UPDATE video_stage
              SET state = $2, last_event = 'approve', last_event_at = now(), updated_at = now()
            WHERE id = $1`,
          [faRow.id, next],
        );
        await recordReviewDecision(client, {
          projectId: videoId,
          stage: 'FA',
          decision: 'approve',
          reason: input.note ?? null,
          revisionAtDecision: input.revision,
        });
        const queued = await client.query<{ id: string }>(
          `SELECT id FROM job WHERE project_id = $1 AND stage = 'EX'
            AND status IN ('queued', 'running') LIMIT 1`,
          [videoId],
        );
        if (queued.rows.length === 0) {
          await insertQueuedJob(client, { projectId: videoId, stage: 'EX', priority: 2 });
        }
        await setProjectCurrentStage(client, videoId, 'EX');
      });

      const view = await loadView(pool, videoId);
      if (view === null) {
        throw new RenderRefusedError(
          'The render has no video asset, so there is nothing to approve.',
        );
      }
      return view;
    },
  };
}
