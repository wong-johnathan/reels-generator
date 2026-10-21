/**
 * The structural attempt-row guard — TECH_DESIGN §3.5, R-012-1.
 *
 * The rule: a `generation_run` row exists **and is committed** before any
 * provider HTTP call is issued. It is enforced structurally, not by convention:
 *
 * 1. `openAttempt()` writes `job_attempt` + `generation_run` in one transaction
 *    and commits before returning.
 * 2. The only thing an adapter can execute against is a `PersistedGenerationRun`
 *    — a branded type with a module-private symbol, so a plain row literal or a
 *    `GenerationRun`-shaped object cannot be passed to `execute()` without an
 *    explicit, reviewable cast.
 * 3. `executePersisted()` re-reads the row from a **fresh session** (a backend
 *    pid that was never part of the writing transaction) immediately before
 *    calling `adapter.execute`. Same-session visibility would not prove commit;
 *    a fresh session does.
 *
 * Because every provider client is constructed inside an adapter and the only
 * adapter entry point is `execute(run)`, there is no path that reaches a
 * provider socket without a committed row.
 */
import type { Pool } from 'pg';

import { withFreshSession, withTransaction } from '../db/client.js';
import { insertPendingAttempt } from '../db/repositories/job-attempts.js';
import { insertPendingRun } from '../db/repositories/generation-runs.js';
import type { GenerationRunRow } from '../db/repositories/types.js';

/**
 * The six stages that are provider calls. Render/QC/export never appear in
 * `generation_run` (X-7); the column CHECK says the same thing in SQL.
 */
export const PROVIDER_STAGE_CODES = ['T', 'RS', 'SC', 'SB', 'IM', 'NA'] as const;
export type ProviderStageCode = (typeof PROVIDER_STAGE_CODES)[number];

export function isProviderStageCode(value: string): value is ProviderStageCode {
  return (PROVIDER_STAGE_CODES as readonly string[]).includes(value);
}

/** A `generation_run` primary key. */
export type GenerationRunId = string & { readonly __brand: 'GenerationRunId' };

/**
 * Module-private brand. It is not exported, so the only way to obtain a value
 * of this type is `openAttempt()` (or a cast the reviewer can see).
 */
const COMMITTED = Symbol('reels-generator.generation-run.committed');

/** A `generation_run` row that is committed and safe to hand to an adapter. */
export interface PersistedGenerationRun {
  readonly [COMMITTED]: true;
  readonly id: GenerationRunId;
  readonly jobAttemptId: string;
  readonly projectId: string;
  readonly stage: ProviderStageCode;
  readonly sceneId: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly promptHash: string;
  readonly attemptNo: number | null;
  readonly seriesVersionId: string | null;
  /** Always `pending` at creation: the row records a call that has not happened yet. */
  readonly status: 'pending';
  /** Always `pending`: charge is only known after the call returns (R-012-4). */
  readonly chargeStatus: 'pending';
  /** `false` for every current provider (TECH_DESIGN §5.5, R-012-2). */
  readonly idempotencyProtected: boolean;
  readonly committedAt: Date;
  /** The backend pid that committed the row; the verifier must be a different one. */
  readonly committedByBackendPid: number;
}

/** The single entry point every provider adapter exposes (TECH_DESIGN §3.5). */
export interface ProviderAdapter<Result = unknown> {
  readonly provider: string;
  readonly stage: ProviderStageCode;
  execute(run: PersistedGenerationRun): Promise<Result>;
}

export interface ExecuteDeps {
  readonly pool: Pool;
}

export class GenerationRunContractViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GenerationRunContractViolationError';
  }
}

export class GenerationRunNotCommittedError extends Error {
  constructor(
    readonly runId: string,
    readonly detail: string,
  ) {
    super(
      `generation_run ${runId} is not committed and must not reach a provider: ${detail} (R-012-1)`,
    );
    this.name = 'GenerationRunNotCommittedError';
  }
}

export class GenerationRunNotPendingError extends Error {
  constructor(
    readonly runId: string,
    readonly status: string,
  ) {
    super(
      `generation_run ${runId} is '${status}', not 'pending': re-running it would duplicate a ` +
        'provider call. A reissued call is a new run row (R-012-3, R-012-4).',
    );
    this.name = 'GenerationRunNotPendingError';
  }
}

export class AdapterStageMismatchError extends Error {
  constructor(
    readonly adapterStage: string,
    readonly runStage: string,
    readonly runId: string,
  ) {
    super(
      `adapter for stage ${adapterStage} cannot execute generation_run ${runId} of stage ${runStage}`,
    );
    this.name = 'AdapterStageMismatchError';
  }
}

