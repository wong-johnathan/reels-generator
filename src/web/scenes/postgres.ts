/**
 * Postgres adapter for the scene surfaces — contract `storyboard.get`,
 * `storyboard.approve`, `scenes.get`, `scenes.replace_image`.
 *
 * This is the production half of the SceneGateway seam: the web app renders
 * whatever these reads return and never invents a response, so every field
 * below maps to a column (or a documented derivation from columns) and nothing
 * else. Fields the schema has no column for are mapped to their documented
 * empty value and listed in the task report, not fabricated.
 *
 * Writes are transactional and respect the optimistic locks the tables already
 * carry: `project.storyboard_revision` for the storyboard gate and
 * `scene.revision` for a per-scene prompt edit (R-024). The stage flip inside
 * `approveStoryboard` still routes through `transitionStage`, the single source
 * of truth for `video_stage.state`, but writes inline so the review_decision,
 * the stage flip and the revision bump commit as one unit — the exported
 * pool-level helpers each open their own transaction and would break that.
 *
 * `releaseRemaining` is deliberately absent: the frozen contract has no
 * checkpoint-release route (gap F-06-1), so the grid keeps the release control
 * disabled instead of guessing a request shape.
 */
import type { Pool } from 'pg';
import type { z } from 'zod';

import {
  SceneViewSchema,
  StoryboardViewSchema,
  type AssetViewSchema,
} from '../../../contract/api.js';
import { withTransaction, type Queryable } from '../../db/client.js';
import { latestCheckpointSceneAssetAt } from '../../db/repositories/assets.js';
import { insertQueuedJob } from '../../db/repositories/jobs.js';
import { latestApproval, recordReviewDecision } from '../../db/repositories/review-decisions.js';
import { setProjectCurrentStage } from '../../db/repositories/stage-state.js';
import {
  lockSceneForReplace,
  SceneNotFoundInProjectError,
  SceneRevisionConflictError,
} from '../../db/repositories/scenes.js';
import { targetSceneCount } from '../../domain/authoring.js';
import { IllegalTransitionError, transitionStage } from '../../domain/state-machine.js';
import type { StageState } from '../../shared/stages.js';
import type { CameraMove } from '../../shared/states.js';
import { publicAssetUrl } from '../gateways/public-asset-url.js';
import {
  SceneConflictError,
  SceneBlockedError,
  SceneNotFoundError,
  type ReplaceImageInput,
  type SceneGateway,
  type SceneView,
  type StoryboardApproveInput,
  type StoryboardView,
} from './gateway.js';

type AssetView = z.infer<typeof AssetViewSchema>;

/** `timestamptz` arrives as a `Date`; the contract wants an ISO string with offset. */
function toIso(value: Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.toISOString();
}

/** The joined `scene` + `asset` + `series_version` row this adapter reads. */
interface SceneAssetRow {
  readonly id: string;
  readonly scene_no: string;
  readonly position: number;
  readonly narration_start_ms: number | null;
  readonly narration_end_ms: number | null;
  readonly image_prompt: string | null;
  readonly camera_move: string | null;
  readonly caption_emphasis: string | null;
  readonly fallback_text: string | null;
  readonly uses_protagonist: boolean;
  readonly revision: number;
  readonly asset_id: string | null;
  readonly asset_object_key: string | null;
  readonly asset_stage: string | null;
  readonly asset_kind: string | null;
  readonly asset_width: number | null;
  readonly asset_height: number | null;
  readonly asset_size_bytes: string | null;
  readonly asset_sha256: string | null;
  readonly asset_provider: string | null;
  readonly asset_model: string | null;
  readonly asset_prompt_hash: string | null;
  readonly asset_prompt_text: string | null;
  readonly asset_seed: string | null;
  readonly asset_series_version_id: string | null;
  readonly asset_series_version: number | null;
  readonly asset_created_at: Date | null;
}

