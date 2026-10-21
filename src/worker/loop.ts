/**
 * The worker job loop — the durable claim + dispatch spine.
 *
 * Claiming is concurrency-safe: `SELECT … FOR UPDATE SKIP LOCKED` inside a CTE,
 * then a single `UPDATE … RETURNING` that atomically moves the job to `running`
 * and returns it. Two workers can never claim the same job, and a worker that
 * dies mid-job leaves the row `running` for the reconciler to re-queue.
 *
 * The loop exits cleanly on SIGTERM *between* jobs: it finishes the job it is
 * executing, then observes the stop flag at the top of the next iteration and
 * returns — never killing a provider call mid-flight (stop_grace_period 30 s
 * gives the current stage time to finish).
 */
import type { Pool } from 'pg';

import type { StageCode } from '../shared/stages.js';
import { markJobStatus } from '../db/repositories/jobs.js';
import type { ClaimedJob, StageRunOutcome } from './orchestrator.js';

export interface ClaimedJobRow {
  readonly id: string;
  readonly project_id: string;
  readonly stage: string;
  readonly scene_id: string | null;
  readonly priority: number;
}

export type SleepFn = (ms: number) => Promise<void>;

const DEFAULT_POLL_INTERVAL_MS = 2_000;

/**
 * Atomically claim one queued job for the given stages. Returns null when the
 * queue is empty. The CTE + `FOR UPDATE SKIP LOCKED` is the concurrency guard.
 */
export async function claimNextJob(
  pool: Pool,
  stages: readonly StageCode[],
): Promise<ClaimedJob | null> {
  const result = await pool.query<ClaimedJobRow>(
    `WITH claimed AS (
       SELECT id FROM job
        WHERE status = 'queued' AND stage = ANY($1::text[])
        ORDER BY priority DESC, created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     UPDATE job SET status = 'running', updated_at = now()
      WHERE id IN (SELECT id FROM claimed)
      RETURNING id, project_id, stage, scene_id, priority`,
    [[...stages]],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    stage: row.stage as StageCode,
    sceneId: row.scene_id,
    priority: row.priority,
  };
}

export interface WorkerLoopOptions {
  readonly pool: Pool;
  readonly stages: readonly StageCode[];
  /** The dispatch + advance pair, injected so the loop stays transport-free. */
  readonly runStage: (job: ClaimedJob) => Promise<StageRunOutcome>;
  readonly advanceAfterStage: (job: ClaimedJob) => Promise<unknown>;
  readonly pollIntervalMs?: number;
  readonly logger?: (message: string) => void;
  /** Polled between jobs; SIGTERM flips this so the loop exits after the current job. */
  readonly shouldStop?: () => boolean;
  readonly sleep?: SleepFn;
  /** Test hook: stop after N jobs (null jobs are not counted). */
  readonly maxJobs?: number;
}

const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run until `shouldStop()` reports true. Each iteration claims one job,
 * dispatches it, marks the job's terminal status and advances the pipeline.
 */
export async function runWorkerLoop(options: WorkerLoopOptions): Promise<number> {
  const log = options.logger ?? ((): void => {});
  const sleep = options.sleep ?? defaultSleep;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let processed = 0;

  while (!(options.shouldStop?.() ?? false)) {
    const job = await claimNextJob(options.pool, options.stages);
    if (job === null) {
      await sleep(pollIntervalMs);
      continue;
    }

    processed += 1;
    try {
      const outcome = await options.runStage(job);
      if (outcome.status === 'succeeded') {
        await markJobStatus(options.pool, job.id, 'succeeded');
        await options.advanceAfterStage(job);
      } else if (outcome.status === 'failed') {
        await markJobStatus(options.pool, job.id, 'failed');
        log(
          `stage ${job.stage} job ${job.id} failed${outcome.message ? `: ${outcome.message}` : ''}`,
        );
      }
      // retryable: the job stays `running`; the retry backoff (B-08) re-claims it.
    } catch (error) {
      await markJobStatus(options.pool, job.id, 'failed');
      log(
        `stage ${job.stage} job ${job.id} crashed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (options.maxJobs !== undefined && processed >= options.maxJobs) break;
  }

  return processed;
}
