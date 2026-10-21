/**
 * `job` writes — the durable mirror of a unit of work (TECH_DESIGN §3.2, §7.1).
 *
 * Redis is transport, Postgres is the source of truth (X-3). A job's status and
 * the attempt ledger are what the reconciler reads after a worker or Redis
 * restart, so every state change the worker makes is written here first and
 * deliberately: `markJobStatus` is the only writer.
 */
import type { Queryable } from '../client.js';
import type { JobRow, StalledJobRow } from './types.js';

const COLUMNS = /* sql */ `
  id, project_id, stage, scene_id, status, priority, retry_scope, created_at, updated_at
`;

export async function findJobById(db: Queryable, id: string): Promise<JobRow | null> {
  const result = await db.query<JobRow>(`SELECT ${COLUMNS} FROM job WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}

/** The only status writer: `queued` | `running` | `succeeded` | `failed` | `cancelled`. */
export async function markJobStatus(db: Queryable, jobId: string, status: string): Promise<void> {
  await db.query(`UPDATE job SET status = $2, updated_at = now() WHERE id = $1`, [jobId, status]);
}

/**
 * Store the retry scope **before** a retried job runs (TECH_DESIGN §7.3,
 * R-022-2). The value is computed by B-03's `computeRetryScope`; this module
 * only persists it, so the API can serve the IP-06 panel from the row.
 */
export async function setJobRetryScope(
  db: Queryable,
  jobId: string,
  scope: unknown,
): Promise<void> {
  await db.query(`UPDATE job SET retry_scope = $2, updated_at = now() WHERE id = $1`, [
    jobId,
    scope === undefined ? null : JSON.stringify(scope),
  ]);
}

export interface FindStalledJobsOptions {
  /** A job whose newest heartbeat is older than this is not being worked on. */
  readonly leaseTtlSeconds: number;
  /** Injectable clock so tests do not have to wait for real time to pass. */
  readonly now?: Date;
}

/**
 * Jobs that claim to be in flight but whose lease has expired (TECH_DESIGN
 * §7.4 step 1). A `queued` job has no heartbeat at all, so `job.updated_at` is
 * the fallback clock: a job that has been sitting in the queue for longer than
 * the TTL is treated as "Redis may have lost it" and is re-enqueued.
 *
 * Re-enqueueing is safe because the attempt id makes the BullMQ job id
 * deterministic (see src/workers/queues.ts), so a duplicate add is deduplicated
 * by BullMQ while the original is still waiting.
 */
export async function findStalledJobs(
  db: Queryable,
  options: FindStalledJobsOptions,
): Promise<StalledJobRow[]> {
  const cutoff = new Date((options.now ?? new Date()).getTime() - options.leaseTtlSeconds * 1_000);
  const result = await db.query<StalledJobRow>(
    `SELECT j.id, j.project_id, j.stage, j.scene_id, j.status, j.priority, j.retry_scope,
            j.created_at, j.updated_at,
            (SELECT max(a.heartbeat_at) FROM job_attempt a WHERE a.job_id = j.id) AS last_heartbeat,
            (SELECT max(a.attempt_no) FROM job_attempt a WHERE a.job_id = j.id) AS max_attempt_no
       FROM job j
      WHERE j.status IN ('queued', 'running')
        AND GREATEST(
              j.updated_at,
              COALESCE((SELECT max(a.heartbeat_at) FROM job_attempt a WHERE a.job_id = j.id),
                       j.updated_at)
            ) < $1
      ORDER BY j.updated_at ASC`,
    [cutoff],
  );
  return result.rows;
}

export interface QueuedJobInput {
  readonly projectId: string;
  readonly stage: string;
  readonly sceneId?: string | null;
  readonly priority?: number;
  /** IP-06's computed scope, stored before the job runs (R-022-2). */
  readonly retryScope?: unknown;
}

/**
 * Insert a `queued` job — the durable half of an enqueue (X-3: Redis is
 * transport, Postgres is the source of truth). The caller owns the transaction
 * so the job commits with whatever edit it belongs to.
 */
export async function insertQueuedJob(db: Queryable, input: QueuedJobInput): Promise<JobRow> {
  const result = await db.query<JobRow>(
    'INSERT INTO job (project_id, stage, scene_id, status, priority, retry_scope) ' +
      "VALUES ($1, $2, $3, 'queued', $4, $5) RETURNING " +
      COLUMNS,
    [
      input.projectId,
      input.stage,
      input.sceneId ?? null,
      input.priority ?? 0,
      input.retryScope === undefined || input.retryScope === null
        ? null
        : JSON.stringify(input.retryScope),
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('job insert returned no row');
  return row;
}