const SCENE_ASSET_SELECT = /* sql */ `
  s.id, s.scene_no, s.position, s.narration_start_ms, s.narration_end_ms,
  s.image_prompt, s.camera_move, s.caption_emphasis, s.fallback_text,
  s.uses_protagonist, s.revision, s.asset_id,
  a.object_key AS asset_object_key,
  a.stage     AS asset_stage,
  a.kind      AS asset_kind,
  a.width     AS asset_width,
  a.height    AS asset_height,
  a.object_size_bytes AS asset_size_bytes,
  a.content_sha256    AS asset_sha256,
  a.provider  AS asset_provider,
  a.model     AS asset_model,
  a.prompt_hash AS asset_prompt_hash,
  a.prompt_text AS asset_prompt_text,
  a.seed      AS asset_seed,
  a.series_version_id AS asset_series_version_id,
  sv.version  AS asset_series_version,
  a.created_at AS asset_created_at
`;

async function listSceneAssetRows(db: Queryable, projectId: string): Promise<SceneAssetRow[]> {
  const result = await db.query<SceneAssetRow>(
    `SELECT ${SCENE_ASSET_SELECT}
       FROM scene s
       LEFT JOIN asset a ON a.id = s.asset_id
       LEFT JOIN series_version sv ON sv.id = a.series_version_id
      WHERE s.project_id = $1
      ORDER BY s.position ASC, s.scene_no ASC`,
    [projectId],
  );
  return result.rows;
}

async function findSceneAssetRow(
  db: Queryable,
  projectId: string,
  sceneId: string,
): Promise<SceneAssetRow | null> {
  const result = await db.query<SceneAssetRow>(
    `SELECT ${SCENE_ASSET_SELECT}
       FROM scene s
       LEFT JOIN asset a ON a.id = s.asset_id
       LEFT JOIN series_version sv ON sv.id = a.series_version_id
      WHERE s.id = $1 AND s.project_id = $2`,
    [sceneId, projectId],
  );
  return result.rows[0] ?? null;
}

/** The `/asset/:id/:variant` route the contract documents for every asset view. */
function assetUrls(assetId: string): AssetView['urls'] {
  const base = '/asset/' + assetId;
  return { thumb: base + '/thumb', detail: base + '/detail', full: base + '/full' };
}

function toAssetView(row: SceneAssetRow): AssetView {
  const assetId = row.asset_id;
  if (assetId === null) {
    // Never reached: toSceneView only calls this when asset_id is present.
    throw new Error('toAssetView called for a scene without an asset');
  }
  const seriesVersionId = row.asset_series_version_id;
  return {
    id: assetId,
    stage: (row.asset_stage ?? 'IM') as AssetView['stage'],
    kind: (row.asset_kind ?? 'image') as AssetView['kind'],
    width: row.asset_width,
    height: row.asset_height,
    size_bytes: row.asset_size_bytes === null ? 0 : Number(row.asset_size_bytes),
    content_sha256: row.asset_sha256 ?? '',
    public_url: row.asset_object_key === null ? null : publicAssetUrl(row.asset_object_key),
    urls: assetUrls(assetId),
    provenance: {
      provider: row.asset_provider,
      model: row.asset_model,
      prompt_hash: row.asset_prompt_hash,
      prompt_text: row.asset_prompt_text,
      seed: row.asset_seed,
      series_version_id: seriesVersionId,
      series_version: row.asset_series_version,
      created_at: toIso(row.asset_created_at) ?? '',
    },
  };
}

/**
 * Map a joined row to a `SceneView`.
 *
 * Two `scene` columns are nullable in the DDL but required by the contract:
 * `image_prompt` (→ empty string) and `camera_move` (→ `static`, the neutral
 * no-movement preset). The storyboard stage always writes both, so the fallback
 * only ever fires on a row written outside the normal pipeline.
 *
 * `state` has no per-scene column (the image stage's running/failed/stale
 * states are worker-owned, on `video_stage`/`job`/`generation_run`). The
 * adapter proves only what `scene.asset_id` proves: `done` when an image is
 * linked, `not_run` otherwise. Intermediate states are never fabricated — the
 * workspace `StageView` remains authoritative for the IM stage as a whole.
 */
