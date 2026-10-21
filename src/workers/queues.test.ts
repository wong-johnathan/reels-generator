/**
 * B-08 queue-topology tests (TECH_DESIGN §7.1).
 *
 * No Redis server exists on this host, so these tests assert the *topology and
 * policy* — the parts that would be wrong silently if a concurrency, queue
 * name, priority or retry budget drifted. `createAttemptQueues` is deliberately
 * not called: importing this module connects to nothing, which is itself the
 * property that lets the worker fail closed when Redis is down (R-018).
 */
import { UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';

import type { AttemptOutcome, ClassifiedFailure } from './attempt.js';
import {
  ATTEMPT_BACKOFF_TYPE,
  GateHasNoQueueError,
  JOB_PRIORITY,
  QUEUE_NAMES,
  QUEUE_TOPOLOGY,
  attemptBackoffStrategy,
  attemptJobId,
  attemptJobOptions,
  priorityForReason,
  queueForStage,
  workerConcurrency,
  workerFailureFromOutcome,
  workerQueueSettings,
} from './queues.js';

describe('BullMQ queue topology (TECH_DESIGN §7.1)', () => {
  it('is exactly content/render/export/misc', () => {
    expect(QUEUE_NAMES).toEqual(['content', 'render', 'export', 'misc']);
  });

  it('pins the four concurrencies: content 4, render 1, export 1, misc 2', () => {
    expect(workerConcurrency('content')).toBe(4);
    expect(workerConcurrency('render')).toBe(1);
    expect(workerConcurrency('export')).toBe(1);
    expect(workerConcurrency('misc')).toBe(2);
    expect(QUEUE_TOPOLOGY.content.stages).toEqual(['T', 'RS', 'SC', 'SB', 'IM', 'NA', 'TC']);
    expect(QUEUE_TOPOLOGY.render.stages).toEqual(['RE']);
    expect(QUEUE_TOPOLOGY.export.stages).toEqual(['EX']);
    expect(QUEUE_TOPOLOGY.misc.stages).toEqual(['QC']);
  });

  it('routes every stage to its queue and refuses the FA gate', () => {
    for (const stage of ['T', 'RS', 'SC', 'SB', 'IM', 'NA', 'TC'] as const) {
      expect(queueForStage(stage)).toBe('content');
    }
    expect(queueForStage('RE')).toBe('render');
    expect(queueForStage('EX')).toBe('export');
    expect(queueForStage('QC')).toBe('misc');
    expect(() => queueForStage('FA')).toThrow(GateHasNoQueueError);
  });

  it('orders priorities resume/manual retry < new work < reframe check', () => {
    expect(JOB_PRIORITY.resume).toBeLessThan(JOB_PRIORITY.new_work);
    expect(JOB_PRIORITY.manual_retry).toBeLessThan(JOB_PRIORITY.new_work);
    expect(JOB_PRIORITY.new_work).toBeLessThan(JOB_PRIORITY.reframe_check);
    expect(priorityForReason('resume')).toBe(JOB_PRIORITY.resume);
    expect(priorityForReason('reframe_check')).toBe(JOB_PRIORITY.reframe_check);
    // 0 means "no explicit priority" in BullMQ and is processed *before*
    // prioritized jobs, so no reason may ever map to it.
    expect(Math.min(...Object.values(JOB_PRIORITY))).toBeGreaterThan(0);
  });

  it('builds worker settings with the topology concurrency and the backoff hook', () => {
    const settings = workerQueueSettings('content');
    expect(settings.concurrency).toBe(4);
    expect(settings.settings.backoffStrategy).toBe(attemptBackoffStrategy);
  });
});

describe('R-011-2 retry policy in BullMQ terms', () => {
  it('maps attemptsMade 1/2 to 1 s / 4 s, clamping the rest', () => {
    expect(attemptBackoffStrategy(1, ATTEMPT_BACKOFF_TYPE)).toBe(1_000);
    expect(attemptBackoffStrategy(2, ATTEMPT_BACKOFF_TYPE)).toBe(4_000);
    expect(attemptBackoffStrategy(3, ATTEMPT_BACKOFF_TYPE)).toBe(16_000);
    expect(attemptBackoffStrategy(0, ATTEMPT_BACKOFF_TYPE)).toBe(1_000);
    expect(attemptBackoffStrategy(9, ATTEMPT_BACKOFF_TYPE)).toBe(16_000);
  });

  it('declines a foreign backoff type instead of applying our ladder to it', () => {
    expect(attemptBackoffStrategy(1, 'exponential')).toBe(-1);
    expect(attemptBackoffStrategy(1, undefined)).toBe(-1);
  });

  it('shrinks the BullMQ attempt budget to the remaining ledger attempts', () => {
    expect(attemptJobOptions(1).attempts).toBe(3);
    expect(attemptJobOptions(2).attempts).toBe(2);
    expect(attemptJobOptions(3).attempts).toBe(1);
    expect(attemptJobOptions(1).backoff).toEqual({ type: ATTEMPT_BACKOFF_TYPE });
    expect(() => attemptJobOptions(0)).toThrow(RangeError);
    expect(() => attemptJobOptions(4)).toThrow(RangeError);
  });

  it('uses deterministic, colon-free job ids so a re-enqueue dedupes', () => {
    const id = attemptJobId('7c9e6679-7425-40de-944b-e07fc1f90ae7', 2);
    expect(id).toBe('7c9e6679-7425-40de-944b-e07fc1f90ae7.a2');
    expect(id).not.toContain(':');
    expect(attemptJobId('job-1', 1)).toBe(attemptJobId('job-1', 1));
    expect(attemptJobId('job-1', 1)).not.toBe(attemptJobId('job-1', 2));
  });
});

function outcomeWith(overrides: {
  requeue: boolean;
  failure?: ClassifiedFailure | null;
  error?: unknown;
}): AttemptOutcome {
  return {
    attemptNo: 1,
    runId: 'run-1',
    status: overrides.failure ? 'failed' : 'succeeded',
    charge: overrides.failure?.mayHaveBilled ? 'unknown' : 'unbilled',
    failure: overrides.failure ?? null,
    retry: {
      requeue: overrides.requeue,
      delayMs: overrides.requeue ? 1_000 : 0,
      nextAttemptNo: null,
    },
    error: overrides.error ?? null,
  };
}

describe('workerFailureFromOutcome (R-011-2 no-requeue rule)', () => {
  it('turns a non_retryable failure into UnrecoverableError (no requeue)', () => {
    const failure: ClassifiedFailure = {
      errorClass: 'non_retryable',
      httpStatus: 401,
      mayHaveBilled: false,
      timedOut: false,
      message: 'fake provider returned HTTP 401',
    };
    const error = workerFailureFromOutcome(outcomeWith({ requeue: false, failure }));
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error.message).toContain('401');
  });

  it('rethrows the adapter error for a retryable failure so BullMQ delays the retry', () => {
    const failure: ClassifiedFailure = {
      errorClass: 'transient',
      httpStatus: 503,
      mayHaveBilled: true,
      timedOut: false,
      message: 'fake provider returned HTTP 503',
    };
    const original = new Error('fake provider returned HTTP 503');
    const error = workerFailureFromOutcome(
      outcomeWith({ requeue: true, failure, error: original }),
    );
    expect(error).toBe(original);
    expect(error).not.toBeInstanceOf(UnrecoverableError);
  });
});
