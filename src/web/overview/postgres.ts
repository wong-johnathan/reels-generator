/**
 * The dashboard overview, read from Postgres (INT-01 seam for S-02).
 *
 * `WebAppDependencies.overview` is a plain value, so the production entrypoint
 * loads it once at startup and passes the result in. Nothing here is invented:
 * the counts come from `project.status` and the batch rows from `batch` joined
 * to `series`, both of whose CHECK constraints are the single source of truth
 * (BATCH_STATES / VIDEO_STATES in src/shared/states.ts).
 *
 * `attention` is empty on purpose. An attention item needs the `video_stage`
 * join (stage_state, attention_kind, attention_reason), and wiring that is out
 * of scope for the mount; an empty list is honest where a fabricated row would
 * not be. Likewise `failed_count` stays 0 because no `project.status` maps
 * cleanly to a failure — inventing one would be a lie.
 */
import type { z } from 'zod';

import type { OverviewSchema } from '../../../contract/api.js';
import type { Queryable } from '../../db/client.js';
import type { BatchState } from '../../shared/states.js';

export type Overview = z.infer<typeof OverviewSchema>;

/** The honest fallback when nothing has been loaded (no pool, or a failed load). */
export const EMPTY_OVERVIEW: Overview = {
  attention: [],
  batches: [],
  counts: { needs_attention: 0, running: 0, complete: 0 },
  degraded: [],
};

interface BatchRow {
  readonly id: string;
  readonly series_id: string;
  readonly series_name: string;
  readonly status: BatchState;
  readonly target_count: number;
  readonly completed_count: number;
  readonly needs_attention_count: number;
  readonly created_at: Date;
}

interface CountRow {
  readonly needs_attention: number;
  readonly running: number;
  readonly complete: number;
}

export async function loadOverview(db: Queryable): Promise<Overview> {
  const counts = await db.query<CountRow>(
    `SELECT
       count(*) FILTER (WHERE status = 'NEEDS_ATTENTION')::int AS needs_attention,
       count(*) FILTER (WHERE status = 'RUNNING')::int          AS running,
       count(*) FILTER (WHERE status = 'COMPLETE')::int         AS complete
     FROM project`,
  );
  const countRow = counts.rows[0];

  const batches = await db.query<BatchRow>(
    `SELECT
       b.id,
       b.series_id,
       s.name AS series_name,
       b.status,
       b.target_count,
       count(*) FILTER (WHERE p.status = 'COMPLETE')::int         AS completed_count,
       count(*) FILTER (WHERE p.status = 'NEEDS_ATTENTION')::int  AS needs_attention_count,
       b.created_at
     FROM batch b
     JOIN series s ON s.id = b.series_id
     LEFT JOIN project p ON p.batch_id = b.id
     GROUP BY b.id, s.name
     ORDER BY b.created_at DESC`,
  );

  return {
    // See the module header: attention needs the video_stage join, out of scope.
    attention: [],
    batches: batches.rows.map((row) => ({
      id: row.id,
      series_id: row.series_id,
      series_name: row.series_name,
      status: row.status,
      target_count: row.target_count,
      completed_count: row.completed_count,
      needs_attention_count: row.needs_attention_count,
      failed_count: 0,
      created_at: row.created_at.toISOString(),
    })),
    counts: {
      needs_attention: countRow?.needs_attention ?? 0,
      running: countRow?.running ?? 0,
      complete: countRow?.complete ?? 0,
    },
    degraded: [],
  };
}
