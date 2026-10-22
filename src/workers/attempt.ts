/**
 * The attempt lifecycle: attempt row before the call, one outcome per call,
 * R-011-2's retry policy on top (US-013, US-031; TECH_DESIGN §3.5, §5.5, §7.1).
 *
 * The ordering rule is structural, not conventional: `runProviderAttempt`
 * inserts `job_attempt` + `generation_run` in one committed transaction, and
 * `executePersisted` re-reads the run on a fresh session before the adapter is
 * allowed to open a socket (B-02's guard). This module owns what happens *after*
 * the call returns:
 *
 *   - a success closes the run `succeeded`/`billed`, the attempt `succeeded`,
 *     and the job `succeeded`;
 *   - a provider failure is classified `transient` | `non_retryable` and the
 *     charge is recorded `unknown` whenever the request may have billed
 *     (R-012-4) — never `unbilled` on doubt;
 *   - `transient` failures retry up to three attempts, with the 1 s / 4 s
 *     backoff of R-011-2; `non_retryable` failures fail fast with no requeue;
 *   - a `pending` run left by a previous process is **never reissued**: it is
 *     marked `unknown charge` and the job fails for an operator decision
 *     (TECH_DESIGN §5.5 — the ≤1-billable guarantee that replaces provider
 *     idempotency, R-012-2/3).
 *
 * This module does not talk to Redis. `runProviderAttempt` is one attempt (one
 * BullMQ execution in production); `runAttemptSequence` is the deterministic
 * driver used by tests and by the local path. BullMQ's own `attempts: 3` uses
 * `attemptNo = job.attemptsMade + 1` and `workerFailureFromOutcome` to decide
 * retry vs. `UnrecoverableError` — see src/workers/queues.ts.
 */
import type { Pool } from 'pg';

import {
  findPendingRunsForJob,
  finishGenerationRun,
  markGenerationRunStarted,
  markGenerationRunUnknownCharge,
} from '../db/repositories/generation-runs.js';
import {
  findJobAttemptsByJob,
  finishJobAttempt,
  heartbeatAttempt,
  markAttemptRunning,
} from '../db/repositories/job-attempts.js';
import { markJobStatus } from '../db/repositories/jobs.js';
import type { JobAttemptRow } from '../db/repositories/types.js';
import {
  AdapterStageMismatchError,
  GenerationRunContractViolationError,
  GenerationRunNotCommittedError,
  GenerationRunNotPendingError,
  executePersisted,
  openAttempt,
  type PersistedGenerationRun,
  type ProviderAdapter,
  type ProviderStageCode,
} from '../domain/generation-run.js';

/** R-011-2: at most three *automatic* attempts per job. */
export const MAX_ATTEMPTS_PER_JOB = 3;

/**
 * The ledger's hard ceiling, not the retry policy. An operator pressing Regenerate
 * is a deliberate decision and is allowed past R-011-2's ladder (D-H, M-009); the
 * database permits any `attempt_no >= 1` since M-008. Capping the ledger at three
 * meant an operator retry threw `RangeError` before a single row was written — the
 * job died in two seconds with nothing to show why.
 */
export const MAX_LEDGER_ATTEMPT_NO = 999;

/**
 * R-011-2's ladder: 1 s, 4 s, 16 s. Indexed by `attemptNo - 1`, so an attempt
 * row always records the delay that belongs to its position — attempt 3 records
 * 16 even though there is no fourth attempt to schedule.
 */
export const BACKOFF_SECONDS = [1, 4, 16] as const;
export const BACKOFF_MS = [1_000, 4_000, 16_000] as const;

function assertAttemptNo(attemptNo: number): void {
  if (!Number.isInteger(attemptNo) || attemptNo < 1 || attemptNo > MAX_LEDGER_ATTEMPT_NO) {
    throw new RangeError(
      `attempt number must be a positive integer (leaving room for operator retries), got ${String(attemptNo)}`,
    );
  }
}