function toSceneView(row: SceneAssetRow): SceneView {
  const narration =
    row.narration_start_ms === null || row.narration_end_ms === null
      ? null
      : { start_ms: row.narration_start_ms, end_ms: row.narration_end_ms };
  return SceneViewSchema.parse({
    id: row.id,
    scene_no: row.scene_no,
    position: row.position,
    image_prompt: row.image_prompt ?? '',
    camera_move: (row.camera_move ?? 'static') as CameraMove,
    caption_emphasis: row.caption_emphasis,
    fallback_text: row.fallback_text,
    uses_protagonist: row.uses_protagonist,
    narration,
    asset: row.asset_id === null ? null : toAssetView(row),
    state: row.asset_id === null ? 'not_run' : 'done',
    revision: row.revision,
  });
}

interface ProjectBoardRow {
  readonly id: string;
  readonly storyboard_revision: number;
  readonly target_duration_s: number | null;
}

async function findBoardProject(db: Queryable, videoId: string): Promise<ProjectBoardRow | null> {
  const result = await db.query<ProjectBoardRow>(
    'SELECT id, storyboard_revision, target_duration_s FROM project WHERE id = $1',
    [videoId],
  );
  return result.rows[0] ?? null;
}

/**
 * The first-three checkpoint is "reviewed" only when an IM approval exists,
 * the checkpoint scenes have an image, and the approval postdates that image
 * (PRD 10 — the exact rule the image stage uses before releasing scenes 4+).
 */
async function firstThreeReviewed(db: Queryable, projectId: string): Promise<boolean> {
  const approval = await latestApproval(db, projectId, 'IM');
  const anchor = await latestCheckpointSceneAssetAt(db, projectId, 3);
  return approval !== null && anchor !== null && approval.decided_at.getTime() >= anchor.getTime();
}

async function buildStoryboard(db: Queryable, project: ProjectBoardRow): Promise<StoryboardView> {
  const [rows, sbApproval, reviewed] = await Promise.all([
    listSceneAssetRows(db, project.id),
    latestApproval(db, project.id, 'SB'),
    firstThreeReviewed(db, project.id),
  ]);
  const targetDuration = project.target_duration_s ?? 75;
  return StoryboardViewSchema.parse({
    project_id: project.id,
    revision: project.storyboard_revision,
    scene_count: rows.length,
    target_scene_count: targetSceneCount(targetDuration),
    approved: sbApproval !== null,
    approved_at: sbApproval === null ? null : toIso(sbApproval.decided_at),
    first_three_reviewed: reviewed,
    scenes: rows.map(toSceneView),
  });
}

