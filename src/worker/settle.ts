/**
 * Settling a finished project — who marks a video, and its batch, complete.
 *
 * The stage rail ends at RE for this milestone: QC/FA/EX are operator gates that
 * are not wired yet. Nothing was rolling the outcome up, so a batch that had
 * rendered every video still read ACTIVE and each project still read RUNNING —
 * the UI could not answer "is it ready?" even with the MP4 in object storage.
 *
 * The rule is deliberately conservative: a project settles only when it has no
 * queued or running job left. That way a project with a failed stage, or one
 * waiting on a retry, never reports itself finished.
 */
import type { Pool } from 'pg';

export interface SettleOutcome {
  readonly projectCompleted: boolean;
  readonly batchCompleted: boolean;
}

const NOTHING_LEFT = `NOT EXISTS (
    SELECT 1 FROM job j
     WHERE j.project_id = p.id
       AND j.status IN ('queued', 'running')
  )`;

/**
 * Mark the project COMPLETE if its queue is empty, then roll the batch up.
 * Idempotent: running it twice changes nothing the second time.
 */
export async function settleAfterStage(pool: Pool, projectId: string): Promise<SettleOutcome> {
  const completed = await pool.query<{ id: string; batch_id: string | null }>(
    `UPDATE project p
        SET status = 'COMPLETE', updated_at = now()
      WHERE p.id = $1
        AND p.status <> 'COMPLETE'
        AND p.status <> 'CANCELLED'
        AND ${NOTHING_LEFT}
      RETURNING p.id, p.batch_id`,
    [projectId],
  );

  const row = completed.rows[0];
  if (row === undefined) return { projectCompleted: false, batchCompleted: false };
  if (row.batch_id === null) return { projectCompleted: true, batchCompleted: false };

  // A batch is complete when none of its videos is still NOT_STARTED or RUNNING.
  // Cancellation is final (R-028): a CANCELLED batch is never re-opened here.
  const batch = await pool.query<{ id: string }>(
    `UPDATE batch b
        SET status = 'COMPLETE'
      WHERE b.id = $1
        AND b.status = 'ACTIVE'
        AND NOT EXISTS (
          SELECT 1 FROM project p
           WHERE p.batch_id = b.id
             AND p.status IN ('NOT_STARTED', 'RUNNING')
        )
      RETURNING b.id`,
    [row.batch_id],
  );

  return { projectCompleted: true, batchCompleted: batch.rows.length > 0 };
}