export function backoffSecondsForAttempt(attemptNo: number): number {
  assertAttemptNo(attemptNo);
  // Operator retries run past the ladder: they reuse its last rung rather than
  // reading past the end of the array and scheduling a NaN delay.
  return BACKOFF_SECONDS[Math.min(attemptNo, BACKOFF_SECONDS.length) - 1]!;
}

export function backoffMsForAttempt(attemptNo: number): number {
  assertAttemptNo(attemptNo);
  return BACKOFF_MS[Math.min(attemptNo, BACKOFF_MS.length) - 1]!;
}

/** The two classes `job_attempt.error_class` / `generation_run.error_class` admit. */
export type FailureClass = 'transient' | 'non_retryable';

export interface ClassifiedFailure {
  readonly errorClass: FailureClass;
  readonly httpStatus: number | null;
  /**
   * True when the request may have reached the provider and billed. A failure
   * with no evidence either way is treated as `true` — R-012-4 forbids claiming
   * "unbilled" on doubt.
   */
  readonly mayHaveBilled: boolean;
  readonly timedOut: boolean;
  readonly message: string;
}

/** The failures `executePersisted` itself raises: they are bugs, not provider weather. */
function isContractViolation(error: unknown): boolean {
  return (
    error instanceof GenerationRunContractViolationError ||
    error instanceof GenerationRunNotCommittedError ||
    error instanceof GenerationRunNotPendingError ||
    error instanceof AdapterStageMismatchError
  );
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'unknown provider failure';
}

function recordOf(error: unknown): Record<string, unknown> {
  return typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
}

/** Standard HTTP classification for errors that carry a status but no class. */
function classifyStatus(httpStatus: number | null): FailureClass {
  if (httpStatus === null) return 'transient';
  if (httpStatus === 429 || httpStatus >= 500) return 'transient';
  return 'non_retryable';
}

function doubtfulCharge(httpStatus: number | null, timedOut: boolean): boolean {
  if (timedOut) return true;
  if (httpStatus === null) return true; // a transport failure may have been processed
  return httpStatus >= 500; // 429 and other 4xx were rejected, not billed
}

/**
 * Read a failure class out of any adapter's error vocabulary.
 *
 * The four adapters were built independently and their error objects differ in
 * field names (`errorClass` in B-04/B-06/B-07, `failureClass` in B-05's
 * alternative module, `billedUnknown` vs `mayHaveBilled`) but agree on meaning.
 * Classification is therefore structural: the worker needs the values, not a
 * class identity — that keeps B-08 independent of four duplicate error modules
 * (flagged as an INT-01 hotspot, not re-decided here).
 */
export function classifyFailure(error: unknown): ClassifiedFailure {
  if (isContractViolation(error)) {
    return {
      errorClass: 'non_retryable',
      httpStatus: null,
      mayHaveBilled: false,
      timedOut: false,
      message: messageOf(error),
    };
  }

  const record = recordOf(error);
  const declared = record.failureClass ?? record.errorClass;
  const declaredClass = declared === 'transient' || declared === 'non_retryable' ? declared : null;
  const httpStatus = typeof record.httpStatus === 'number' ? record.httpStatus : null;
  const declaredBilled = record.billedUnknown ?? record.mayHaveBilled;
  const timedOut =
    record.code === 'timeout' ||
    record.name === 'ProviderTimeoutError' ||
    record.name === 'TtsTimeoutError' ||
    httpStatus === 408;
  const mayHaveBilled =
    typeof declaredBilled === 'boolean' ? declaredBilled : doubtfulCharge(httpStatus, timedOut);

  return {
    errorClass: declaredClass ?? classifyStatus(httpStatus),
    httpStatus,
    mayHaveBilled,
    timedOut,
    message: messageOf(error),
  };
}

export interface PlanRetryInput {
  readonly attemptNo: number;
  readonly failure: ClassifiedFailure;
}

