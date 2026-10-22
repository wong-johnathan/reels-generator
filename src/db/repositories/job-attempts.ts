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
    // The trigger is read from, and cleared on, the job in the same statement:
    // a pre-inserted attempt row used to inflate the attempt number and leave a
    // `pending` row with no run attached (D-H, M-009).
    `WITH consumed AS (
       UPDATE job SET operator_retry_at = NULL, operator_retry_by = NULL
        WHERE id = $1 AND operator_retry_at IS NOT NULL
        RETURNING operator_retry_by AS by_id
     )
     INSERT INTO job_attempt (job_id, attempt_no, status, worker_id, triggered_kind, triggered_by)
     SELECT $1, $2, 'pending', $3,
            CASE WHEN EXISTS (SELECT 1 FROM consumed) THEN 'operator' ELSE 'automatic' END,
            (SELECT by_id FROM consumed)
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

/** The states an attempt can be *finished* in (TECH_DESIGN §3.1). */
export const FINAL_ATTEMPT_STATUSES = [
  'succeeded',
  'failed',
  'timed_out',
  'unknown_charge',
  'cancelled',
] as const;
export type FinalAttemptStatus = (typeof FINAL_ATTEMPT_STATUSES)[number];

export interface FinishJobAttemptInput {
  readonly status: FinalAttemptStatus;
  readonly errorClass?: 'transient' | 'non_retryable' | null;
  readonly errorMessage?: string | null;
  readonly httpStatus?: number | null;
  /** 1 / 4 / 16 — recorded only when a further attempt is actually planned. */
  readonly backoffS?: number | null;
}

/** Mark the attempt as the one a worker is currently holding the lease for. */
export async function markAttemptRunning(
  db: Queryable,
  attemptId: string,
  workerId: string | null,
): Promise<void> {
  await db.query(
    `UPDATE job_attempt
        SET status = 'running',
            worker_id = COALESCE($2, worker_id),
            started_at = COALESCE(started_at, now()),
            heartbeat_at = now()
      WHERE id = $1`,
    [attemptId, workerId],
  );
}

/**
 * Renew the lease. TECH_DESIGN §7.5: every attempt heartbeats at ≤ 5 s; a
 * heartbeat older than the reconciler's TTL is how a killed worker is detected.
 * Returns `false` when the attempt row no longer exists (or was already closed),
 * which the caller should treat as "stop working".
 */
export async function heartbeatAttempt(db: Queryable, attemptId: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE job_attempt SET heartbeat_at = now()
      WHERE id = $1 AND status IN ('pending', 'running')`,
    [attemptId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function finishJobAttempt(
  db: Queryable,
  attemptId: string,
  input: FinishJobAttemptInput,
): Promise<void> {
  await db.query(
    `UPDATE job_attempt
        SET status = $2,
            error_class = $3,
            error_message = $4,
            http_status = $5,
            backoff_s = $6,
            finished_at = now(),
            heartbeat_at = COALESCE(heartbeat_at, now())
      WHERE id = $1`,
    [
      attemptId,
      input.status,
      input.errorClass ?? null,
      input.errorMessage === undefined || input.errorMessage === null
        ? null
        : input.errorMessage.slice(0, 1_000),
      input.httpStatus ?? null,
      input.backoffS ?? null,
    ],
  );
}

export async function findJobAttemptsByJob(db: Queryable, jobId: string): Promise<JobAttemptRow[]> {
  const result = await db.query<JobAttemptRow>(
    `SELECT ${COLUMNS} FROM job_attempt WHERE job_id = $1 ORDER BY attempt_no ASC`,
    [jobId],
  );
  return result.rows;
}

/** Attempts a killed worker left open — the reconciler closes them. */
export async function findOpenJobAttempts(db: Queryable, jobId: string): Promise<JobAttemptRow[]> {
  const result = await db.query<JobAttemptRow>(
    `SELECT ${COLUMNS} FROM job_attempt
      WHERE job_id = $1 AND status IN ('pending', 'running')
      ORDER BY attempt_no ASC`,
    [jobId],
  );
  return result.rows;
}
