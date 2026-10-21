/**
 * Queue topology — BullMQ over Redis, Postgres as the source of truth
 * (TECH_DESIGN §7.1, X-3; US-013, US-031).
 *
 * | queue   | consumed by     | concurrency | stages                                |
 * |---------|-----------------|-------------|---------------------------------------|
 * | content | content-worker  | 4           | T, RS, SC, SB, IM (per scene), NA, TC |
 * | render  | render-worker   | 1           | RE                                    |
 * | export  | render-worker   | 1           | EX                                    |
 * | misc    | render-worker   | 2           | QC, reframe check, derivative         |
 *
 * The render queue is a **one-slot semaphore** (R-104 default 1): the DS923+
 * has no GPU and one FFmpeg render must not starve `web`.
 *
 * Retries: BullMQ owns the delay, this codebase owns the policy. Every job is
 * added with `attempts: MAX_ATTEMPTS_PER_JOB - firstAttemptNo + 1` and the
 * custom backoff below, so BullMQ's attempt counter lines up exactly with the
 * `job_attempt.attempt_no` ledger: 1 s after attempt 1, 4 s after attempt 2, and
 * no fourth attempt. A `non_retryable` failure is rethrown as BullMQ's
 * `UnrecoverableError`, which fails the job immediately with no requeue
 * (R-011-2). See `workerFailureFromOutcome`.
 *
 * Job ids are deterministic — `<job uuid>.a<attemptNo>` — so a reconciler
 * re-enqueue of the same attempt is deduplicated by BullMQ while the first copy
 * is still waiting. Dots, never colons: BullMQ forbids `:` in custom job ids.
 */
import { Queue, UnrecoverableError, type JobsOptions } from 'bullmq';

import type { StageCode } from '../shared/index.js';
import { MAX_ATTEMPTS_PER_JOB, type AttemptOutcome } from './attempt.js';