export interface RetryPlan {
  readonly requeue: boolean;
  readonly delayMs: number;
  readonly nextAttemptNo: number | null;
}

/** R-011-2 as a pure function: transient and attempts remain → retry. */
export function planRetry(input: PlanRetryInput): RetryPlan {
  if (input.failure.errorClass !== 'transient') {
    return { requeue: false, delayMs: 0, nextAttemptNo: null };
  }
  if (input.attemptNo >= MAX_ATTEMPTS_PER_JOB) {
    return { requeue: false, delayMs: 0, nextAttemptNo: null };
  }
  return {
    requeue: true,
    delayMs: backoffMsForAttempt(input.attemptNo),
    nextAttemptNo: input.attemptNo + 1,
  };
}

export interface ProviderAttemptJob {
  readonly jobId: string;
  /** 1..3; in the BullMQ path this is `job.attemptsMade + 1`. */
  readonly attemptNo: number;
  readonly projectId: string;
  readonly stage: ProviderStageCode;
  readonly sceneId?: string | null;
  readonly provider?: string | null;
  readonly model?: string | null;
  /** sha256 of the exact request body — required (R-013-1). */
  readonly promptHash: string;
  readonly schemaVersion?: string | null;
  readonly seriesVersionId?: string | null;
  readonly workerId?: string | null;
}

/** The committed ledger rows a result hook may reference (R-012-1, R-013-1). */
export interface AttemptResultRef {
  readonly runId: string;
  readonly jobAttemptId: string;
  readonly jobId: string;
}

export interface AttemptDeps {
  readonly pool: Pool;
  /** The adapter for exactly this stage; `executePersisted` checks the match. */
  readonly adapter: ProviderAdapter<unknown>;
  /**
   * Called with the adapter's result after the call returns and **before** the
   * run is closed billed/succeeded. That is TECH_DESIGN §2's step (c): the asset
   * is stored between the provider call and the cost row's terminal update, so a
   * crash leaves a `pending` run for the <=1-billable rule (5.5) instead of a
   * `billed` row whose asset was never written.
   *
   * A throw here is an attempt failure like any other: the run closes
   * `failed`/`unknown` (the call did reach the provider) and nothing downstream
   * may treat the take as reusable. Optional: stages with no asset omit it.
   */
  readonly onResult?: (result: unknown, ref: AttemptResultRef) => Promise<void>;
}

export type AttemptCharge = 'billed' | 'unbilled' | 'unknown';

export interface AttemptOutcome {
  readonly attemptNo: number;
  /** Null only when a previous process's `pending` run blocked this attempt. */
  readonly runId: string | null;
  readonly status: 'succeeded' | 'failed';
  readonly charge: AttemptCharge;
  readonly failure: ClassifiedFailure | null;
  readonly retry: RetryPlan;
  /** The thrown value, for a BullMQ processor that must rethrow it. Never persisted. */
  readonly error: unknown;
}

const PENDING_RUN_MESSAGE =
  'a generation_run from a previous process is still pending: the provider call may have billed, ' +
  'so it was marked unknown charge and not reissued (R-012-3/R-012-4)';

/** How long a lease may be quiet before a `pending` run counts as abandoned. */
export const DEFAULT_LEASE_TTL_SECONDS = 60;

export interface PendingRunGuard {
  readonly reissueAllowed: boolean;
  readonly pendingRunIds: readonly string[];
  readonly attemptIds: readonly string[];
  /**
   * True when a pending run's attempt still has a live lease — another worker is
   * executing it right now, so this caller must not even close the row.
   */
  readonly inProgress: boolean;
}

export interface PendingRunGuardOptions {
  readonly leaseTtlSeconds?: number;
  readonly now?: Date;
  /**
   * Only a heartbeat/started stamp counts as a live lease. The reconciler sets
   * this: the job is already known-stalled, and a worker can die seconds after
   * committing a run, so a fresh `created_at` is not evidence of life.
   */
  readonly requireHeartbeat?: boolean;
}

