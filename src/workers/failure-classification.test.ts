/**
 * B-08 unit tests: the retry vocabulary B-08 consumes from four independently
 * built adapters, plus R-011-2's ladder. No database, no network, no timers.
 */
import { describe, expect, it } from 'vitest';

import { TtsProviderError, TtsTimeoutError } from '../adapters/tts.js';
import { GenerationRunNotPendingError } from '../domain/generation-run.js';
import {
  BACKOFF_MS,
  BACKOFF_SECONDS,
  backoffMsForAttempt,
  backoffSecondsForAttempt,
  classifyFailure,
  planRetry,
} from './attempt.js';

/** B-04's alternative error module used `failureClass` / `billedUnknown`. */
class LegacyProviderRequestError extends Error {
  readonly failureClass = 'non_retryable' as const;
  readonly billedUnknown = false;
  readonly httpStatus = 401;
}

/** B-06's module used `errorClass` / `mayHaveBilled` / `code`. */
class ModuleSixProviderError extends Error {
  readonly errorClass = 'transient' as const;
  readonly mayHaveBilled = true;
  readonly code = 'timeout';
}

describe('classifyFailure', () => {
  it('reads B-07’s TtsProviderError: 401 is non_retryable and unbilled', () => {
    const failure = classifyFailure(
      new TtsProviderError('non_retryable', 'fake provider returned HTTP 401', { httpStatus: 401 }),
    );
    expect(failure.errorClass).toBe('non_retryable');
    expect(failure.httpStatus).toBe(401);
    expect(failure.mayHaveBilled).toBe(false);
    expect(failure.timedOut).toBe(false);
  });

  it('reads B-07’s TtsProviderError: 503 is transient and may have billed', () => {
    const failure = classifyFailure(
      new TtsProviderError('transient', 'fake provider returned HTTP 503', { httpStatus: 503 }),
    );
    expect(failure.errorClass).toBe('transient');
    expect(failure.mayHaveBilled).toBe(true);
  });

  it('treats a timeout as transient AND may-have-billed (R-012-4)', () => {
    const failure = classifyFailure(new TtsTimeoutError(120_000));
    expect(failure.errorClass).toBe('transient');
    expect(failure.mayHaveBilled).toBe(true);
    expect(failure.timedOut).toBe(true);
  });

  it('reads B-04’s failureClass/billedUnknown vocabulary', () => {
    const failure = classifyFailure(new LegacyProviderRequestError('unauthorized'));
    expect(failure.errorClass).toBe('non_retryable');
    expect(failure.httpStatus).toBe(401);
    expect(failure.mayHaveBilled).toBe(false);
  });

  it('reads B-06’s errorClass/mayHaveBilled/code vocabulary', () => {
    const failure = classifyFailure(new ModuleSixProviderError('timed out'));
    expect(failure.errorClass).toBe('transient');
    expect(failure.mayHaveBilled).toBe(true);
    expect(failure.timedOut).toBe(true);
  });

  it('classifies a bare Error as transient but doubtfully billed — never "unbilled" on doubt', () => {
    const failure = classifyFailure(new Error('socket hang up'));
    expect(failure.errorClass).toBe('transient');
    expect(failure.httpStatus).toBeNull();
    expect(failure.mayHaveBilled).toBe(true);
  });

  it('treats a generation_run contract violation as non_retryable, unbilled', () => {
    const failure = classifyFailure(new GenerationRunNotPendingError('run-1', 'succeeded'));
    expect(failure.errorClass).toBe('non_retryable');
    expect(failure.mayHaveBilled).toBe(false);
  });
});

describe('R-011-2 backoff ladder', () => {
  it('is 1 s / 4 s / 16 s per attempt position', () => {
    expect(BACKOFF_SECONDS).toEqual([1, 4, 16]);
    expect(BACKOFF_MS).toEqual([1_000, 4_000, 16_000]);
    expect(backoffSecondsForAttempt(1)).toBe(1);
    expect(backoffSecondsForAttempt(2)).toBe(4);
    expect(backoffSecondsForAttempt(3)).toBe(16);
    expect(backoffMsForAttempt(2)).toBe(4_000);
  });

  it('refuses a non-positive or fractional attempt number', () => {
    expect(() => backoffSecondsForAttempt(0)).toThrow(RangeError);
    expect(() => backoffSecondsForAttempt(1.5)).toThrow(RangeError);
  });

  it('reuses the last rung for an operator retry past the ladder', () => {
    // R-011-2 caps *automatic* attempts at three. An operator's Regenerate is a
    // deliberate decision and may open attempt 4 (D-H/M-009); reading one past the
    // array gave NaN, and refusing outright killed the job before it wrote a row.
    expect(backoffSecondsForAttempt(4)).toBe(16);
    expect(backoffMsForAttempt(5)).toBe(16_000);
  });

  it('retries transient failures with the matching delay, stopping after three', () => {
    const transient = classifyFailure(
      new TtsProviderError('transient', 'HTTP 503', { httpStatus: 503 }),
    );
    expect(planRetry({ attemptNo: 1, failure: transient })).toEqual({
      requeue: true,
      delayMs: 1_000,
      nextAttemptNo: 2,
    });
    expect(planRetry({ attemptNo: 2, failure: transient })).toEqual({
      requeue: true,
      delayMs: 4_000,
      nextAttemptNo: 3,
    });
    expect(planRetry({ attemptNo: 3, failure: transient })).toEqual({
      requeue: false,
      delayMs: 0,
      nextAttemptNo: null,
    });
  });

  it('never retries a non_retryable failure', () => {
    const fatal = classifyFailure(
      new TtsProviderError('non_retryable', 'HTTP 401', { httpStatus: 401 }),
    );
    expect(planRetry({ attemptNo: 1, failure: fatal }).requeue).toBe(false);
  });
});