export const QUEUE_NAMES = ['content', 'render', 'export', 'misc'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

export interface QueueTopologyEntry {
  readonly name: QueueName;
  readonly concurrency: number;
  readonly stages: readonly StageCode[];
  readonly contents: string;
}

export const QUEUE_TOPOLOGY: Readonly<Record<QueueName, QueueTopologyEntry>> = {
  content: {
    name: 'content',
    concurrency: 4,
    stages: ['T', 'RS', 'SC', 'SB', 'IM', 'NA', 'TC'],
    contents: 'provider stages and local word timing; the rate limiter is the real governor',
  },
  render: {
    name: 'render',
    concurrency: 1,
    stages: ['RE'],
    contents: 'one render slot — the NAS has no GPU (R-104 default)',
  },
  export: {
    name: 'export',
    concurrency: 1,
    stages: ['EX'],
    contents: 'per-video package and batch ZIP',
  },
  misc: {
    name: 'misc',
    concurrency: 2,
    stages: ['QC'],
    contents: 'QC, reframe check, derivative generation',
  },
};

/** `FA` is an operator gate, not a queued unit of work (TECH_DESIGN §4.8). */
export class GateHasNoQueueError extends Error {
  constructor(stage: StageCode) {
    super(
      `stage ${stage} is an operator gate and is never enqueued (TECH_DESIGN §4.8): ` +
        'gate preconditions are encoded in the enqueue guard, not in a job',
    );
    this.name = 'GateHasNoQueueError';
  }
}

export function queueForStage(stage: StageCode): QueueName {
  if (stage === 'FA') throw new GateHasNoQueueError(stage);
  if (stage === 'RE') return 'render';
  if (stage === 'EX') return 'export';
  if (stage === 'QC') return 'misc';
  return 'content';
}

export function workerConcurrency(queue: QueueName): number {
  return QUEUE_TOPOLOGY[queue].concurrency;
}

/**
 * Priorities, lower number first (BullMQ). `0` means "no explicit priority" and
 * BullMQ processes unprioritized jobs **before** prioritized ones, so every job
 * we add carries one of these values — never 0.
 */
export const JOB_PRIORITY = {
  resume: 1,
  manual_retry: 1,
  new_work: 2,
  reframe_check: 3,
} as const;

export type JobReason = 'new_work' | 'resume' | 'manual_retry' | 'reframe_check';

export function priorityForReason(reason: JobReason): number {
  return JOB_PRIORITY[reason];
}

/** The custom backoff type; registered on the Worker (bullmq `settings`). */
export const ATTEMPT_BACKOFF_TYPE = 'reels-transient-backoff';

/**
 * BullMQ's custom backoff hook. `attemptsMade` is the number of the attempt that
 * just failed (1 for the first), which is exactly `job_attempt.attempt_no`.
 * Returning -1 tells BullMQ "do not retry", which is correct for an unknown
 * backoff type: silently applying our ladder to someone else's policy would
 * hide a configuration mistake.
 */
export function attemptBackoffStrategy(attemptsMade: number, type?: string): number {
  if (type !== ATTEMPT_BACKOFF_TYPE) return -1;
  const attemptNo = Math.min(Math.max(Math.trunc(attemptsMade), 1), MAX_ATTEMPTS_PER_JOB);
  return [1_000, 4_000, 16_000][attemptNo - 1]!;
}

/** Deterministic id: a re-enqueue of the same attempt dedupes in Redis. */
export function attemptJobId(jobId: string, attemptNo: number): string {
  return `${jobId}.a${attemptNo}`;
}

export interface AttemptJobOptions extends JobsOptions {
  readonly attempts: number;
  readonly backoff: { readonly type: string };
}

/**
 * Retry budget for a job whose first execution is `firstAttemptNo`. Starting at
 * attempt 2 leaves two BullMQ attempts, not three: the ledger ceiling is three
 * total calls, not three per requeue.
 */
export function attemptJobOptions(firstAttemptNo: number): AttemptJobOptions {
  if (
    !Number.isInteger(firstAttemptNo) ||
    firstAttemptNo < 1 ||
    firstAttemptNo > MAX_ATTEMPTS_PER_JOB
  ) {
    throw new RangeError(`first attempt must be 1..${MAX_ATTEMPTS_PER_JOB}, got ${firstAttemptNo}`);
  }
  return {
    attempts: MAX_ATTEMPTS_PER_JOB - firstAttemptNo + 1,
    backoff: { type: ATTEMPT_BACKOFF_TYPE },
    // Keep history for debugging; the ledger of record is Postgres, not Redis.
    removeOnComplete: { count: 1_000 },
    removeOnFail: { count: 5_000 },
  };
}

export interface QueueJobData {
  readonly jobId: string;
  readonly projectId: string;
  readonly stage: StageCode;
  /**
   * The attempt number of this BullMQ job's *first* execution. The processor
   * adds `job.attemptsMade` to get the attempt it is running now.
   */
  readonly attemptNo: number;
  readonly reason: JobReason;
}

export interface EnqueueRequest {
  readonly jobId: string;
  readonly projectId: string;
  readonly stage: StageCode;
  readonly attemptNo: number;
  readonly reason: JobReason;
  readonly priority?: number;
}

/** The port the reconciler needs. `createQueueEnqueuer` is the BullMQ binding. */
export interface EnqueuePort {
  enqueue(request: EnqueueRequest): Promise<void>;
}

export type AttemptQueues = Readonly<Record<QueueName, Queue<QueueJobData>>>;

export interface AttemptQueueSet {
  readonly queues: AttemptQueues;
  close(): Promise<void>;
}

/**
 * Build the four queues. This is the only place a Redis connection is created;
 * importing this module connects to nothing, so tests can assert the topology
 * without a Redis server.
 */
export function createAttemptQueues(options: {
  readonly url: string;
  readonly prefix?: string;
}): AttemptQueueSet {
  const queues = {} as Record<QueueName, Queue<QueueJobData>>;
  for (const name of QUEUE_NAMES) {
    queues[name] = new Queue<QueueJobData>(name, {
      connection: { url: options.url },
      prefix: options.prefix ?? 'reels',
    });
  }
  return {
    queues,
    close: async () => {
      await Promise.all(QUEUE_NAMES.map((name) => queues[name].close()));
    },
  };
}

/** Add (or dedupe) the stage job for one attempt. */
export async function enqueueStageAttempt(
  queues: AttemptQueues,
  request: EnqueueRequest,
): Promise<void> {
  const queueName = queueForStage(request.stage);
  const data: QueueJobData = {
    jobId: request.jobId,
    projectId: request.projectId,
    stage: request.stage,
    attemptNo: request.attemptNo,
    reason: request.reason,
  };
  await queues[queueName].add('stage-attempt', data, {
    ...attemptJobOptions(request.attemptNo),
    jobId: attemptJobId(request.jobId, request.attemptNo),
    priority: request.priority ?? priorityForReason(request.reason),
  });
}

export function createQueueEnqueuer(queues: AttemptQueues): EnqueuePort {
  return {
    enqueue: (request) => enqueueStageAttempt(queues, request),
  };
}

/** Worker options for a queue: its concurrency plus the backoff strategy hook. */
export function workerQueueSettings(queue: QueueName): {
  concurrency: number;
  settings: { backoffStrategy: typeof attemptBackoffStrategy };
} {
  return {
    concurrency: workerConcurrency(queue),
    settings: { backoffStrategy: attemptBackoffStrategy },
  };
}

/**
 * What the BullMQ processor should throw after one attempt.
 *
 * A retryable failure rethrows the adapter's own error, so BullMQ schedules the
 * delayed retry using `attemptBackoffStrategy`. A non-retryable failure (401,
 * other 4xx, or the unknown-charge guard) becomes `UnrecoverableError`: BullMQ
 * marks the job failed immediately and never requeues it (R-011-2).
 */
export function workerFailureFromOutcome(outcome: AttemptOutcome): Error {
  const failure = outcome.failure;
  if (failure === null) {
    throw new Error('cannot derive a worker failure from a successful attempt');
  }
  if (!outcome.retry.requeue) {
    return new UnrecoverableError(failure.message);
  }
  return outcome.error instanceof Error ? outcome.error : new Error(failure.message);
}
