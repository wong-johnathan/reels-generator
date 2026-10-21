/**
 * video_stage / project state writes — TECH_DESIGN 4.2 / 4.5.
 *
 * LEAD_PLAN 3 makes src/domain/state-machine.ts the only module allowed to
 * decide a transition. This module is the persistence wrapper it was missing:
 * every write locks the row, asks transitionStage/transitionVideo for the
 * target state, and writes exactly the fields the spec names (state, the
 * per-stage pin, progress, last_event, and the stale bookkeeping that a
 * successful run clears).
 *
 * No other module may UPDATE video_stage.state directly.
 */
import type { Pool } from 'pg';

import {
  transitionStage,
  transitionVideo,
  type StageEvent,
  type VideoEvent,
} from '../../domain/state-machine.js';
import type { StageCode, StageState, VideoState } from '../../shared/index.js';
import { withTransaction, type Queryable } from '../client.js';

export interface VideoStageRow {
  readonly id: string;
  readonly project_id: string;
  readonly stage: StageCode;
  readonly state: StageState;
  readonly series_version_id: string | null;
  readonly stale: boolean;
  readonly stale_cause: string | null;
  readonly stale_revision: number | null;
  readonly stale_at: Date | null;
  readonly last_event_at: Date | null;
  readonly last_event: string | null;
  readonly progress_current: number | null;
  readonly progress_total: number | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export const VIDEO_STAGE_COLUMNS =
  'id, project_id, stage, state, series_version_id, stale, stale_cause, stale_revision, ' +
  'stale_at, last_event_at, last_event, progress_current, progress_total, created_at, updated_at';

export class VideoStageRowMissingError extends Error {
  constructor(
    readonly projectId: string,
    readonly stage: StageCode,
  ) {
    super(
      'no video_stage row for project ' +
        projectId +
        ' stage ' +
        stage +
        ': project creation mints all 11 rows (TECH_DESIGN 1.2 step 2), so this is schema drift',
    );
    this.name = 'VideoStageRowMissingError';
  }
}

export async function findVideoStage(
  db: Queryable,
  projectId: string,
  stage: StageCode,
): Promise<VideoStageRow | null> {
  const result = await db.query<VideoStageRow>(
    'SELECT ' + VIDEO_STAGE_COLUMNS + ' FROM video_stage WHERE project_id = $1 AND stage = $2',
    [projectId, stage],
  );
  return result.rows[0] ?? null;
}

export async function requireVideoStage(
  db: Queryable,
  projectId: string,
  stage: StageCode,
): Promise<VideoStageRow> {
  const row = await findVideoStage(db, projectId, stage);
  if (row === null) throw new VideoStageRowMissingError(projectId, stage);
  return row;
}

export interface StageTransitionInput {
  readonly projectId: string;
  readonly stage: StageCode;
  readonly event: StageEvent;
  /** Written when supplied; omitted means keep the current progress. */
  readonly progress?: { readonly current: number; readonly total: number };
  /** X-8/OQ-6: the version in effect when the stage starts. */
  readonly seriesVersionId?: string | null;
  /** Defaults to the event name; the ledger keeps the exact trigger. */
  readonly lastEvent?: string;
}

/**
 * Apply one legal transition atomically. The row is locked FOR UPDATE, so two
 * workers cannot both see not_run and both claim the stage.
 */
export async function applyStageTransition(
  pool: Pool,
  input: StageTransitionInput,
): Promise<VideoStageRow> {
  return withTransaction(pool, async (client) => {
    const current = await client.query<VideoStageRow>(
      'SELECT ' +
        VIDEO_STAGE_COLUMNS +
        ' FROM video_stage WHERE project_id = $1 AND stage = $2 FOR UPDATE',
      [input.projectId, input.stage],
    );
    const row = current.rows[0];
    if (row === undefined) throw new VideoStageRowMissingError(input.projectId, input.stage);

    // Throws IllegalTransitionError when the pair is not in the spec table.
    const next = transitionStage(row.state, input.event);

    // §4.4 step 4: entering `stale` records the cause and the moment; reaching
    // `done` (the only clearing edge, IP-01/UC-05) clears both.
    const updated = await client.query<VideoStageRow>(
      'UPDATE video_stage SET state = $2, last_event = $3, last_event_at = now(), ' +
        'updated_at = now(), progress_current = COALESCE($4, progress_current), ' +
        'progress_total = COALESCE($5, progress_total), ' +
        'series_version_id = COALESCE($6, series_version_id), ' +
        'stale = CASE WHEN $2 = $7 THEN false WHEN $2 = $8 THEN true ELSE stale END, ' +
        'stale_cause = CASE WHEN $2 = $7 THEN NULL WHEN $2 = $8 THEN $3 ELSE stale_cause END, ' +
        'stale_revision = CASE WHEN $2 = $7 THEN NULL ELSE stale_revision END, ' +
        'stale_at = CASE WHEN $2 = $7 THEN NULL WHEN $2 = $8 THEN now() ELSE stale_at END ' +
        'WHERE id = $1 RETURNING ' +
        VIDEO_STAGE_COLUMNS,
      [
        row.id,
        next,
        input.lastEvent ?? input.event,
        input.progress?.current ?? null,
        input.progress?.total ?? null,
        input.seriesVersionId ?? null,
        'done',
        'stale',
      ],
    );
    const result = updated.rows[0];
    if (result === undefined) throw new Error('video_stage update returned no row');
    return result;
  });
}

export interface ProjectRow {
  readonly id: string;
  readonly series_id: string;
  readonly status: VideoState;
  readonly current_stage: string | null;
}

export const PROJECT_COLUMNS = 'id, series_id, status, current_stage';

export async function findProject(db: Queryable, projectId: string): Promise<ProjectRow | null> {
  const result = await db.query<ProjectRow>(
    'SELECT ' + PROJECT_COLUMNS + ' FROM project WHERE id = $1',
    [projectId],
  );
  return result.rows[0] ?? null;
}

/** 4.5: a stage transition drives the video status in the same unit of work. */
export async function applyProjectStatusTransition(
  pool: Pool,
  input: { readonly projectId: string; readonly event: VideoEvent },
): Promise<ProjectRow> {
  return withTransaction(pool, async (client) => {
    const current = await client.query<ProjectRow>(
      'SELECT ' + PROJECT_COLUMNS + ' FROM project WHERE id = $1 FOR UPDATE',
      [input.projectId],
    );
    const row = current.rows[0];
    if (row === undefined) throw new Error('project ' + input.projectId + ' does not exist');
    const next = transitionVideo(row.status, input.event);
    const updated = await client.query<ProjectRow>(
      'UPDATE project SET status = $2 WHERE id = $1 RETURNING ' + PROJECT_COLUMNS,
      [input.projectId, next],
    );
    const result = updated.rows[0];
    if (result === undefined) throw new Error('project update returned no row');
    return result;
  });
}

export interface StageProgressUpdate {
  readonly projectId: string;
  readonly stage: StageCode;
  readonly progress: { readonly current: number; readonly total: number };
  readonly seriesVersionId?: string | null;
  readonly lastEvent?: string;
}

/**
 * Write progress (and optionally the pin) without changing the state. Used by
 * the image stage between scenes, where the stage stays running.
 */
export async function updateStageProgress(
  db: Queryable,
  input: StageProgressUpdate,
): Promise<VideoStageRow> {
  const updated = await db.query<VideoStageRow>(
    'UPDATE video_stage SET progress_current = $3, progress_total = $4, ' +
      'series_version_id = COALESCE($5, series_version_id), ' +
      'last_event = COALESCE($6, last_event), last_event_at = now(), updated_at = now() ' +
      'WHERE project_id = $1 AND stage = $2 RETURNING ' +
      VIDEO_STAGE_COLUMNS,
    [
      input.projectId,
      input.stage,
      input.progress.current,
      input.progress.total,
      input.seriesVersionId ?? null,
      input.lastEvent ?? null,
    ],
  );
  const row = updated.rows[0];
  if (row === undefined) throw new VideoStageRowMissingError(input.projectId, input.stage);
  return row;
}

/** How many stages other than  are failed, blocked or waiting on a gate. */
export async function countStagesNeedingAttention(
  db: Queryable,
  projectId: string,
  exceptStage: StageCode,
): Promise<number> {
  const result = await db.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM video_stage ' +
      "WHERE project_id = $1 AND stage <> $2 AND state IN ('failed', 'blocked', 'awaiting_approval')",
    [projectId, exceptStage],
  );
  return Number.parseInt(result.rows[0]?.count ?? '0', 10);
}