function isLiveAttempt(attempt: JobAttemptRow, cutoff: Date, requireHeartbeat: boolean): boolean {
  const stamp = requireHeartbeat
    ? (attempt.heartbeat_at ?? attempt.started_at)
    : (attempt.heartbeat_at ?? attempt.started_at ?? attempt.created_at);
  return stamp !== null && stamp.getTime() > cutoff.getTime();
}

/**
 * The ≤1-billable rule (TECH_DESIGN §5.5) in two cases:
 *
 * - **Abandoned** (newest lease stamp older than the TTL): the call may have
 *   billed. Mark the run `unknown charge`, close its attempt, and refuse to call
 *   the provider again automatically — only an operator may start a new run
 *   (R-011-3).
 * - **Live** (a fresh heartbeat/creation stamp): another worker is executing
 *   this attempt right now. Refuse, but touch nothing: closing the winner's row
 *   would corrupt a call that is still in flight.
 *
 * Shared by `runProviderAttempt` (manual/queued retry) and the reconciler
 * (startup resume), so the rule has exactly one implementation.
 */
export async function refuseReissueOfPendingRuns(
  deps: { readonly pool: Pool },
  jobId: string,
  options: PendingRunGuardOptions = {},
): Promise<PendingRunGuard> {
  const pending = await findPendingRunsForJob(deps.pool, jobId);
  if (pending.length === 0) {
    return { reissueAllowed: true, pendingRunIds: [], attemptIds: [], inProgress: false };
  }

  const pendingRunIds = pending.map((run) => run.id);
  const attemptIds = [...new Set(pending.map((run) => run.job_attempt_id))];
  const cutoff = new Date(
    (options.now ?? new Date()).getTime() -
      (options.leaseTtlSeconds ?? DEFAULT_LEASE_TTL_SECONDS) * 1_000,
  );
  const attempts = await findJobAttemptsByJob(deps.pool, jobId);
  const live = attempts.some(
    (attempt) =>
      attemptIds.includes(attempt.id) &&
      isLiveAttempt(attempt, cutoff, options.requireHeartbeat ?? false),
  );
  if (live) {
    return { reissueAllowed: false, pendingRunIds, attemptIds, inProgress: true };
  }

  for (const run of pending) {
    await markGenerationRunUnknownCharge(deps.pool, run.id);
  }
  for (const attemptId of attemptIds) {
    await finishJobAttempt(deps.pool, attemptId, {
      status: 'unknown_charge',
      errorMessage: PENDING_RUN_MESSAGE,
    });
  }

  return { reissueAllowed: false, pendingRunIds, attemptIds, inProgress: false };
}

/**
 * Run exactly one attempt: commit the attempt row, make the call, record the
 * outcome, and decide whether a further attempt is allowed.
 *
 * Nothing sleeps here. The caller (BullMQ's delayed retry, or
 * `runAttemptSequence`) owns the wait, so the ledger records the plan and the
 * transport records the timing.
 */
