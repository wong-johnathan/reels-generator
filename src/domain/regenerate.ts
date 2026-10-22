/**
 * Operator-initiated regeneration of a failed batch (D-H).
 *
 * A failed stage stops the worker: R-011-2 allows three *automatic* attempts and
 * then leaves the job failed for a human to look at. Regenerate is that human
 * decision — it requeues exactly the jobs that failed, inside the same batch, so
 * everything already generated (topic, script, storyboard, scenes, images,
 * narration) is kept and only the broken step runs again.
 *
 * What this deliberately does not do:
 * - it never touches a `succeeded` job; regenerating is not a re-roll of work you
 *   have already paid for;
 * - it never requeues a `cancelled` batch (cancellation is final, R-019-3);
 * - it does not touch `video_stage` state. `beginStage` already knows the
 *   `failed → running` transition and records it as a `retry` event, so the rail
 *   stays the single writer of stage state.
 */
import type { Pool } from 'pg';

export class BatchNotFoundError extends Error {
  constructor(public readonly batchId: string) {
    super(`batch ${batchId} does not exist`);
    this.name = 'BatchNotFoundError';
  }
}

export class BatchCancelledError extends Error {
  constructor(public readonly batchId: string) {
    super(`batch ${batchId} was cancelled`);
    this.name = 'BatchCancelledError';
  }
}

export interface RegenerateResult {
  /** Jobs moved back to `queued`. */
  readonly requeued: number;
  /** Projects touched by the requeue. */
  readonly projectIds: readonly string[];
}

/**
 * Requeue every failed job in a batch, recording the attempt as operator-initiated.
 *
 * Runs in one transaction and locks the batch row first, so two clicks cannot
 * interleave: the second sees no failed jobs and reports zero.
 */
export async function regenerateBatch(
  pool: Pool,
  input: { readonly batchId: string; readonly operatorUsername?: string | null },
): Promise<RegenerateResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const batch = await client.query<{ status: string }>(
      'SELECT status FROM batch WHERE id = $1 FOR UPDATE',
      [input.batchId],
    );
    const row = batch.rows[0];
    if (row === undefined) throw new BatchNotFoundError(input.batchId);
    if (row.status === 'CANCELLED') throw new BatchCancelledError(input.batchId);

    const failed = await client.query<{
      id: string;
      project_id: string;
      last_attempt: number;
    }>(
      /* sql */ `
      SELECT j.id, j.project_id,
             coalesce((SELECT max(a.attempt_no) FROM job_attempt a WHERE a.job_id = j.id), 0)
               ::int AS last_attempt
        FROM job j
        JOIN project p ON p.id = j.project_id
       WHERE p.batch_id = $1 AND j.status = 'failed'
       ORDER BY j.created_at
         FOR UPDATE OF j`,
      [input.batchId],
    );

    if (failed.rows.length === 0) {
      await client.query('COMMIT');
      return { requeued: 0, projectIds: [] };
    }

    for (const job of failed.rows) {
      await client.query("UPDATE job SET status = 'queued', updated_at = now() WHERE id = $1", [
        job.id,
      ]);
      await client.query(
        /* sql */ `
        INSERT INTO job_attempt (job_id, attempt_no, status, triggered_kind, triggered_by)
        VALUES ($1, $2, 'pending', 'operator',
                (SELECT id FROM operator WHERE username = $3))`,
        [job.id, job.last_attempt + 1, input.operatorUsername ?? null],
      );
    }

    const projectIds = [...new Set(failed.rows.map((job) => job.project_id))];
    await client.query(
      "UPDATE project SET status = 'RUNNING', updated_at = now() WHERE id = ANY($1::uuid[])",
      [projectIds],
    );
    await client.query(
      "UPDATE batch SET status = 'ACTIVE' WHERE id = $1 AND status <> 'CANCELLED'",
      [input.batchId],
    );

    await client.query('COMMIT');
    return { requeued: failed.rows.length, projectIds };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
