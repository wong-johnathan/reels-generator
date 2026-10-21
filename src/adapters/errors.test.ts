import { describe, expect, it } from 'vitest';

import {
  classifyHttpStatus,
  ProviderHttpError,
  ProviderNetworkError,
  ProviderResponseError,
  ProviderSchemaError,
  ProviderTimeoutError,
} from './errors.js';

/**
 * B-04 / R-011-2: the adapter classifies; it does not retry. The retry loop
 * (1 s / 4 s / 16 s, 3 attempts) is B-08's `src/workers/attempt.ts`.
 */
describe('provider error classification (R-008-1, R-011-2)', () => {
  it('classifies 429 and 5xx as transient and every other 4xx as non_retryable', () => {
    expect(classifyHttpStatus(429)).toBe('transient');
    for (const status of [500, 502, 503, 504]) expect(classifyHttpStatus(status)).toBe('transient');
    for (const status of [400, 401, 403, 404, 422]) {
      expect(classifyHttpStatus(status)).toBe('non_retryable');
    }
  });

  it('carries the provider request id and http status on an HTTP failure', () => {
    const error = new ProviderHttpError({
      provider: 'deepseek',
      httpStatus: 503,
      providerRequestId: 'req_abc123',
      detail: 'service unavailable',
    });
    expect(error.errorClass).toBe('transient');
    expect(error.code).toBe('http_error');
    expect(error.httpStatus).toBe(503);
    expect(error.providerRequestId).toBe('req_abc123');
    expect(error.mayHaveBilled).toBe(false);
    expect(error.message).toContain('deepseek');
  });

  it('treats a timeout as transient but flagged as possibly billed (R-012-4)', () => {
    const error = new ProviderTimeoutError('deepseek', 60_000);
    expect(error.errorClass).toBe('transient');
    expect(error.code).toBe('timeout');
    // The call may have reached the provider: the worker must record 'unknown'
    // charge and let the operator decide, never auto-reissue (TECH_DESIGN §5.5).
    expect(error.mayHaveBilled).toBe(true);
  });

  it('treats a network failure as transient and never claims a charge', () => {
    const error = new ProviderNetworkError('deepseek', new Error('ECONNREFUSED'));
    expect(error.errorClass).toBe('transient');
    expect(error.code).toBe('network');
    expect(error.mayHaveBilled).toBe(false);
  });

  it('makes a schema violation non_retryable at the provider layer: the call already billed', () => {
    const error = new ProviderSchemaError('deepseek', 'script.v1', ['narration: expected string']);
    expect(error.errorClass).toBe('non_retryable');
    expect(error.code).toBe('schema_invalid');
    expect(error.schemaVersion).toBe('script.v1');
    expect(error.fieldErrors).toEqual(['narration: expected string']);
    // R-004-2's 3-attempt ceiling re-generates as a *new* run, so an in-place
    // HTTP retry would double-bill. B-09 owns that loop.
    expect(error.message).toContain('script.v1');
  });

  it('makes a malformed provider envelope non_retryable for the same reason', () => {
    const error = new ProviderResponseError('deepseek', 'choices[0].message.content is not JSON');
    expect(error.errorClass).toBe('non_retryable');
    expect(error.code).toBe('response_invalid');
  });
});