export async function runProviderAttempt(
  deps: AttemptDeps,
  job: ProviderAttemptJob,
): Promise<AttemptOutcome> {
  assertAttemptNo(job.attemptNo);

  const guard = await refuseReissueOfPendingRuns(deps, job.jobId);
  if (!guard.reissueAllowed) {
    if (guard.inProgress) return inProgressAttemptOutcome(job);
    await markJobStatus(deps.pool, job.jobId, 'failed');
    const failure: ClassifiedFailure = {
      errorClass: 'non_retryable',
      httpStatus: null,
      mayHaveBilled: true,
      timedOut: false,
      message: PENDING_RUN_MESSAGE,
    };
    return {
      attemptNo: job.attemptNo,
      runId: null,
      status: 'failed',
      charge: 'unknown',
      failure,
      retry: { requeue: false, delayMs: 0, nextAttemptNo: null },
      error: new GenerationRunNotPendingError(guard.pendingRunIds[0] ?? job.jobId, 'pending'),
    };
  }

  // R-012-1: this COMMIT is the point of no return. The adapter cannot be
  // reached except through the branded run this call returns.
  const run: PersistedGenerationRun | null = await openAttempt(deps.pool, {
    jobId: job.jobId,
    attemptNo: job.attemptNo,
    projectId: job.projectId,
    stage: job.stage,
    sceneId: job.sceneId ?? null,
    provider: job.provider ?? deps.adapter.provider,
    model: job.model ?? null,
    promptHash: job.promptHash,
    schemaVersion: job.schemaVersion ?? null,
    seriesVersionId: job.seriesVersionId ?? null,
    workerId: job.workerId ?? null,
  }).catch((caught: unknown) => {
    if (isDuplicateAttemptError(caught)) return null;
    throw caught;
  });

  if (run === null) {
    // The unique (job_id, attempt_no) constraint is the concurrency guard: a
    // second worker that claimed the same attempt must not call the provider and
    // must not touch the winner's rows.
    return duplicateAttemptOutcome(job);
  }

  await markJobStatus(deps.pool, job.jobId, 'running');
  await markAttemptRunning(deps.pool, run.jobAttemptId, job.workerId ?? null);
  await markGenerationRunStarted(deps.pool, run.id);

  let error: unknown = null;
  try {
    const result = await executePersisted({ pool: deps.pool }, deps.adapter, run);
    if (deps.onResult !== undefined) {
      await deps.onResult(result, {
        runId: run.id,
        jobAttemptId: run.jobAttemptId,
        jobId: job.jobId,
      });
    }
  } catch (caught) {
    error = caught;
  }

  if (error === null) {
    await finishGenerationRun(deps.pool, run.id, {
      status: 'succeeded',
      chargeStatus: 'billed',
    });
    await finishJobAttempt(deps.pool, run.jobAttemptId, { status: 'succeeded' });
    await markJobStatus(deps.pool, job.jobId, 'succeeded');
    return {
      attemptNo: job.attemptNo,
      runId: run.id,
      status: 'succeeded',
      charge: 'billed',
      failure: null,
      retry: { requeue: false, delayMs: 0, nextAttemptNo: null },
      error: null,
    };
  }

  const failure = classifyFailure(error);
  const contractViolation = isContractViolation(error);
  const charge: AttemptCharge = contractViolation
    ? 'unbilled'
    : failure.mayHaveBilled
      ? 'unknown'
      : 'unbilled';

  if (!(error instanceof GenerationRunNotPendingError)) {
    await finishGenerationRun(deps.pool, run.id, {
      status: failure.timedOut ? 'timed_out' : 'failed',
      chargeStatus: charge,
      errorClass: failure.errorClass,
      httpStatus: failure.httpStatus,
      // A row that someone else already finished keeps its own outcome.
      onlyIfPending: contractViolation,
    });
  }

  const retry = planRetry({ attemptNo: job.attemptNo, failure });
  await finishJobAttempt(deps.pool, run.jobAttemptId, {
    status: charge === 'unknown' ? 'unknown_charge' : 'failed',
    errorClass: failure.errorClass,
    errorMessage: failure.message,
    httpStatus: failure.httpStatus,
    // backoff_s records the delay attached to this attempt's position — the
    // ledger invariant is exactly {1,4,16} for attempts 1,2,3 of a transient
    // series, including attempt 3, which schedules no fourth attempt. A
    // non_retryable failure plans no retry, so it records nothing.
    backoffS: failure.errorClass === 'transient' ? backoffSecondsForAttempt(job.attemptNo) : null,
  });
  await markJobStatus(deps.pool, job.jobId, retry.requeue ? 'queued' : 'failed');

  return {
    attemptNo: job.attemptNo,
    runId: run.id,
    status: 'failed',
    charge,
    failure,
    retry,
    error,
  };
}