export interface OpenAttemptInput {
  readonly jobId: string;
  /**
   * 1..3 (R-011-2). Deliberately not range-checked here: the
   * `job_attempt_attempt_no_check` constraint is the enforcement point, and
   * letting it fire proves the whole attempt rolls back with its run row.
   */
  readonly attemptNo: number;
  readonly projectId: string;
  readonly stage: ProviderStageCode;
  readonly sceneId?: string | null;
  readonly provider?: string | null;
  readonly model?: string | null;
  /** sha256 of the exact prompt/request body — required, it is the dedupe/debug key. */
  readonly promptHash: string;
  readonly schemaVersion?: string | null;
  readonly idempotencyKey?: string | null;
  readonly seriesVersionId?: string | null;
  readonly workerId?: string | null;
}

function toPersistedRun(
  row: GenerationRunRow,
  committedByBackendPid: number,
): PersistedGenerationRun {
  if (row.status !== 'pending' || row.charge_status !== 'pending') {
    // The INSERT hard-codes both to 'pending'; anything else is a schema drift.
    throw new GenerationRunContractViolationError(
      `generation_run ${row.id} was inserted as ${row.status}/${row.charge_status}, expected pending/pending`,
    );
  }
  if (!isProviderStageCode(row.stage)) {
    throw new GenerationRunContractViolationError(
      `generation_run ${row.id} has non-provider stage ${row.stage} (X-7)`,
    );
  }

  return {
    [COMMITTED]: true,
    id: row.id as GenerationRunId,
    jobAttemptId: row.job_attempt_id,
    projectId: row.project_id,
    stage: row.stage,
    sceneId: row.scene_id,
    provider: row.provider,
    model: row.model,
    promptHash: row.prompt_hash,
    attemptNo: row.attempt_no,
    seriesVersionId: row.series_version_id,
    status: 'pending',
    chargeStatus: 'pending',
    idempotencyProtected: row.idempotency_protected,
    committedAt: row.created_at,
    committedByBackendPid,
  };
}

/**
 * Insert `job_attempt` + `generation_run` in one transaction and commit.
 *
 * Returns only after the COMMIT, so the returned id is durable and visible to
 * other sessions. Throws (and rolls back both rows) if either INSERT fails.
 */
export async function openAttempt(
  pool: Pool,
  input: OpenAttemptInput,
): Promise<PersistedGenerationRun> {
  if (!isProviderStageCode(input.stage)) {
    throw new GenerationRunContractViolationError(
      `stage ${input.stage} is not a provider stage: render/QC/export never write generation_run (X-7)`,
    );
  }
  if (input.promptHash.trim() === '') {
    throw new GenerationRunContractViolationError(
      'prompt_hash is required: it is the R-013-1 provenance key of the call being made',
    );
  }

  return withTransaction(pool, async (client) => {
    const pid = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const backendPid = pid.rows[0]?.pid;
    if (backendPid === undefined) throw new Error('postgres did not report a backend pid');

    const attempt = await insertPendingAttempt(client, {
      jobId: input.jobId,
      attemptNo: input.attemptNo,
      workerId: input.workerId ?? null,
    });
    const row = await insertPendingRun(client, {
      jobAttemptId: attempt.id,
      projectId: input.projectId,
      stage: input.stage,
      sceneId: input.sceneId ?? null,
      provider: input.provider ?? null,
      model: input.model ?? null,
      promptHash: input.promptHash,
      schemaVersion: input.schemaVersion ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      attemptNo: input.attemptNo,
      seriesVersionId: input.seriesVersionId ?? null,
    });

    return toPersistedRun(row, backendPid);
  });
}

/**
 * Prove the run is committed and still `pending`, reading it from a session
 * that never participated in the writing transaction.
 */
export async function assertRunCommittedAndPending(
  pool: Pool,
  run: PersistedGenerationRun,
): Promise<{ readonly verifiedOnBackendPid: number }> {
  return withFreshSession(pool, async (client) => {
    const pid = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const verifiedOnBackendPid = pid.rows[0]?.pid;
    if (verifiedOnBackendPid === undefined) {
      throw new Error('postgres did not report a backend pid');
    }
    if (verifiedOnBackendPid === run.committedByBackendPid) {
      throw new GenerationRunNotCommittedError(
        run.id,
        'the verifying session is the session that wrote the row',
      );
    }

    const result = await client.query<{ status: string }>(
      'SELECT status FROM generation_run WHERE id = $1',
      [run.id],
    );
    if ((result.rowCount ?? 0) !== 1) {
      throw new GenerationRunNotCommittedError(run.id, 'no committed row is visible');
    }
    const status = result.rows[0]!.status;
    if (status !== 'pending') throw new GenerationRunNotPendingError(run.id, status);

    return { verifiedOnBackendPid };
  });
}

/**
 * The only sanctioned way to run a provider adapter: verify the committed run,
 * then hand it over. The adapter receives the branded run object, never a raw
 * row or a bare id.
 */
export async function executePersisted<Result>(
  deps: ExecuteDeps,
  adapter: ProviderAdapter<Result>,
  run: PersistedGenerationRun,
): Promise<Result> {
  if (adapter.stage !== run.stage) {
    throw new AdapterStageMismatchError(adapter.stage, run.stage, run.id);
  }
  await assertRunCommittedAndPending(deps.pool, run);
  return adapter.execute(run);
}
