/**
 * `job_attempt` writes — the retry ledger (R-011-2, TECH_DESIGN §3.1).
 *
 * An attempt is always inserted inside the transaction that also inserts its
 * `generation_run` (see src/domain/generation-run.ts::openAttempt), so a
 * committed attempt implies its run row exists and vice versa.
 */
import type { Queryable } from '../client.js';
import type { JobAttemptRow } from './types.js';

export interface NewJobAttempt {
  readonly jobId: string;
  /** 1..3 — R-011-2 stops retrying at three attempts. */
  readonly attemptNo: number;
  readonly workerId?: string | null;
}

const COLUMNS = /* sql */ `
  id, job_id, attempt_no, status, worker_id, started_at, heartbeat_at, finished_at,
  error_class, error_message, http_status, backoff_s, created_at
`;

/** Insert a `pending` attempt. The caller owns the transaction. */
export async function insertPendingAttempt(
  db: Queryable,
  input: NewJobAttempt,
): Promise<JobAttemptRow> {
  const result = await db.query<JobAttemptRow>(
    `INSERT INTO job_attempt (job_id, attempt_no, status, worker_id)
     VALUES ($1, $2, 'pending', $3)
     RETURNING ${COLUMNS}`,
    [input.jobId, input.attemptNo, input.workerId ?? null],
  );
  const row = result.rows[0];
  if (!row) throw new Error('job_attempt insert returned no row');
  return row;
}

export async function findJobAttemptById(db: Queryable, id: string): Promise<JobAttemptRow | null> {
  const result = await db.query<JobAttemptRow>(`SELECT ${COLUMNS} FROM job_attempt WHERE id = $1`, [
    id,
  ]);
  return result.rows[0] ?? null;
}
