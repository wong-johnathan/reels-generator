/**
 * `generation_run` writes — one row per provider call (R-012-1, D2).
 *
 * Only `src/domain/generation-run.ts` should insert here: the row must be
 * committed before an adapter executes, and that ordering is the domain
 * module's job. These helpers are transaction-agnostic on purpose.
 */
import type { Queryable } from '../client.js';
import type { GenerationRunRow } from './types.js';

export interface NewGenerationRun {
  readonly jobAttemptId: string;
  readonly projectId: string;
  readonly stage: string;
  readonly sceneId?: string | null;
  readonly provider?: string | null;
  readonly model?: string | null;
  readonly promptHash: string;
  readonly schemaVersion?: string | null;
  readonly idempotencyKey?: string | null;
  readonly attemptNo?: number | null;
  readonly seriesVersionId?: string | null;
}

const COLUMNS = /* sql */ `
  id, job_attempt_id, project_id, stage, scene_id, provider, model, prompt_hash,
  schema_version, provider_request_id, idempotency_key, idempotency_protected,
  billed_units, charge_status, status, error_class, http_status, attempt_no,
  series_version_id, asset_id, created_at, started_at, ended_at
`;

/**
 * Insert the `pending`/`pending` cost row. `idempotency_protected` stays at its
 * column default `false`: none of the three providers honours a key (R-012-2,
 * TECH_DESIGN §5.5), so the ≤1-billable guarantee is the commit-before-call
 * rule rather than provider-side idempotency.
 */
export async function insertPendingRun(
  db: Queryable,
  input: NewGenerationRun,
): Promise<GenerationRunRow> {
  const result = await db.query<GenerationRunRow>(
    `INSERT INTO generation_run
       (job_attempt_id, project_id, stage, scene_id, provider, model, prompt_hash,
        schema_version, idempotency_key, attempt_no, series_version_id,
        status, charge_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', 'pending')
     RETURNING ${COLUMNS}`,
    [
      input.jobAttemptId,
      input.projectId,
      input.stage,
      input.sceneId ?? null,
      input.provider ?? null,
      input.model ?? null,
      input.promptHash,
      input.schemaVersion ?? null,
      input.idempotencyKey ?? null,
      input.attemptNo ?? null,
      input.seriesVersionId ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('generation_run insert returned no row');
  return row;
}

export async function findGenerationRunById(
  db: Queryable,
  id: string,
): Promise<GenerationRunRow | null> {
  const result = await db.query<GenerationRunRow>(
    `SELECT ${COLUMNS} FROM generation_run WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** Terminal `generation_run.status` values the worker writes (TECH_DESIGN §3.1). */
export const FINAL_RUN_STATUSES = ['succeeded', 'failed', 'timed_out', 'unknown'] as const;
export type FinalRunStatus = (typeof FINAL_RUN_STATUSES)[number];
export type RunChargeStatus = 'billed' | 'unbilled' | 'unknown';

export interface FinishGenerationRunInput {
  readonly status: FinalRunStatus;
  readonly chargeStatus: RunChargeStatus;
  readonly errorClass?: 'transient' | 'non_retryable' | null;
  readonly httpStatus?: number | null;
  readonly providerRequestId?: string | null;
  /**
   * Only close the row if it is still `pending`. The worker uses this for
   * failures raised *before* the adapter was invoked: a row someone else has
   * already finished must not be rewritten.
   */
  readonly onlyIfPending?: boolean;
}

/** Record that the HTTP call is starting (R-012-1's `started_at`). */
export async function markGenerationRunStarted(
  db: Queryable,
  runId: string,
  providerRequestId?: string | null,
): Promise<void> {
  await db.query(
    `UPDATE generation_run
        SET started_at = COALESCE(started_at, now()),
            provider_request_id = COALESCE($2, provider_request_id)
      WHERE id = $1 AND status = 'pending'`,
    [runId, providerRequestId ?? null],
  );
}

/**
 * Close the cost row with the outcome of the call.
 *
 * `charge_status='unknown'` is the honest value whenever the request may have
 * reached the provider (R-012-4); callers must never pass `unbilled` on doubt.
 */
export async function finishGenerationRun(
  db: Queryable,
  runId: string,
  input: FinishGenerationRunInput,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE generation_run
        SET status = $2,
            charge_status = $3,
            error_class = $4,
            http_status = $5,
            provider_request_id = COALESCE($6, provider_request_id),
            ended_at = now()
      WHERE id = $1${input.onlyIfPending ? " AND status = 'pending'" : ''}`,
    [
      runId,
      input.status,
      input.chargeStatus,
      input.errorClass ?? null,
      input.httpStatus ?? null,
      input.providerRequestId ?? null,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * A `pending`/`pending` run whose call was in flight when the process died.
 * The reconciler marks these `unknown`; it must never reissue them (§5.5).
 */
export async function findPendingRunsForJob(
  db: Queryable,
  jobId: string,
): Promise<GenerationRunRow[]> {
  const result = await db.query<GenerationRunRow>(
    `SELECT gr.*
       FROM generation_run gr
       JOIN job_attempt ja ON ja.id = gr.job_attempt_id
      WHERE ja.job_id = $1 AND gr.status = 'pending'
      ORDER BY gr.created_at ASC`,
    [jobId],
  );
  return result.rows;
}

/**
 * Mark a mid-call run as "may have billed" without reissuing it (R-012-4,
 * TECH_DESIGN §5.5). `status='unknown'` says the call's fate is unknown.
 */
export async function markGenerationRunUnknownCharge(
  db: Queryable,
  runId: string,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE generation_run
        SET status = 'unknown',
            charge_status = 'unknown',
            ended_at = COALESCE(ended_at, now())
      WHERE id = $1 AND status = 'pending'`,
    [runId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Record the provider's request id on a run that is still `pending` (R-008-4,
 * R-013-1). The stage worker learns the id only from the response, i.e. after
 * the call but before the run is closed, so it writes it inside its `onResult`
 * hook. `finishGenerationRun` uses `COALESCE`, so the value survives the close.
 */
export async function recordPendingRunProviderRequestId(
  db: Queryable,
  runId: string,
  providerRequestId: string | null,
): Promise<boolean> {
  if (providerRequestId === null || providerRequestId.trim() === '') return false;
  const result = await db.query(
    `UPDATE generation_run
        SET provider_request_id = $2
      WHERE id = $1 AND status = 'pending'`,
    [runId, providerRequestId],
  );
  return (result.rowCount ?? 0) > 0;
}
