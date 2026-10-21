/**
 * Startup reconciler — Redis is transport, Postgres is the truth (TECH_DESIGN
 * §7.4, R-023, R-012-4; US-013, US-031).
 *
 * A killed worker or a wiped Redis leaves `job` rows claiming to be queued or
 * running with nobody holding the lease. On worker start this module:
 *
 * 1. scans `job` for `queued`/`running` whose newest `job_attempt.heartbeat_at`
 *    (falling back to `job.updated_at` for a job that never started) is older
 *    than the lease TTL;
 * 2. for a job **with a `pending` generation_run**, marks that run and its
 *    attempt `unknown charge` and fails the job — it never reissues the call.
 *    That is R-012-3's ≤1-billable guarantee (TECH_DESIGN §5.5): the request may
 *    already have reached the provider, and no provider honours an idempotency
 *    key (R-012-2), so only the operator may start a new run (R-011-3);
 * 3. otherwise it re-enqueues the job at its next attempt, with the retry scope
 *    stored on the row before the job runs (§7.3). A job with no in-flight run
 *    provably made no provider call, so resuming it is free of charge risk.
 *
 * A `done` stage is a different `job` row that is already `succeeded`; it is not
 * in the scan and is never re-run (R-023-2).
 */
import type { Pool } from 'pg';

import { finishJobAttempt, findOpenJobAttempts } from '../db/repositories/job-attempts.js';
import { findStalledJobs, markJobStatus, setJobRetryScope } from '../db/repositories/jobs.js';
import type { StalledJobRow } from '../db/repositories/types.js';
import { isStageCode, type StageCode } from '../shared/index.js';
import { MAX_ATTEMPTS_PER_JOB, refuseReissueOfPendingRuns } from './attempt.js';
import type { EnqueuePort } from './queues.js';

/**
 * How long a lease may be quiet before the job is treated as abandoned.
 * TECH_DESIGN §7.5 heartbeats every ≤ 5 s, so 60 s is twelve missed beats —
 * generous enough not to fight a slow-but-alive worker, short enough that a
 * restart resumes promptly.
 */
export const DEFAULT_LEASE_TTL_SECONDS = 60;

/** TECH_DESIGN §7.5: every attempt heartbeats at ≤ 5 s. */
export const LEASE_HEARTBEAT_INTERVAL_MS = 5_000;

export interface ReconcileDeps {
  readonly pool: Pool;
  readonly enqueuer: EnqueuePort;
  readonly leaseTtlSeconds?: number;
  /** Injectable clock; tests backdate a job instead of waiting. */
  readonly now?: Date;
  /**
   * Optional §7.3 hook: B-03's `computeRetryScope` output for this job. When
   * supplied it is persisted to `job.retry_scope` **before** the re-enqueue, as
   * R-022-2 requires. Null means "no scope to store"; the job still resumes.
   */
  readonly retryScopeFor?: (job: StalledJobRow) => unknown | Promise<unknown>;
}

export type ReconcileDecision =
  | 'requeued'
  | 'failed_unknown_charge'
  | 'failed_attempts_exhausted'
  | 'failed_not_queueable'
  | 'enqueue_failed';

export interface ReconciledJob {
  readonly jobId: string;
  readonly stage: StageCode;
  readonly previousStatus: string;
  readonly decision: ReconcileDecision;
  readonly pendingRunIds: readonly string[];
  readonly nextAttemptNo: number | null;
  readonly detail: string;
}

export interface ReconcileReport {
  readonly scanned: number;
  readonly requeued: number;
  readonly failedUnknownCharge: number;
  readonly failedAttemptsExhausted: number;
  readonly enqueueFailures: number;
  readonly unknownChargeRunIds: readonly string[];
  readonly jobs: readonly ReconciledJob[];
}

function stageOf(value: string): StageCode {
  if (!isStageCode(value)) {
    throw new Error(`job has stage ${value}, which is not a stage code (schema drift)`);
  }
  return value;
}

/**
 * Reconcile every abandoned job once. Safe to call repeatedly: re-enqueues use
 * the deterministic attempt job id (deduped while waiting) and the next call
 * sees a fresh `updated_at`/status. Returns a report so the caller can log it.
 */
