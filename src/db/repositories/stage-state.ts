/**
 * `video_stage` and `project` state writes — TECH_DESIGN §4.2/§4.5.
 *
 * B-03's `state-machine.ts` says which transitions are legal; this module is the
 * only place that writes the resulting state, so the guard cannot be bypassed by
 * a direct UPDATE somewhere else (LEAD_PLAN §3). Stage rows are read `FOR UPDATE`
 * inside a transaction: two workers claiming the same stage serialise, and the
 * loser gets an `IllegalTransitionError` rather than a second provider call.
 */
import type { Pool } from 'pg';

import { withTransaction, type Queryable } from '../client.js';
import {
  IllegalTransitionError,
  transitionStage,
  transitionVideo,
  type StageEvent,
  type VideoEvent,
} from '../../domain/state-machine.js';
import type { StageCode, StageState, VideoState } from '../../shared/index.js';

export interface ProjectStateRow {
  readonly id: string;
  readonly status: VideoState;
  readonly current_stage: StageCode | null;
  readonly target_duration_s: number | null;
  readonly lead_s: number;
  readonly trail_s: number;
}

export interface VideoStageRow {
  readonly id: string;
  readonly project_id: string;
  readonly stage: StageCode;
  readonly state: StageState;
  readonly series_version_id: string | null;
  readonly stale: boolean;
  readonly last_event: string | null;
  readonly last_event_at: Date | null;
}

export interface StageWriteOptions {
  /** R-002-2: the series version in effect when the stage starts. */
  readonly seriesVersionId?: string | null;
}

const PROJECT_COLUMNS = /* sql */ `id, status, current_stage, target_duration_s, lead_s, trail_s`;
const STAGE_COLUMNS = /* sql */ `id, project_id, stage, state, series_version_id, stale, last_event, last_event_at`;

export async function findProjectState(
  db: Queryable,
  projectId: string,
): Promise<ProjectStateRow | null> {
  const result = await db.query<ProjectStateRow>(
    `SELECT ${PROJECT_COLUMNS} FROM project WHERE id = $1`,
    [projectId],
  );
  return result.rows[0] ?? null;
}

export async function findVideoStage(
  db: Queryable,
  projectId: string,
  stage: StageCode,
): Promise<VideoStageRow | null> {
  const result = await db.query<VideoStageRow>(
    `SELECT ${STAGE_COLUMNS} FROM video_stage WHERE project_id = $1 AND stage = $2`,
    [projectId, stage],
  );
  return result.rows[0] ?? null;
}

async function lockStage(
  db: Queryable,
  projectId: string,
  stage: StageCode,
): Promise<VideoStageRow> {
  const result = await db.query<VideoStageRow>(
    `SELECT ${STAGE_COLUMNS} FROM video_stage
      WHERE project_id = $1 AND stage = $2
      FOR UPDATE`,
    [projectId, stage],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(
      `project ${projectId} has no video_stage row for ${stage} (11 rows are minted at creation)`,
    );
  }
  return row;
}

async function writeStageState(
  db: Queryable,
  row: VideoStageRow,
  state: StageState,
  event: StageEvent,
  options: StageWriteOptions,
): Promise<VideoStageRow> {
  const result = await db.query<VideoStageRow>(
    `UPDATE video_stage
        SET state = $2,
            series_version_id = COALESCE($3, series_version_id),
            last_event = $4,
            last_event_at = now(),
            updated_at = now()
      WHERE id = $1
      RETURNING ${STAGE_COLUMNS}`,
    [row.id, state, options.seriesVersionId ?? null, event],
  );
  const updated = result.rows[0];
  if (updated === undefined)
    throw new Error(`video_stage ${row.id} vanished during its own update`);
  return updated;
}

/**
 * Move a stage to `running`, choosing the legal entry event from its *current*
 * state: `not_run → claim`, `stale → regenerate`, `failed → retry`,
 * `blocked → unblock → claim`. A stage already `running` is returned untouched —
 * that is a resumed attempt inside the same claim, not a new one. `done`,
 * `awaiting_approval` and `cancelled` are refused: regenerating an approved
 * stage is an explicit operator action, never a worker side effect (§4.2).
 */
export async function beginStage(
  pool: Pool,
  projectId: string,
  stage: StageCode,
  options: StageWriteOptions = {},
): Promise<VideoStageRow> {
  return withTransaction(pool, async (client) => {
    const row = await lockStage(client, projectId, stage);
    if (row.state === 'running') return row;

    const state = row.state === 'blocked' ? transitionStage('blocked', 'unblock') : row.state;
    const event: StageEvent | null =
      state === 'not_run'
        ? 'claim'
        : state === 'stale'
          ? 'regenerate'
          : state === 'failed'
            ? 'retry'
            : null;
    if (event === null) throw new IllegalTransitionError('stage', row.state, 'claim');
    return writeStageState(client, row, transitionStage(state, event), event, options);
  });
}

/** Apply one explicit stage event (e.g. `succeed`, `fail`) under the row lock. */
export async function applyStageEvent(
  pool: Pool,
  projectId: string,
  stage: StageCode,
  event: StageEvent,
  options: StageWriteOptions = {},
): Promise<VideoStageRow> {
  return withTransaction(pool, async (client) => {
    const row = await lockStage(client, projectId, stage);
    return writeStageState(client, row, transitionStage(row.state, event), event, options);
  });
}

/**
 * Apply a video-level event (§4.5). `needs_attention` is idempotent: a second
 * stage failing on an already-flagged video must not be an illegal transition.
 */
export async function applyVideoEvent(
  pool: Pool,
  projectId: string,
  event: VideoEvent,
): Promise<VideoState> {
  return withTransaction(pool, async (client) => {
    const result = await client.query<ProjectStateRow>(
      `SELECT ${PROJECT_COLUMNS} FROM project WHERE id = $1 FOR UPDATE`,
      [projectId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error(`project ${projectId} does not exist`);
    if (event === 'needs_attention' && row.status === 'NEEDS_ATTENTION') return row.status;

    const next = transitionVideo(row.status, event);
    await client.query(`UPDATE project SET status = $2, updated_at = now() WHERE id = $1`, [
      projectId,
      next,
    ]);
    return next;
  });
}

/** Point `project.current_stage` at the stage the pipeline now waits on (§4.5). */
export async function setProjectCurrentStage(
  db: Queryable,
  projectId: string,
  stage: StageCode | null,
): Promise<void> {
  await db.query(`UPDATE project SET current_stage = $2, updated_at = now() WHERE id = $1`, [
    projectId,
    stage,
  ]);
}
