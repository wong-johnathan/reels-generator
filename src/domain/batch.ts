/**
 * Batch creation — R-019: exactly one batch, its projects and the first jobs,
 * minted atomically from an explicit operator request.
 *
 * R-019-4 is structural here: the only writer of `batch` rows is this module,
 * and the only caller is the operator-facing `POST /series/:id/batches` route.
 * There is no timer, cron, watchtower hook or schedule in this module (or
 * anywhere that calls it) — a batch exists only because an operator asked for
 * one. The worker loop consumes jobs; it never mints a batch.
 *
 * Batch size lives on the series, not here: the version snapshot's
 * `videos_per_batch` (contract field, 1..30, default 1) is the single source of
 * truth (commit dbac061). This module only *reads* it — it must never configure
 * the size a second time. An explicit override is accepted solely so tests can
 * pin a count without editing a profile; the production route never passes one.
 *
 * The Milestone A slice proves one video (size 1), but the insert path is fully
 * general: one `project` + 11 `video_stage` rows + one first `job` per video.
 */
import type { Pool } from 'pg';

import { withTransaction, type Queryable } from '../db/client.js';
import { STAGE_CODES, type StageCode } from '../shared/stages.js';

/** R-019: batch size bounds — `batch.target_count` CHECK(1..30) mirrors this. */
export const BATCH_TARGET_MIN = 1;
export const BATCH_TARGET_MAX = 30;

/** The first stage every project enters; the first job is minted for it. */
export const FIRST_STAGE: StageCode = 'T';

/** The priority the first job gets. Higher = earlier (queue helper convention). */
export const FIRST_JOB_PRIORITY = 2;

export class BatchTargetCountError extends Error {
  constructor(readonly value: unknown) {
    super(
      `batch target_count must be an integer between ${BATCH_TARGET_MIN} and ` +
        `${BATCH_TARGET_MAX} (R-019), got ${String(value)}`,
    );
    this.name = 'BatchTargetCountError';
  }
}

/** The series does not exist, or has no minted version to pin the batch to. */
export class BatchSeriesNotFoundError extends Error {
  constructor(readonly seriesId: string) {
    super(`series ${seriesId} does not exist or has no current version`);
    this.name = 'BatchSeriesNotFoundError';
  }
}

/** R-001: an archived series cannot be used for new batches. */
export class BatchSeriesArchivedError extends Error {
  constructor(readonly seriesId: string) {
    super(`series ${seriesId} is archived and cannot start new batches`);
    this.name = 'BatchSeriesArchivedError';
  }
}

export interface CreateBatchInput {
  readonly seriesId: string;
  /**
   * Explicit size override — **tests only**. The production path leaves this
   * unset so the count comes from the series snapshot (`videos_per_batch`).
   */
  readonly targetCount?: number;
  /** The authenticated operator who asked for the batch (recorded on `batch.created_by`). */
  readonly operatorId?: string | null;
}

export interface CreateBatchResult {
  readonly batchId: string;
  readonly seriesVersionId: string;
  readonly projectIds: string[];
  readonly firstJobIds: string[];
}

/** Clamp any configured size into R-019's 1..30 band; reject non-finite input. */
function resolveBatchSize(configured: unknown): number {
  if (configured === undefined || configured === null) return BATCH_TARGET_MIN;
  const value = Number(configured);
  if (!Number.isInteger(value) || value < BATCH_TARGET_MIN || value > BATCH_TARGET_MAX) {
    throw new BatchTargetCountError(configured);
  }
  return value;
}

/**
 * Mint one batch, its projects, per-project stage rows and the first job —
 * all inside a single transaction, so a partial batch can never be observed
 * (R-019, TECH_DESIGN §3.2).
 *
 * The batch is pinned to the series' *current* version at mint time
 * (`series_version_id` NOT NULL), read under a `FOR UPDATE` lock on the series
 * row so a concurrent version mint cannot race the pin.
 *
 * Batch size: `input.targetCount` (test override) wins; otherwise the series
 * snapshot's `videos_per_batch`, falling back to 1 for profiles written before
 * the field existed (commit dbac061).
 */
export async function createBatch(pool: Pool, input: CreateBatchInput): Promise<CreateBatchResult> {
  return withTransaction(pool, async (client) => {
    const series = await client.query<{
      id: string;
      status: string;
      current_version_id: string | null;
    }>(`SELECT id, status, current_version_id FROM series WHERE id = $1 FOR UPDATE`, [
      input.seriesId,
    ]);
    const seriesRow = series.rows[0];
    if (!seriesRow || seriesRow.current_version_id === null) {
      throw new BatchSeriesNotFoundError(input.seriesId);
    }
    if (seriesRow.status === 'archived') {
      throw new BatchSeriesArchivedError(input.seriesId);
    }

    const version = await client.query<{ id: string; snapshot: unknown }>(
      `SELECT id, snapshot FROM series_version WHERE id = $1`,
      [seriesRow.current_version_id],
    );
    const versionRow = version.rows[0];
    if (!versionRow) throw new BatchSeriesNotFoundError(input.seriesId);

    const snapshot = versionRow.snapshot as {
      target_duration_s?: unknown;
      videos_per_batch?: unknown;
    };

    const targetDurationS =
      typeof snapshot?.target_duration_s === 'number' ? snapshot.target_duration_s : null;
    const targetCount = resolveBatchSize(input.targetCount ?? snapshot?.videos_per_batch);

    const batch = await client.query<{ id: string }>(
      `INSERT INTO batch (series_id, series_version_id, target_count, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [input.seriesId, versionRow.id, targetCount, input.operatorId ?? null],
    );
    const batchId = batch.rows[0]?.id;
    if (batchId === undefined) throw new Error('INSERT INTO batch returned no id');

    const projectIds: string[] = [];
    const firstJobIds: string[] = [];

    for (let position = 1; position <= targetCount; position += 1) {
      const project = await client.query<{ id: string }>(
        `INSERT INTO project (batch_id, series_id, position_in_batch, target_duration_s)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [batchId, input.seriesId, position, targetDurationS],
      );
      const projectId = project.rows[0]?.id;
      if (projectId === undefined) throw new Error('INSERT INTO project returned no id');
      projectIds.push(projectId);

      await mintStageRows(client, projectId);
      firstJobIds.push(await mintFirstJob(client, projectId));
    }

    return {
      batchId,
      seriesVersionId: versionRow.id,
      projectIds,
      firstJobIds,
    };
  });
}

/** 11 stage rows, `not_run`, one per pipeline stage (TECH_DESIGN §3.2). */
async function mintStageRows(db: Queryable, projectId: string): Promise<void> {
  for (const stage of STAGE_CODES) {
    await db.query(`INSERT INTO video_stage (project_id, stage) VALUES ($1, $2)`, [
      projectId,
      stage,
    ]);
  }
}

/** The first job (stage T), `queued` — the worker loop's entry point. */
async function mintFirstJob(db: Queryable, projectId: string): Promise<string> {
  const job = await db.query<{ id: string }>(
    `INSERT INTO job (project_id, stage, status, priority)
     VALUES ($1, $2, 'queued', $3)
     RETURNING id`,
    [projectId, FIRST_STAGE, FIRST_JOB_PRIORITY],
  );
  const jobId = job.rows[0]?.id;
  if (jobId === undefined) throw new Error('INSERT INTO job returned no id');
  return jobId;
}
