/**
 * Provider failure vocabulary for every adapter (R-011-2, R-012-4).
 *
 * Classification lives with the adapter because only the adapter knows what it
 * sent and what came back: a 429 was not processed (unbilled), a 5xx or a
 * timeout may have been (unknown charge). The retry/backoff policy itself is
 * the worker's job (B-08) — this module only states the facts.
 */

export type ProviderFailureClass = 'transient' | 'non_retryable';

export interface ProviderRequestErrorOptions {
  /** `transient` may be retried (429/5xx/network); anything else must not be. */
  readonly failureClass: ProviderFailureClass;
  /** The HTTP status, when the provider answered at all. */
  readonly httpStatus?: number;
  /**
   * True when the request may have reached the provider and billed despite the
   * failure (timeout, 5xx, unparseable 200). Never claim "unbilled" on doubt
   * (R-012-4).
   */
  readonly billedUnknown: boolean;
  /** From `Retry-After`, when present. */
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
}

export class ProviderRequestError extends Error {
  readonly failureClass: ProviderFailureClass;
  readonly httpStatus: number | undefined;
  readonly billedUnknown: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(message: string, options: ProviderRequestErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderRequestError';
    this.failureClass = options.failureClass;
    this.httpStatus = options.httpStatus;
    this.billedUnknown = options.billedUnknown;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/**
 * TECH_DESIGN §5.1: 429 and 5xx are transient; every other 4xx (and auth) is
 * non-retryable.
 */
export function classifyHttpStatus(status: number): ProviderFailureClass {
  if (status === 429) return 'transient';
  if (status >= 500) return 'transient';
  return 'non_retryable';
}

/**
 * `Retry-After` is either delta-seconds or an HTTP-date (RFC 9110 §10.2.3).
 * Returns milliseconds, or `undefined` when the header is absent or unusable.
 */
export function parseRetryAfter(
  header: string | null,
  nowMs: number = Date.now(),
): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (trimmed === '') return undefined;

  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10) * 1_000;

  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return undefined;
  return Math.max(0, dateMs - nowMs);
}