export function createPostgresSceneGateway(pool: Pool): SceneGateway {
  return {
    async storyboard(videoId: string): Promise<StoryboardView | null> {
      return withTransaction(pool, async (client) => {
        const project = await findBoardProject(client, videoId);
        if (project === null) return null;
        const scenes = await listSceneAssetRows(client, project.id);
        if (scenes.length === 0) return null;
        return buildStoryboard(client, project);
      });
    },

    async approveStoryboard(
      videoId: string,
      input: StoryboardApproveInput,
    ): Promise<StoryboardView> {
      return withTransaction(pool, async (client) => {
        const project = await client.query<ProjectBoardRow>(
          'SELECT id, storyboard_revision, target_duration_s FROM project WHERE id = $1 FOR UPDATE',
          [videoId],
        );
        const row = project.rows[0];
        if (row === undefined) throw new SceneNotFoundError(videoId);

        // Idempotent retry: an already-approved storyboard is already done, so
        // a replayed POST returns the current state instead of a duplicate
        // decision or a bogus 409.
        const existing = await latestApproval(client, videoId, 'SB');
        if (existing !== null) return buildStoryboard(client, row);

        if (row.storyboard_revision !== input.revision) {
          throw new SceneConflictError(row.storyboard_revision);
        }

        const prerequisites = await client.query<{ stage: string; state: string }>(
          `SELECT stage, state FROM video_stage
            WHERE project_id = $1 AND stage IN ('T', 'RS', 'SC', 'SB') FOR UPDATE`,
          [videoId],
        );
        const sbState = prerequisites.rows.find((stage) => stage.stage === 'SB')?.state;
        if (
          (sbState !== 'awaiting_approval' && sbState !== 'done') ||
          prerequisites.rows.some(
            (stage) => stage.stage !== 'SB' && stage.state !== 'done' && stage.state !== 'not_run',
          )
        ) {
          throw new SceneBlockedError(
            'Storyboard approval is blocked by an unfinished or stale stage.',
          );
        }
        const sceneRows = await client.query<{ id: string }>(
          'SELECT id FROM scene WHERE project_id = $1',
          [videoId],
        );
        if (sceneRows.rows.length === 0) {
          throw new SceneBlockedError('Storyboard approval is blocked: no scenes exist.');
        }

        await recordReviewDecision(client, {
          projectId: videoId,
          stage: 'SB',
          decision: 'approve',
          reason: input.note ?? null,
          revisionAtDecision: input.revision,
        });

        // Flip the optional gate once. The storyboard may already be `done`
        // (auto-advanced) in which case there is no `approve` edge and the
        // state is left untouched — the decision above is the approval record.
        const stage = await client.query<{ id: string; state: string }>(
          'SELECT id, state FROM video_stage WHERE project_id = $1 AND stage = $2 FOR UPDATE',
          [videoId, 'SB'],
        );
        const sbRow = stage.rows[0];
        let released = false;
        if (sbRow !== undefined) {
          try {
            const next = transitionStage(sbRow.state as StageState, 'approve');
            await client.query(
              "UPDATE video_stage SET state = $2, last_event = 'approve', last_event_at = now(), updated_at = now() WHERE id = $1",
              [sbRow.id, next],
            );
            released = true;
          } catch (error) {
            if (!(error instanceof IllegalTransitionError)) throw error;
          }
        }

        // Approval is what mints image generation. The orchestrator parks SB in
        // `awaiting_approval` and mints nothing, so without this the video waited
        // forever for a job that only this decision could create.
        if (released) {
          const hasIm = await client.query<{ id: string }>(
            `SELECT id FROM job
              WHERE project_id = $1 AND stage = 'IM' AND status IN ('queued', 'running', 'succeeded')
              LIMIT 1`,
            [videoId],
          );
          if (hasIm.rows.length === 0) {
            await insertQueuedJob(client, { projectId: videoId, stage: 'IM', priority: 2 });
          }
          await setProjectCurrentStage(client, videoId, 'IM');
        }

        await client.query(
          'UPDATE project SET storyboard_revision = storyboard_revision + 1, updated_at = now() WHERE id = $1',
          [videoId],
        );
        const bumped: ProjectBoardRow = {
          ...row,
          storyboard_revision: row.storyboard_revision + 1,
        };
        return buildStoryboard(client, bumped);
      });
    },

    async scene(videoId: string, sceneId: string): Promise<SceneView | null> {
      return withTransaction(pool, async (client) => {
        const row = await findSceneAssetRow(client, videoId, sceneId);
        return row === null ? null : toSceneView(row);
      });
    },

    async replaceImage(videoId: string, sceneId: string, input: ReplaceImageInput): Promise<void> {
      try {
        await withTransaction(pool, async (client) => {
          const project = await client.query('SELECT id FROM project WHERE id = $1', [videoId]);
          if (project.rows[0] === undefined) throw new SceneNotFoundError(videoId);

          await lockSceneForReplace(client, {
            projectId: videoId,
            sceneId,
            expectedRevision: input.revision,
            imagePrompt: input.image_prompt ?? null,
          });
          await insertQueuedJob(client, { projectId: videoId, stage: 'IM', sceneId });
        });
      } catch (error) {
        if (error instanceof SceneNotFoundError) throw error;
        if (error instanceof SceneNotFoundInProjectError) throw new SceneNotFoundError(sceneId);
        if (error instanceof SceneRevisionConflictError) {
          throw new SceneConflictError(error.actualRevision);
        }
        throw error;
      }
    },
  };
}