export type SleepFn = (ms: number) => Promise<void>;

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export interface AttemptSequenceOptions {
  /** Injectable so tests assert the ladder without spending 5 s of wall clock. */
  readonly sleep?: SleepFn;
  readonly onAttempt?: (outcome: AttemptOutcome) => void;
  /** Defaults to R-011-2's three; tests may pin it. */
  readonly maxAttempts?: number;
}

export interface AttemptSequenceResult {
  readonly attempts: readonly AttemptOutcome[];
  readonly final: AttemptOutcome;
}

/**
 * Drive attempts 1..3 with the R-011-2 ladder. This is the deterministic
 * execution path: the same `runProviderAttempt` the BullMQ processor calls, with
 * the wait performed in-process instead of by Redis. A killed process loses the
 * sequence; that is precisely the case the reconciler handles.
 */
export async function runAttemptSequence(
  deps: AttemptDeps,
  job: Omit<ProviderAttemptJob, 'attemptNo'>,
  options: AttemptSequenceOptions = {},
): Promise<AttemptSequenceResult> {
  const sleep = options.sleep ?? realSleep;
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS_PER_JOB;
  const attempts: AttemptOutcome[] = [];

  for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo += 1) {
    const outcome = await runProviderAttempt(deps, { ...job, attemptNo });
    attempts.push(outcome);
    options.onAttempt?.(outcome);
    if (outcome.status === 'succeeded' || !outcome.retry.requeue) {
      return { attempts, final: outcome };
    }
    await sleep(outcome.retry.delayMs);
  }

  return { attempts, final: attempts[attempts.length - 1]! };
}

/**
 * Renew the lease for the attempt currently running (TECH_DESIGN §7.5).
 * The worker calls this at ≤ 5 s intervals; a stale heartbeat is what the
 * reconciler treats as a killed worker.
 */
export async function heartbeatAttemptLease(pool: Pool, attemptId: string): Promise<boolean> {
  return heartbeatAttempt(pool, attemptId);
}

/**
 * Postgres unique violation on `(job_id, attempt_no)` — two workers claimed the
 * same attempt. The loser must not issue a provider call (that would be the
 * double-bill this whole module exists to prevent) and must not touch the
 * winner's rows, so it is reported as a non-retryable outcome instead.
 */
function isDuplicateAttemptError(error: unknown): boolean {
  const record = recordOf(error);
  return (
    record.code === '23505' &&
    (record.constraint === 'job_attempt_job_attempt_no_key' ||
      (typeof record.detail === 'string' && record.detail.includes('(job_id, attempt_no)')))
  );
}

function duplicateAttemptOutcome(job: ProviderAttemptJob): AttemptOutcome {
  const message =
    `attempt ${job.attemptNo} for job ${job.jobId} already exists: another worker holds it, ` +
    'so no provider call was made';
  return {
    attemptNo: job.attemptNo,
    runId: null,
    status: 'failed',
    charge: 'unbilled',
    failure: {
      errorClass: 'non_retryable',
      httpStatus: null,
      mayHaveBilled: false,
      timedOut: false,
      message,
    },
    retry: { requeue: false, delayMs: 0, nextAttemptNo: null },
    error: new Error(message),
  };
}

/**
 * A pending run whose lease is still live: another worker is inside this
 * attempt. This caller made no call, so its charge is `unbilled` and it must not
 * retry — retrying would race the live worker and the ledger slot it holds.
 */
function inProgressAttemptOutcome(job: ProviderAttemptJob): AttemptOutcome {
  const message =
    `attempt ${job.attemptNo} for job ${job.jobId} is already running under a live lease: ` +
    'another worker owns it, so no provider call was made here';
  return {
    attemptNo: job.attemptNo,
    runId: null,
    status: 'failed',
    charge: 'unbilled',
    failure: {
      errorClass: 'non_retryable',
      httpStatus: null,
      mayHaveBilled: false,
      timedOut: false,
      message,
    },
    retry: { requeue: false, delayMs: 0, nextAttemptNo: null },
    error: new Error(message),
  };
}