export async function reconcileStalledJobs(deps: ReconcileDeps): Promise<ReconcileReport> {
  const stalled = await findStalledJobs(deps.pool, {
    leaseTtlSeconds: deps.leaseTtlSeconds ?? DEFAULT_LEASE_TTL_SECONDS,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });

  const jobs: ReconciledJob[] = [];
  const unknownChargeRunIds: string[] = [];
  let requeued = 0;
  let failedUnknownCharge = 0;
  let failedAttemptsExhausted = 0;
  let enqueueFailures = 0;

  for (const job of stalled) {
    const stage = stageOf(job.stage);
    const pending = await refuseReissueOfPendingRuns(deps, job.id);

    if (!pending.reissueAllowed) {
      // The load-bearing line of the whole module: a call may have billed, so
      // there is no automatic retry. The operator decides (R-011-3).
      await markJobStatus(deps.pool, job.id, 'failed');
      failedUnknownCharge += 1;
      unknownChargeRunIds.push(...pending.pendingRunIds);
      jobs.push({
        jobId: job.id,
        stage,
        previousStatus: job.status,
        decision: 'failed_unknown_charge',
        pendingRunIds: pending.pendingRunIds,
        nextAttemptNo: null,
        detail:
          'a generation_run was still pending: marked unknown charge, not reissued (R-012-3/R-012-4)',
      });
      continue;
    }

    // No pending run: any attempt the dead worker left open never issued a call
    // (the run row is written before the socket), so closing it is cost-free.
    const openAttempts = await findOpenJobAttempts(deps.pool, job.id);
    for (const attempt of openAttempts) {
      await finishJobAttempt(deps.pool, attempt.id, {
        status: 'failed',
        errorClass: 'transient',
        errorMessage:
          'worker lease expired before the attempt finished; no provider call was in flight ' +
          '(no pending generation_run)',
      });
    }

    const nextAttemptNo = (job.max_attempt_no ?? 0) + 1;
    if (nextAttemptNo > MAX_ATTEMPTS_PER_JOB) {
      await markJobStatus(deps.pool, job.id, 'failed');
      failedAttemptsExhausted += 1;
      jobs.push({
        jobId: job.id,
        stage,
        previousStatus: job.status,
        decision: 'failed_attempts_exhausted',
        pendingRunIds: [],
        nextAttemptNo: null,
        detail: `R-011-2 allows ${MAX_ATTEMPTS_PER_JOB} attempts; all were used`,
      });
      continue;
    }

    if (stage === 'FA') {
      await markJobStatus(deps.pool, job.id, 'failed');
      jobs.push({
        jobId: job.id,
        stage,
        previousStatus: job.status,
        decision: 'failed_not_queueable',
        pendingRunIds: [],
        nextAttemptNo: null,
        detail: 'FA is an operator gate and has no queue (TECH_DESIGN §4.8)',
      });
      continue;
    }

    if (deps.retryScopeFor) {
      const scope = await deps.retryScopeFor(job);
      if (scope !== null && scope !== undefined) {
        await setJobRetryScope(deps.pool, job.id, scope);
      }
    }

    await markJobStatus(deps.pool, job.id, 'queued');
    try {
      await deps.enqueuer.enqueue({
        jobId: job.id,
        projectId: job.project_id,
        stage,
        attemptNo: nextAttemptNo,
        reason: 'resume',
      });
      requeued += 1;
      jobs.push({
        jobId: job.id,
        stage,
        previousStatus: job.status,
        decision: 'requeued',
        pendingRunIds: [],
        nextAttemptNo,
        detail: 'no provider call was in flight; resumed from the last persisted stage (R-023)',
      });
    } catch (error) {
      // Leave the job `queued`; the next tick retries the enqueue. Throwing here
      // would abandon every later job in the scan.
      enqueueFailures += 1;
      jobs.push({
        jobId: job.id,
        stage,
        previousStatus: job.status,
        decision: 'enqueue_failed',
        pendingRunIds: [],
        nextAttemptNo,
        detail: `enqueue failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return {
    scanned: stalled.length,
    requeued,
    failedUnknownCharge,
    failedAttemptsExhausted,
    enqueueFailures,
    unknownChargeRunIds,
    jobs,
  };
}
